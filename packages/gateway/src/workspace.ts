import { AsyncLocalStorage } from "node:async_hooks";
import { UnauthenticatedError, ForbiddenError, type Principal } from "@embody/core";
import { hasPermission } from "@embody/cloud-contracts";
import { AuthChain, createGateway, type GatewayOptions, type RegisteredApp } from "./index.js";
import { credentialHash, type GatewayStore, type WorkspaceCredential } from "./store.js";

interface RequestContext {
  credential: WorkspaceCredential;
  principal: Principal;
  apps: readonly RegisteredApp[];
}
export interface WorkspaceGatewayOptions extends Omit<
  GatewayOptions,
  "registry" | "auth" | "routePrefix" | "registrationRoutes" | "sessionIdentity"
> {
  readonly store: GatewayStore;
  readonly clock?: { now(): Date };
}
/** No positive cache: every new request authenticates and reads the authoritative catalog.
 * ALS snapshots are private to the request, not mutable shared per-workspace registry state.
 */
export function createWorkspaceGateway(options: WorkspaceGatewayOptions) {
  const context = new AsyncLocalStorage<RequestContext>();
  const current = () => {
    const value = context.getStore();
    if (!value) throw new UnauthenticatedError();
    return value;
  };
  const gateway = createGateway({
    ...options,
    environment: "production",
    catalogMaxAgeSeconds: 0,
    discoverUnavailable: true,
    routePrefix: "/w/:workspace",
    registrationRoutes: false,
    registry: {
      snapshot: () => current().apps,
      get: (appId) => current().apps.find((app) => app.appId === appId),
      register: () => {
        throw new ForbiddenError("Hosted registration is control-plane only");
      },
      heartbeat: () => {
        throw new ForbiddenError("Hosted catalogs do not use heartbeats");
      },
    },
    auth: new AuthChain([
      { id: "workspace-store", authenticate: () => Promise.resolve(current().principal) },
    ]),
    sessionIdentity: () => {
      const { credential } = current();
      return `${credential.workspaceId}:${credential.id}:${credential.revision}`;
    },
  });
  gateway.get("/health", () => ({ live: true }));
  gateway.addHook("onRequest", (request, reply, done) => {
    if (request.routeOptions.url === "/health" && request.method === "GET") {
      done();
      return;
    }
    reply.header("cache-control", "no-store");
    const authenticate = async (): Promise<RequestContext> => {
      const workspaceId = (request.params as { workspace?: string }).workspace;
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1];
      if (!workspaceId || !/^ws_[a-z0-9]{8,64}$/.test(workspaceId) || !token || token.length > 4096)
        throw new UnauthenticatedError();
      const credential = await options.store.credential(workspaceId, credentialHash(token));
      const now = (options.clock?.now() ?? new Date()).getTime();
      if (
        !credential ||
        credential.revoked ||
        !Number.isFinite(Date.parse(credential.expiresAt)) ||
        Date.parse(credential.expiresAt) <= now ||
        credential.principal.orgId !== workspaceId
      )
        throw new UnauthenticatedError();
      const snapshot = await options.store.snapshot(workspaceId);
      if (!snapshot) throw new UnauthenticatedError();
      const apps = snapshot.apps
        .filter(
          (app) =>
            app.state !== "deleted" &&
            credential.grants.some((grant) => hasPermission(grant, app, "app:call")),
        )
        .map((app) => ({
          ...app.registration,
          workspaceId,
          catalogAppId: app.appId,
          revision: app.revision,
          promotionGeneration: app.generation,
          activeRelease: app.activeRelease,
          state: app.state,
          generation: String(app.generation),
          status:
            app.state === "idle" || app.state === "ready"
              ? ("healthy" as const)
              : ("unhealthy" as const),
        }));
      return { credential, principal: credential.principal, apps };
    };
    void authenticate().then(
      (value) => context.run(value, done),
      (error) => done(error as Error),
    );
  });
  return gateway;
}
