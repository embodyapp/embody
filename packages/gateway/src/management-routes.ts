import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Principal } from "@embody/core";
import {
  AppManagementSchema,
  MANAGEMENT_LIMITS,
  SecretNameSchema,
  SecretRevokeSchema,
  SecretWriteSchema,
  type AppDeletionReceipt,
  type DeploymentLog,
  type LogPage,
  type Permission,
  type SecretList,
} from "@embody/cloud-contracts";
import {
  DeploymentError,
  appControl,
  deploymentStatus,
  type DeploymentRecord,
  type DeploymentStore,
  type DeploymentWakeHook,
} from "./deployment.js";
import {
  decodeCursor,
  logPage,
  logSince,
  secretStatus,
  type ManagementStore,
  type SecretNaming,
  type SecretRecord,
  type SecretVault,
} from "./management.js";
import type { CatalogApp } from "./store.js";

export interface SecretRouteOptions {
  readonly vault: SecretVault;
  readonly naming: SecretNaming;
  /** Per vault call (default 10 s). */
  readonly timeoutMs?: number;
}
/** Bounded, redacted build log of one deployment attempt (`BuildAdmission.log`). */
export interface BuildLogReader {
  read(
    deployment: DeploymentRecord,
    attempt: number,
  ): Promise<{ readonly text: string; readonly truncated: boolean } | null>;
}
type Scope = {
  workspace: string;
  appId: string;
  principal: Principal;
  target: CatalogApp | undefined;
};
interface ManagementKit {
  readonly prefix: string;
  readonly routeOptions: object;
  authorize(
    request: FastifyRequest,
    permission: Permission,
    options?: { readonly mutation?: boolean; readonly allowDeleted?: boolean },
  ): Scope;
  audited<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    scope: Scope,
    target: string,
    work: () => Promise<T>,
  ): Promise<T>;
  recover(workspace: string): Promise<void>;
  submitRedeploy(
    scope: Scope,
    releaseId: string,
    expectedGeneration: number,
    rollout: boolean,
  ): Promise<{ readonly record: DeploymentRecord; readonly replay: boolean }>;
  readonly store: DeploymentStore & ManagementStore;
  readonly clock: { now(): Date };
  readonly timeout: number;
  readonly wake: DeploymentWakeHook;
  readonly secrets?: SecretRouteOptions;
  readonly buildLogs?: BuildLogReader;
}

function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DeploymentError("DEPENDENCY_UNAVAILABLE")), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}
const opaque = (error: unknown): never => {
  if (error instanceof DeploymentError) throw error;
  throw new DeploymentError("DEPENDENCY_UNAVAILABLE");
};

/**
 * M15 management routes (docs/mvp/MANAGEMENT.md), with the M12 order on every request:
 * authenticate → exact app grant → durable quota/audit admission → store. Lifecycle changes are
 * one store transaction (catalog, fences, deployment cancellation, delete retention and wakes);
 * secret values are write-only and go straight to the vault; logs come from platform records only.
 */
