import type { FastifyInstance } from "fastify";
import { platformInvokerVerifier, type PlatformInvokerVerifier } from "@embody/auth";
import { authenticateTask } from "@embody/host";
import type { DeploymentStore } from "./deployment.js";
import type { ManagementStore } from "./management.js";

/**
 * M13 stable wake route for hosted durable apps (review B1 of `a561eaf`). A durable app's queue
 * tasks (step, lease, event and retention wakes) are addressed to one URL per app that never
 * changes: `<worker>/_embody/wake/<workspace>/<app>`, which is also their OIDC audience. The
 * deployment worker authenticates the app's own wake invoker, looks up the app's *active*
 * release in the catalog and forwards the task body to that release's `/_embody/drain` with a
 * token minted as the same invoker for the same audience (candidates accept it as a Cloud Run
 * custom audience). So work scheduled by any release, for any time up to the queue's horizon,
 * reaches the code that serves the app when it is due, and replaced candidates can be removed
 * after their drain without stranding anything. Nothing here runs unless a task arrives.
 */
export interface WakeRouteOptions {
  /** The worker's own origin, e.g. `https://worker-123.us-central1.run.app`. */
  readonly baseUrl: string;
  /** The app's wake invoker: the only identity whose tasks this route accepts for that app. */
  invokerFor(workspaceId: string, appId: string): string;
  /** Mints an ID token as `invokerEmail` for `audience` (IAM credentials `generateIdToken`). */
  mint(invokerEmail: string, audience: string, signal: AbortSignal): Promise<string>;
  readonly store: Pick<DeploymentStore, "appStatus" | "release"> &
    Partial<Pick<ManagementStore, "stopped">>;
  /** Test seam; production verifies Google-signed tokens. */
  readonly verifier?: (audience: string, invokerEmail: string) => PlatformInvokerVerifier;
  readonly fetch?: typeof fetch;
}
export const WAKE_ROUTE = "/_embody/wake/:workspace/:app";
/** Largest wake body accepted (host task bodies are a few hundred bytes). */
export const MAX_WAKE_BYTES = 4096;
const WORKSPACE = /^ws_[a-z0-9]{8,64}$/;
const APP = /^app_[a-z0-9]{8,64}$/;

/** The stable wake URL (and OIDC audience) of one app. */
export function wakeUrl(baseUrl: string, workspaceId: string, appId: string): string {
  return `${new URL(baseUrl).origin}/_embody/wake/${workspaceId}/${appId}`;
}

export function registerWakeRoute(app: FastifyInstance, options: WakeRouteOptions): void {
  const fetcher = options.fetch ?? fetch;
  const verifiers = new Map<string, PlatformInvokerVerifier>();
  const verifierFor = (audience: string, invokerEmail: string) => {
    const key = `${audience} ${invokerEmail}`;
    let verifier = verifiers.get(key);
    if (!verifier) {
      verifier = options.verifier
        ? options.verifier(audience, invokerEmail)
        : platformInvokerVerifier({ audience, invokerEmail });
      if (verifiers.size >= 1000) verifiers.delete(verifiers.keys().next().value!);
      verifiers.set(key, verifier);
    }
    return verifier;
  };
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url !== WAKE_ROUTE) return;
    const { workspace, app: appId } = request.params as { workspace: string; app: string };
    try {
      if (!WORKSPACE.test(workspace) || !APP.test(appId)) throw new Error("invalid");
      await authenticateTask(
        request.headers,
        verifierFor(
          wakeUrl(options.baseUrl, workspace, appId),
          options.invokerFor(workspace, appId),
        ),
      );
    } catch {
      await reply.status(401).send({ error: "unauthenticated" });
    }
  });
  app.post(WAKE_ROUTE, { bodyLimit: MAX_WAKE_BYTES }, async (request, reply) => {
    const { workspace, app: appId } = request.params as { workspace: string; app: string };
    const status = await options.store.appStatus(workspace, appId);
    if (!status || status.status === "deleted") return reply.status(200).send({ outcome: "gone" });
    // M15: a disabled app's queued work (delayed steps, deliveries, leases) never runs. The task
    // is acknowledged; the work stays in the app's database and, after an enable, MD12 recovery
    // re-enqueues it on the app's next authenticated request.
    if (status.status === "disabled") return reply.status(200).send({ outcome: "disabled" });
    // An emergency stop holds work without dropping it: the queue retries after the stop.
    if (await options.store.stopped?.(workspace))
      return reply.status(503).header("retry-after", "300").send({ outcome: "suspended" });
    const release = status.activeReleaseId
      ? await options.store.release(workspace, appId, status.activeReleaseId)
      : null;
    const endpoint = release?.candidate?.endpoint ?? release?.registration?.endpoint;
    // No served release yet (work can only exist after one): let the queue retry.
    if (!endpoint)
      return reply.status(503).header("retry-after", "60").send({ outcome: "no-release" });
    const audience = wakeUrl(options.baseUrl, workspace, appId);
    const signal = AbortSignal.timeout(55_000);
    let response: Response;
    try {
      const token = await options.mint(options.invokerFor(workspace, appId), audience, signal);
      response = await fetcher(`${endpoint}/_embody/drain`, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(request.body ?? {}),
        signal,
      });
    } catch {
      return reply.status(503).header("retry-after", "5").send({ outcome: "unavailable" });
    }
    const retry = response.headers.get("retry-after");
    if (retry && /^\d{1,5}$/.test(retry)) reply.header("retry-after", retry);
    // The drain's answer is the queue's answer (2xx acknowledges, 503 retries).
    const answer = response.status >= 500 ? 503 : response.status;
    return reply.status(answer).send({ outcome: `forwarded:${response.status}` });
  });
}
