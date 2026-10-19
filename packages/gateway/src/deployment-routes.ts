import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ConflictError,
  UnauthenticatedError,
  type EmbodyErrorCode,
  type Principal,
} from "@embody/core";
import {
  AppManagementSchema,
  DeploymentSubmissionSchema,
  HOSTED_PROFILE,
  hasPermission,
  publicError,
  submissionFingerprint,
  type Permission,
} from "@embody/cloud-contracts";
import type { TaskQueue } from "@embody/host";
import { DispatchRateLimitedError, type AuditRecord } from "./dispatch.js";
import type { GatewayStore } from "./store.js";
import {
  verifySubmissionSource,
  type SourceRequestContext,
  type SourceStore,
} from "./source-admission.js";
import {
  DEPLOYMENT_LIMITS,
  DeploymentError,
  deploymentStatus,
  type DeploymentStore,
  type DeploymentTaskBody,
  type PublicErrorCode,
} from "./deployment.js";
import { deploymentWakeHook, reconcileDeployments } from "./deployment-controller.js";

export interface DeploymentRouteOptions {
  /** Defaults to the workspace gateway store when it implements DeploymentStore. */
  readonly store?: DeploymentStore & Pick<SourceStore, "source">;
  /** The controller queue; tasks target the deployment worker, never the gateway. */
  readonly queue: TaskQueue<DeploymentTaskBody>;
  readonly storageTimeoutMs?: number;
}

const STATUS: Record<PublicErrorCode, number> = {
  INVALID_INPUT: 400,
  UNSUPPORTED_PROFILE: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  STALE_GENERATION: 409,
  CANCELLED: 409,
  LIMIT_EXCEEDED: 429,
  BUILD_FAILED: 409,
  CHECK_FAILED: 409,
  DEPENDENCY_UNAVAILABLE: 503,
};
const AUDIT_CODE: Partial<Record<PublicErrorCode, EmbodyErrorCode>> = {
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  IDEMPOTENCY_CONFLICT: "CONFLICT",
  STALE_GENERATION: "CONFLICT",
  LIMIT_EXCEEDED: "RATE_LIMITED",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_ERROR",
};
function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DeploymentError("DEPENDENCY_UNAVAILABLE")), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}
/** Store, queue and provider failures surface as one fixed retryable error. */
const opaque = (error: unknown): never => {
  if (error instanceof DeploymentError) throw error;
  throw new DeploymentError("DEPENDENCY_UNAVAILABLE");
};

/**
 * M12 management routes. Order on every request: authenticate (workspace hook) → exact app grant
 * → durable quota/audit admission → store. Submission commits the deployment, its idempotency
 * binding, the source pin and the first controller task in one transaction and returns at once
 * (202, or 200 for a replay) without waiting for any build. Requests also run bounded MD12
 * recovery for the workspace's overdue deployments; it never fails or delays the request beyond
 * two seconds.
 */