export function registerManagementRoutes(app: FastifyInstance, kit: ManagementKit): void {
  const { prefix, routeOptions, authorize, audited, store, clock, timeout } = kit;
  const status = (entry: CatalogApp) => {
    const control = appControl(entry)!;
    return {
      version: 1 as const,
      workspaceId: entry.workspaceId,
      appId: entry.appId,
      ...(control.name !== undefined ? { name: control.name } : {}),
      generation: control.generation,
      lifecycleFence: control.lifecycleFence,
      status: control.status,
      activeReleaseId: control.activeReleaseId,
    };
  };
  const vaultTimeout = kit.secrets?.timeoutMs ?? 10_000;
  /** Disables revoked versions the vault has not confirmed yet (idempotent, bounded). */
  const disableRevoked = async (records: readonly SecretRecord[]) => {
    if (!kit.secrets) return true;
    let complete = true;
    for (const record of records)
      for (const version of record.versions)
        if (version.state === "revoked" && version.disabled !== true) {
          try {
            await bounded(
              kit.secrets.vault.disableVersion(
                record.providerSecret,
                version.providerVersion,
                AbortSignal.timeout(vaultTimeout),
              ),
              vaultTimeout,
            );
            await store.confirmSecretDisabled(
              record.workspaceId,
              record.appId,
              record.name,
              version.secretVersion,
            );
          } catch {
            complete = false;
          }
        }
    return complete;
  };

  // Lifecycle -----------------------------------------------------------------------------------

  for (const operation of ["disable", "enable", "delete"] as const) {
    app.post(`${prefix}/${operation}`, routeOptions, async (request, reply) => {
      const scope = authorize(request, operation === "delete" ? "app:delete" : "app:disable", {
        // Disabling stays available during an emergency stop; enabling or deleting does not.
        mutation: operation !== "disable",
        allowDeleted: operation === "delete",
      });
      const parsed = AppManagementSchema.safeParse(request.body);
      if (
        !parsed.success ||
        parsed.data.operation !== operation ||
        parsed.data.workspaceId !== scope.workspace ||
        parsed.data.appId !== scope.appId
      )
        throw new DeploymentError("INVALID_INPUT");
      const { expectedGeneration } = parsed.data as { expectedGeneration: number };
      const result = await audited(request, reply, scope, `app.${operation}`, () =>
        bounded(
          store.changeLifecycle(
            {
              workspaceId: scope.workspace,
              appId: scope.appId,
              operation,
              expectedGeneration,
              actorId: scope.principal.actorId,
              now: clock.now(),
            },
            kit.wake,
          ),
          timeout,
        ).catch(opaque),
      );
      if (operation === "delete") {
        // Revoked in the transaction; the vault disables every version now (a replay retries).
        const records = await bounded(store.secrets(scope.workspace, scope.appId), timeout).catch(
          () => [],
        );
        await disableRevoked(records);
        const receipt: AppDeletionReceipt | null =
          result.receipt ??
          (await bounded(store.deletionReceipt(scope.workspace, scope.appId), timeout).catch(
            opaque,
          ));
        if (!receipt) throw new DeploymentError("DEPENDENCY_UNAVAILABLE");
        return reply.status(200).send(receipt);
      }
      return reply.status(200).send(status(result.app));
    });
  }
  app.get(`${prefix}/deletion`, routeOptions, async (request, reply) => {
    const scope = authorize(request, "app:delete", { allowDeleted: true });
    const receipt = await bounded(
      store.deletionReceipt(scope.workspace, scope.appId),
      timeout,
    ).catch(opaque);
    if (!receipt) throw new DeploymentError("NOT_FOUND");
    return reply.status(200).send(receipt);
  });

  // M15 rollout: the active release again, with the app's current secret versions.
  app.post(`${prefix}/rollout`, routeOptions, async (request, reply) => {
    const scope = authorize(request, "app:rollback", { mutation: true });
    const parsed = AppManagementSchema.safeParse(request.body);
    if (
      !parsed.success ||
      parsed.data.operation !== "rollout" ||
      parsed.data.workspaceId !== scope.workspace ||
      parsed.data.appId !== scope.appId
    )
      throw new DeploymentError("INVALID_INPUT");
    const active = scope.target?.activeRelease;
    if (!active) throw new DeploymentError("NOT_FOUND");
    const result = await audited(request, reply, scope, "app.rollout", () =>
      kit.submitRedeploy(
        scope,
        active,
        (parsed.data as { expectedGeneration: number }).expectedGeneration,
        true,
      ),
    );
    await kit.recover(scope.workspace);
    return reply.status(result.replay ? 200 : 202).send(deploymentStatus(result.record));
  });

  // Secrets ---------------------------------------------------------------------------------------

  // Metadata only, so it is served even without a vault (an app then has no secrets).
  const list = async (scope: Scope): Promise<SecretList> => ({
    version: 1,
    workspaceId: scope.workspace as SecretList["workspaceId"],
    appId: scope.appId as SecretList["appId"],
    secrets: (
      await bounded(store.secrets(scope.workspace, scope.appId), timeout).catch(opaque)
    ).map(secretStatus),
  });
  const nameOf = (request: FastifyRequest) => {
    const parsed = SecretNameSchema.safeParse((request.params as { name: string }).name);
    if (!parsed.success) throw new DeploymentError("INVALID_INPUT");
    return parsed.data;
  };
  app.get(`${prefix}/secrets`, routeOptions, async (request, reply) => {
    const scope = authorize(request, "secret:list");
    return reply.status(200).send(await list(scope));
  });
  if (kit.secrets) {
    const secrets = kit.secrets;
    // The only route that receives a secret value. It is never logged, stored by the platform or
    // returned: the vault holds it, the platform keeps the version metadata.
    app.put(
      `${prefix}/secrets/:name`,
      { ...routeOptions, bodyLimit: MANAGEMENT_LIMITS.maxSecretBytes * 6 + 2_048 },
      async (request, reply) => {
        const scope = authorize(request, "secret:write", { mutation: true });
        const name = nameOf(request);
        const parsed = SecretWriteSchema.safeParse(request.body);
        if (
          !parsed.success ||
          parsed.data.workspaceId !== scope.workspace ||
          parsed.data.appId !== scope.appId ||
          parsed.data.name !== name
        )
          throw new DeploymentError("INVALID_INPUT");
        const write = parsed.data;
        const record = await audited(request, reply, scope, "secret.write", async () => {
          const providerSecret = secrets.naming.secret(scope.workspace, scope.appId, name);
          const signal = AbortSignal.timeout(vaultTimeout);
          let providerVersion: string;
          try {
            await bounded(
              secrets.vault.ensure(
                providerSecret,
                secrets.naming.accessor(scope.workspace, scope.appId),
                signal,
              ),
              vaultTimeout,
            );
            providerVersion = await bounded(
              secrets.vault.addVersion(providerSecret, write.value, signal),
              vaultTimeout,
            );
          } catch {
            throw new DeploymentError("DEPENDENCY_UNAVAILABLE");
          }
          try {
            return await bounded(
              store.putSecretVersion({
                workspaceId: scope.workspace,
                appId: scope.appId,
                name,
                expectedVersion: write.expectedVersion,
                providerSecret,
                providerVersion,
                now: clock.now(),
              }),
              timeout,
            );
          } catch (error) {
            // Another writer won (or the store failed): the version just written is never
            // referenced, so disable it now rather than leave a second live value.
            await bounded(
              secrets.vault.disableVersion(
                providerSecret,
                providerVersion,
                AbortSignal.timeout(vaultTimeout),
              ),
              vaultTimeout,
            ).catch(() => undefined);
            return opaque(error);
          }
        });
        return reply.status(200).send(secretStatus(record));
      },
    );
    app.post(`${prefix}/secrets/:name/revoke`, routeOptions, async (request, reply) => {
      // Revocation is a safety action: allowed during an emergency stop.
      const scope = authorize(request, "secret:write");
      const name = nameOf(request);
      const parsed = SecretRevokeSchema.safeParse(request.body);
      if (
        !parsed.success ||
        parsed.data.workspaceId !== scope.workspace ||
        parsed.data.appId !== scope.appId ||
        parsed.data.name !== name
      )
        throw new DeploymentError("INVALID_INPUT");
      const record = await audited(request, reply, scope, "secret.revoke", async () => {
        const revoked = await bounded(
          store.revokeSecretVersion({
            workspaceId: scope.workspace,
            appId: scope.appId,
            name,
            secretVersion: parsed.data.secretVersion,
            now: clock.now(),
          }),
          timeout,
        ).catch(opaque);
        // Complete only once the vault confirms: a retry finishes an interrupted revocation.
        if (!(await disableRevoked([revoked]))) throw new DeploymentError("DEPENDENCY_UNAVAILABLE");
        return revoked;
      });
      const latest =
        (await bounded(store.secrets(scope.workspace, scope.appId), timeout).catch(() => [])).find(
          (entry) => entry.name === name,
        ) ?? record;
      return reply.status(200).send(secretStatus(latest));
    });
  }

  // Logs ------------------------------------------------------------------------------------------

  app.get(`${prefix}/logs`, routeOptions, async (request, reply) => {
    const scope = authorize(request, "deployment:read");
    const query = request.query as Record<string, unknown>;
    const known = new Set(["limit", "cursor", "since"]);
    if (Object.keys(query).some((key) => !known.has(key) || typeof query[key] !== "string"))
      throw new DeploymentError("INVALID_INPUT");
    const limitText = query["limit"] as string | undefined;
    const limit = limitText === undefined ? MANAGEMENT_LIMITS.defaultLogEntries : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MANAGEMENT_LIMITS.maxLogEntries)
      throw new DeploymentError("INVALID_INPUT");
    const before = decodeCursor(query["cursor"] as string | undefined);
    const since = logSince(clock.now(), query["since"] as string | undefined);
    const name = scope.target?.name ?? scope.target?.registration?.appId;
    // Admitted like every management request: log reads count against the workspace quota and
    // are themselves audited (M15.d).
    const entries = await audited(request, reply, scope, "app.logs", () =>
      bounded(
        store.appLogs({
          workspaceId: scope.workspace,
          appId: scope.appId,
          ...(name ? { aliases: [name] } : {}),
          limit,
          ...(before ? { before } : {}),
          since,
        }),
        timeout,
      ).catch(opaque),
    );
    const page: LogPage = {
      version: 1,
      workspaceId: scope.workspace as LogPage["workspaceId"],
      appId: scope.appId as LogPage["appId"],
      ...logPage(entries, limit),
    };
    return reply.status(200).send(page);
  });
  if (kit.buildLogs) {
    const reader = kit.buildLogs;
    app.get(`${prefix}/deployments/:deployment/logs`, routeOptions, async (request, reply) => {
      const scope = authorize(request, "deployment:read");
      const deploymentId = (request.params as { deployment: string }).deployment;
      if (!/^dep_[a-z0-9]{8,64}$/.test(deploymentId)) throw new DeploymentError("NOT_FOUND");
      const query = request.query as Record<string, unknown>;
      if (Object.keys(query).some((key) => key !== "attempt"))
        throw new DeploymentError("INVALID_INPUT");
      const attempt = query["attempt"] === undefined ? undefined : Number(query["attempt"]);
      if (attempt !== undefined && (!Number.isInteger(attempt) || attempt < 1 || attempt > 3))
        throw new DeploymentError("INVALID_INPUT");
      const log = await audited(request, reply, scope, "deployment.logs", async () => {
        const record = await bounded(
          store.deployment(scope.workspace, scope.appId, deploymentId),
          timeout,
        ).catch(opaque);
        if (!record) throw new DeploymentError("NOT_FOUND");
        const which = attempt ?? (record.state === "building" ? record.stageAttempt : 3);
        // The newest attempt that has a log, at or below the one asked for.
        for (let n = which; n >= 1; n--) {
          const found = await bounded(reader.read(record, n), timeout).catch(opaque);
          if (found || attempt !== undefined)
            return { attempt: n, text: found?.text ?? "", truncated: found?.truncated ?? false };
        }
        return { attempt: 1, text: "", truncated: false };
      });
      const body: DeploymentLog = {
        version: 1,
        workspaceId: scope.workspace as DeploymentLog["workspaceId"],
        appId: scope.appId as DeploymentLog["appId"],
        deploymentId: deploymentId as DeploymentLog["deploymentId"],
        attempt: log.attempt,
        text: log.text.slice(0, MANAGEMENT_LIMITS.maxBuildLogBytes),
        truncated: log.truncated || log.text.length > MANAGEMENT_LIMITS.maxBuildLogBytes,
      };
      return reply.status(200).send(body);
    });
  }
}