export function registerDeploymentRoutes(
  app: FastifyInstance,
  deps: {
    current: () => SourceRequestContext;
    admission: Pick<GatewayStore, "admit" | "complete">;
    store: DeploymentStore & Pick<SourceStore, "source">;
    queue: TaskQueue<DeploymentTaskBody>;
    clock: { now(): Date };
    storageTimeoutMs?: number;
  },
): void {
  const timeout = deps.storageTimeoutMs ?? 10_000;
  const wake = deploymentWakeHook(deps.queue);
  const prefix = "/v1/workspaces/:workspace/apps/:app";
  const fail = (reply: FastifyReply, code: PublicErrorCode) =>
    reply.status(STATUS[code]).send({ error: publicError(code) });
  const authorize = (request: FastifyRequest, permission: Permission) => {
    const { workspace, app: appId } = request.params as { workspace: string; app: string };
    const { credential, catalog, principal } = deps.current();
    if (credential.workspaceId !== workspace) throw new UnauthenticatedError();
    const grants = credential.grants.filter(
      (grant) => grant.workspaceId === workspace && grant.appId === appId,
    );
    const target = catalog.find((entry) => entry.appId === appId && entry.state !== "deleted");
    // Do not reveal apps the caller holds no grant for.
    if (!grants.length || !target) throw new DeploymentError("NOT_FOUND");
    if (
      !grants.some((grant) => hasPermission(grant, { workspaceId: workspace, appId }, permission))
    )
      throw new DeploymentError("FORBIDDEN");
    return { workspace, appId, principal };
  };
  const recover = async (workspace: string) => {
    const now = deps.clock.now();
    await deadline(
      deps.store
        .overdueDeployments(now, DEPLOYMENT_LIMITS.recoveryBatch, workspace)
        .then((overdue) => reconcileDeployments(deps.queue, overdue, now)),
      2_000,
    ).catch(() => undefined);
  };
  const audited = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    scope: { workspace: string; appId: string; principal: Principal },
    target: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const started = Date.now();
    const base = {
      requestId: String(reply.getHeader("x-request-id") ?? request.id),
      orgId: scope.workspace,
      appId: scope.appId,
      target,
      actorId: scope.principal.actorId,
      ...(scope.principal.delegation
        ? {
            subjectId: scope.principal.delegation.subjectId,
            ...(scope.principal.delegation.client
              ? { client: scope.principal.delegation.client }
              : {}),
          }
        : {}),
      surface: "http" as const,
    };
    try {
      await deps.admission.admit({ ...base, outcome: "unknown", durationMs: 0 });
    } catch (error) {
      if (error instanceof DispatchRateLimitedError) {
        reply.header("retry-after", String(error.retryAfterSeconds));
        throw new DeploymentError("LIMIT_EXCEEDED");
      }
      throw new DeploymentError("DEPENDENCY_UNAVAILABLE");
    }
    let record: AuditRecord = { ...base, outcome: "failure", durationMs: 0 };
    try {
      const result = await work();
      record = { ...base, outcome: "success", durationMs: Date.now() - started };
      return result;
    } catch (error) {
      const code = error instanceof DeploymentError ? error.code : undefined;
      record = {
        ...base,
        outcome: "failure",
        errorCode: code ? (AUDIT_CODE[code] ?? "VALIDATION_ERROR") : "INTERNAL_ERROR",
        durationMs: Date.now() - started,
      };
      throw error;
    } finally {
      await deadline(deps.admission.complete(record), 5_000).catch(() => undefined);
    }
  };
  const routeOptions = {
    bodyLimit: HOSTED_PROFILE.maxSubmissionBytes,
    errorHandler: (
      error: Error & { statusCode?: number; code?: string },
      _request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      if (error instanceof DeploymentError) return fail(reply, error.code);
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE")
        return reply.status(413).send({ error: publicError("LIMIT_EXCEEDED") });
      if (
        error.code?.startsWith("FST_ERR_CTP_") ||
        error.statusCode === 400 ||
        error.statusCode === 415
      )
        return reply
          .status(error.statusCode === 415 ? 415 : 400)
          .send({ error: publicError("INVALID_INPUT") });
      throw error; // Authentication and unexpected errors use the gateway envelope.
    },
  };
  const deploymentIdOf = (request: FastifyRequest) => {
    const id = (request.params as { deployment: string }).deployment;
    if (!/^dep_[a-z0-9]{8,64}$/.test(id)) throw new DeploymentError("NOT_FOUND");
    return id;
  };

  app.get(prefix, routeOptions, async (request, reply) => {
    const scope = authorize(request, "app:read");
    const status = await deadline(
      deps.store.appStatus(scope.workspace, scope.appId),
      timeout,
    ).catch(opaque);
    if (!status || status.status === "deleted") throw new DeploymentError("NOT_FOUND");
    return reply.status(200).send({
      version: 1,
      workspaceId: scope.workspace,
      appId: scope.appId,
      generation: status.generation,
      lifecycleFence: status.lifecycleFence,
      status: status.status,
      activeReleaseId: status.activeReleaseId,
    });
  });

  app.post(`${prefix}/deployments`, routeOptions, async (request, reply) => {
    const scope = authorize(request, "deployment:submit");
    const parsed = DeploymentSubmissionSchema.safeParse(request.body);
    if (
      !parsed.success ||
      parsed.data.workspaceId !== scope.workspace ||
      parsed.data.appId !== scope.appId
    )
      throw new DeploymentError("INVALID_INPUT");
    const submission = parsed.data;
    const result = await audited(request, reply, scope, "deployment.submit", async () => {
      const now = deps.clock.now();
      // M10: the upload must be this app's verified source with the submitted digest and size.
      // The transaction re-checks it under lock and pins it.
      await deadline(verifySubmissionSource(deps.store, submission, now), timeout).catch(
        (error: unknown) => {
          if (error instanceof DeploymentError) throw error;
          if (error instanceof Error && error.name === "SourceAdmissionError")
            throw new DeploymentError("INVALID_INPUT");
          throw new DeploymentError("DEPENDENCY_UNAVAILABLE");
        },
      );
      return deadline(
        deps.store.submitDeployment(
          {
            submission,
            fingerprint: submissionFingerprint(submission),
            actorId: scope.principal.actorId,
            now,
          },
          wake,
        ),
        timeout,
      ).catch((error: unknown) => {
        if (error instanceof ConflictError) throw new DeploymentError("DEPENDENCY_UNAVAILABLE");
        return opaque(error);
      });
    });
    await recover(scope.workspace);
    return reply.status(result.replay ? 200 : 202).send(deploymentStatus(result.record));
  });

  app.get(`${prefix}/deployments/:deployment`, routeOptions, async (request, reply) => {
    const scope = authorize(request, "deployment:read");
    const deploymentId = deploymentIdOf(request);
    const record = await deadline(
      deps.store.deployment(scope.workspace, scope.appId, deploymentId),
      timeout,
    ).catch(opaque);
    if (!record) throw new DeploymentError("NOT_FOUND");
    await recover(scope.workspace);
    return reply.status(200).send(deploymentStatus(record));
  });

  app.post(`${prefix}/deployments/:deployment/cancel`, routeOptions, async (request, reply) => {
    const scope = authorize(request, "deployment:cancel");
    const deploymentId = deploymentIdOf(request);
    const parsed = AppManagementSchema.safeParse(request.body);
    if (
      !parsed.success ||
      parsed.data.operation !== "cancel" ||
      parsed.data.workspaceId !== scope.workspace ||
      parsed.data.appId !== scope.appId ||
      parsed.data.deploymentId !== deploymentId
    )
      throw new DeploymentError("INVALID_INPUT");
    const fence = parsed.data.cancellationFence;
    const result = await audited(request, reply, scope, "deployment.cancel", () =>
      deadline(
        deps.store.cancelDeployment(
          { workspaceId: scope.workspace, appId: scope.appId, deploymentId },
          fence,
          deps.clock.now(),
          wake,
        ),
        timeout,
      ).catch(opaque),
    );
    return reply.status(200).send(deploymentStatus(result.record));
  });
}
