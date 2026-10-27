import Fastify, { type FastifyInstance } from "fastify";
import { RETRYABLE_BUILD_ERRORS, type BuildErrorCode } from "@embody/cloud-contracts";
import type { PlatformInvokerVerifier } from "@embody/auth";
import { authenticateTask, type TaskQueue } from "@embody/host";
import {
  BuildAdmissionError,
  type ArtifactRecord,
  type ArtifactStore,
  type BuildAdmission,
} from "./build-admission.js";
import { verifySubmissionSource, type SourceStore } from "./source-admission.js";
import {
  DEPLOYMENT_LIMITS,
  MAX_DEPLOYMENT_TASK_BYTES,
  StaleDeploymentError,
  TERMINAL,
  deploymentTaskName,
  deploymentTaskSchema,
  followUpTaskName,
  newReleaseId,
  promotableArtifact,
  type CandidateRef,
  type DeploymentRecord,
  type DeploymentStore,
  type DeploymentTaskBody,
  type DeploymentWakeHook,
  type PublicErrorCode,
  type ReleaseRecord,
  type StageOutcome,
} from "./deployment.js";
import type { ManagementStore } from "./management.js";
import type { Registration } from "./index.js";
import { registerWakeRoute, type WakeRouteOptions } from "./wake-forwarder.js";

/**
 * M12 deployment controller. It runs in the deployment worker, not in the gateway: every step is
 * started by a queue task (Cloud Tasks with the controller's invoker OIDC token), so a deployment
 * advances while the gateway has zero instances and no process holds a timer. A task names a
 * deployment and nothing else; the controller claims it under a lease, runs one bounded stage,
 * and commits the outcome under the claim's fence together with the next wake.
 */

/**
 * What a provisioning or check stage reports. M13 implements these against Cloud Run. `pending`
 * means a provider operation is still running: the controller looks again after
 * `DEPLOYMENT_LIMITS.stagePollMs` in the same attempt, bounded by the stage's own limit.
 */
export type StageResult =
  | { readonly ok: true; readonly candidate?: CandidateRef }
  | { readonly ok: false; readonly pending: true; readonly reason: string }
  | {
      readonly ok: false;
      readonly pending?: false;
      readonly retryable: boolean;
      readonly reason: string;
      /** Public code of a permanent failure; the stage's default otherwise. */
      readonly code?: PublicErrorCode;
    };
/** What the promoting step reports before the promotion transaction (M13). */
export type PromoteResult =
  | { readonly ok: true; readonly registration?: Registration }
  | {
      readonly ok: false;
      readonly retryable: boolean;
      readonly reason: string;
      readonly code?: PublicErrorCode;
    };
export interface DeploymentStageContext {
  readonly deployment: DeploymentRecord;
  /** The admitted artifact: deploy only `imageReference` (digest form). */
  readonly artifact: ArtifactRecord;
  readonly signal: AbortSignal;
  /** M13 rollback: the retained release being rolled back to. */
  readonly rollback?: ReleaseRecord;
  /** M13: the app's active release before this promotion, if any. */
  readonly active?: ReleaseRecord;
}
/**
 * Provisioning and readiness checks. Implementations must be idempotent: resources are named and
 * labelled from platform records (workspace, app, deployment, attempt), never from task input, so
 * a re-run after a crash between creating a resource and recording it adopts the same resource.
 */
export interface DeploymentStages {
  provision(context: DeploymentStageContext): Promise<StageResult>;
  check(context: DeploymentStageContext): Promise<StageResult>;
  /**
   * M13 promoting step, outside the promotion transaction: re-reads and verifies the release
   * manifest and checks workflow versions in use. Its registration is switched into the catalog
   * by the transaction. Absent: the catalog registration is unchanged (M12 behaviour).
   */
  promote?(context: DeploymentStageContext): Promise<PromoteResult>;
  /** Removes resources this deployment created after it failed or was cancelled. Verifies ownership. */
  abandon?(deployment: DeploymentRecord): Promise<void>;
  /**
   * M15 app delete: removes the deployment's candidate even though it served (ownership-checked)
   * and revokes the app's runtime database credential. Idempotent.
   */
  retire?(deployment: DeploymentRecord): Promise<void>;
}
/** M13: removes drained and orphaned candidates (ownership-checked); bounded per pass. */
export interface CandidateSweeper {
  sweep(now: Date): Promise<unknown>;
}

export interface DeploymentControllerOptions {
  readonly store: DeploymentStore &
    Pick<ArtifactStore, "artifact" | "artifactForAttempt"> &
    Pick<SourceStore, "source"> &
    Partial<Pick<ManagementStore, "stopped">>;
  readonly queue: TaskQueue<DeploymentTaskBody>;
  readonly builds: Pick<BuildAdmission, "start" | "settle" | "abandon">;
  readonly stages: DeploymentStages;
  /**
   * Runs after delivered tasks (at most once per `sweepIntervalMs` per process) and on the
   * operator reconcile: no periodic timer, so an idle platform stays at zero.
   */
  readonly sweeper?: CandidateSweeper;
  readonly sweepIntervalMs?: number;
  readonly clock?: { now(): Date };
  /** Test seam; production uses `DEPLOYMENT_LIMITS.handlerDeadlineMs`. Must stay below the lease. */
  readonly handlerDeadlineMs?: number;
  /** One structured line per handled task; never payloads, URLs or provider output. */
  readonly log?: (record: DeploymentLogRecord) => void;
}
export interface DeploymentLogRecord {
  readonly type: "embody.deployment";
  readonly workspaceId?: string;
  readonly appId?: string;
  readonly deploymentId?: string;
  readonly reason?: string;
  readonly outcome: string;
  readonly state?: string;
  readonly attempt?: number;
  readonly durationMs: number;
  /** Bounded operator detail (e.g. `HANDLER_ERROR:pg-42501`); never payloads or messages. */
  readonly detail?: string;
}
export interface TaskResult {
  readonly status: 200 | 400 | 503;
  readonly outcome: string;
  readonly retryAfterSeconds?: number;
}

/** Enqueues the wakes a store asks for. Shared by the gateway (submit, cancel) and the worker. */
export function deploymentWakeHook(queue: TaskQueue<DeploymentTaskBody>): DeploymentWakeHook {
  return async (wakes, txid) => {
    for (const wake of wakes)
      await queue.enqueue({
        name: deploymentTaskName(wake, txid),
        scheduleAt: wake.dueAt,
        body: {
          v: 1,
          kind: "deployment",
          workspaceId: wake.workspaceId,
          appId: wake.appId,
          deploymentId: wake.deploymentId,
          reason: wake.reason,
          epoch: wake.epoch,
          txid,
        },
      });
  };
}

/**
 * A bounded, payload-free tag for a stage error: a PostgreSQL SQLSTATE, a provider HTTP status,
 * a migration refusal reason, or the error class name.
 */
export function errorTag(error: unknown): string {
  const value = error as { code?: unknown; name?: unknown; message?: unknown; reason?: unknown };
  if (typeof value?.code === "string" && /^[0-9A-Z]{5}$/.test(value.code))
    return `pg-${value.code}`;
  if (typeof value?.reason === "string" && /^[A-Z_]{1,40}$/.test(value.reason)) return value.reason;
  const status =
    typeof value?.message === "string"
      ? /\b(?:returned |failed \()(\d{3})\b/.exec(value.message)
      : null;
  if (status) return `provider-${status[1]}`;
  const name =
    typeof value?.name === "string" && /^[A-Za-z]{1,40}$/.test(value.name) ? value.name : "Error";
  return name;
}

class DeadlineError extends Error {
  public constructor(public readonly work: Promise<unknown>) {
    super("Handler deadline exceeded");
  }
}
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const running = work(controller.signal);
  return Promise.race([
    running,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DeadlineError(running));
      }, ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Public code for a rejected build; the build code itself stays an operator-facing reason. */
function buildFailure(code: BuildErrorCode): PublicErrorCode {
  if (code === "SOURCE_INVALID") return "INVALID_INPUT";
  if (code === "UNSUPPORTED_PROFILE" || code === "CAPABILITY_MISMATCH")
    return "UNSUPPORTED_PROFILE";
  if (code === "OUTPUT_LIMIT") return "LIMIT_EXCEEDED";
  if (code === "CANCELLED") return "CANCELLED";
  return "BUILD_FAILED";
}

/** How often a stopped workspace's deployment task looks again (M15 emergency stop). */
export const SUSPENDED_RECHECK_MS = 5 * 60 * 1000;

export class DeploymentController {
  private readonly clock: { now(): Date };
  private readonly wake: DeploymentWakeHook;
  private lastSweep = Number.NEGATIVE_INFINITY;
  public constructor(private readonly options: DeploymentControllerOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.wake = deploymentWakeHook(options.queue);
  }

  /** Handles one delivered task body. Never throws; the status is the queue's answer. */
  public async handle(body: unknown): Promise<TaskResult> {
    const started = Date.now();
    const parsed = deploymentTaskSchema.safeParse(body);
    if (!parsed.success) {
      this.log({ outcome: "invalid", durationMs: Date.now() - started });
      return { status: 400, outcome: "invalid" };
    }
    const task = parsed.data;
    const result = await this.dispatch(task).catch((): TaskResult => ({
      status: 503,
      outcome: "unavailable",
      retryAfterSeconds: 5,
    }));
    // MD12 recovery: any delivered task also re-wakes overdue deployments (bounded, best effort).
    await this.reconcile(DEPLOYMENT_LIMITS.recoveryBatch).catch(() => undefined);
    // M13: drained and orphaned candidates go with ordinary work, never on a timer.
    await this.sweep(false).catch(() => undefined);
    this.log({
      workspaceId: task.workspaceId,
      appId: task.appId,
      deploymentId: task.deploymentId,
      reason: task.reason,
      outcome: result.outcome,
      durationMs: Date.now() - started,
    });
    return result;
  }

  private async dispatch(task: DeploymentTaskBody): Promise<TaskResult> {
    // M15 emergency stop: no deployment of a stopped workspace advances (nothing is claimed or
    // changed); the task re-arms itself and the work resumes once the stop is lifted.
    if (await this.options.store.stopped?.(task.workspaceId)) {
      await this.followUp(
        task,
        new Date(this.clock.now().getTime() + SUSPENDED_RECHECK_MS).toISOString(),
      );
      return { status: 200, outcome: "suspended" };
    }
    const key = {
      workspaceId: task.workspaceId,
      appId: task.appId,
      deploymentId: task.deploymentId,
    };
    const { decision } = await this.options.store.claimDeployment(key, this.clock.now(), this.wake);
    switch (decision.kind) {
      case "missing": {
        // The task can arrive before its transaction is visible, or after it rolled back.
        if (task.txid && (await this.options.store.transactionStatus(task.txid)) === "in-progress")
          return { status: 503, outcome: "uncommitted", retryAfterSeconds: 5 };
        return { status: 200, outcome: "missing" };
      }
      case "terminal":
        return { status: 200, outcome: "terminal" };
      case "leased":
      case "early": {
        // A later epoch committed its own wake in the same transaction: this task is superseded.
        // Otherwise this task is the newest: re-arm it for the lease expiry (that worker may have
        // died) or the due time (it came early).
        if (decision.epoch > task.epoch) return { status: 200, outcome: "superseded" };
        const target =
          decision.kind === "leased"
            ? new Date(Date.parse(decision.until) + 1000).toISOString()
            : decision.dueAt;
        await this.followUp(task, target);
        return { status: 200, outcome: decision.kind };
      }
      case "settled":
        return { status: 200, outcome: `settled:${decision.next.state}` };
      case "cleanup":
        await this.cleanup(decision.record);
        return { status: 200, outcome: "cleanup" };
      case "claimed":
        return this.run(decision.next);
    }
  }

  private async followUp(task: DeploymentTaskBody, target: string): Promise<void> {
    await this.options.queue.enqueue({
      name: followUpTaskName(task, target),
      scheduleAt: target,
      body: { ...task, reason: "follow-up" },
    });
  }

  private async run(record: DeploymentRecord): Promise<TaskResult> {
    const fence = {
      workspaceId: record.workspaceId,
      appId: record.appId,
      deploymentId: record.deploymentId,
      epoch: record.epoch,
      leaseToken: record.leaseToken!,
    };
    let outcome: StageOutcome;
    try {
      outcome = await withDeadline(
        (signal) => this.stage(record, signal),
        Math.min(
          this.options.handlerDeadlineMs ?? DEPLOYMENT_LIMITS.handlerDeadlineMs,
          DEPLOYMENT_LIMITS.handlerDeadlineMs,
        ),
      );
    } catch (error) {
      // Over the handler deadline the stage may still be running: do not complete. The lease
      // (longer than the deadline plus the longest provider call chain) keeps every other
      // worker out until it expires, and the claim's lease wake then reclaims the deployment.
      if (error instanceof DeadlineError) {
        // M12 review finding 1: if the deployment was cancelled meanwhile, a resource this stage
        // creates late is removed once it settles. The candidate sweep is the backstop when the
        // instance is throttled or stopped after the response.
        void error.work
          .catch(() => undefined)
          .then(() => this.abandonIfEnded(record))
          .catch(() => undefined);
        return { status: 200, outcome: "timed-out" };
      }
      // Operator-facing only: a bounded tag (SQLSTATE, provider status or error class), never a
      // message, URL or payload, so a failing stage is diagnosable from the record and the log.
      const reason = `HANDLER_ERROR:${errorTag(error)}`;
      this.log({
        workspaceId: record.workspaceId,
        appId: record.appId,
        deploymentId: record.deploymentId,
        state: record.state,
        attempt: record.stageAttempt,
        outcome: "stage-error",
        detail: reason,
        durationMs: 0,
      });
      outcome =
        record.state === "building" ? { kind: "poll-error", reason } : { kind: "retry", reason };
    }
    try {
      const next = await this.options.store.completeDeployment(
        fence,
        outcome,
        this.clock.now(),
        this.wake,
      );
      return { status: 200, outcome: `${outcome.kind}:${next.state}` };
    } catch (error) {
      if (error instanceof StaleDeploymentError) {
        // Cancelled or superseded while this stage ran; stop anything this stage started.
        await this.abandonIfEnded(record).catch(() => undefined);
        return { status: 200, outcome: "stale" };
      }
      return { status: 503, outcome: "unavailable", retryAfterSeconds: 5 };
    }
  }

  private async stage(record: DeploymentRecord, signal: AbortSignal): Promise<StageOutcome> {
    const now = this.clock.now();
    switch (record.state) {
      case "accepted":
        return { kind: "advance" };
      case "validating":
        try {
          await verifySubmissionSource(this.options.store, record.submission, now);
        } catch {
          return { kind: "fail", code: "INVALID_INPUT", reason: "SOURCE_INVALID" };
        }
        return { kind: "advance" };
      case "building":
        // A rollback deploys its target's admitted artifact: nothing to build.
        if (record.rollbackOf) return { kind: "advance" };
        return this.build(record);
      case "provisioning":
      case "checking":
      case "promoting": {
        const context = await this.context(record, signal);
        if (!context)
          return {
            kind: "fail",
            code: record.rollbackOf ? "ROLLBACK_INCOMPATIBLE" : "DEPENDENCY_UNAVAILABLE",
            reason: "ARTIFACT_MISSING",
          };
        if (record.state === "promoting") {
          const result = (await this.options.stages.promote?.(context)) ?? { ok: true };
          if (result.ok)
            return {
              kind: "promote",
              releaseId: newReleaseId(),
              ...(result.registration ? { registration: result.registration } : {}),
            };
          if (result.retryable) return { kind: "retry", reason: result.reason };
          return { kind: "fail", code: result.code ?? "CHECK_FAILED", reason: result.reason };
        }
        // M13 stage bounds: a candidate that never becomes ready fails visibly.
        const limit =
          record.state === "provisioning"
            ? DEPLOYMENT_LIMITS.provisionStageMs
            : DEPLOYMENT_LIMITS.checkStageMs;
        if (now.getTime() - Date.parse(record.stageStartedAt ?? record.createdAt) > limit)
          return record.state === "provisioning"
            ? { kind: "fail", code: "DEPENDENCY_UNAVAILABLE", reason: "PROVISION_TIMEOUT" }
            : { kind: "fail", code: "CHECK_FAILED", reason: "READINESS_TIMEOUT" };
        const result =
          record.state === "provisioning"
            ? await this.options.stages.provision(context)
            : await this.options.stages.check(context);
        if (result.ok)
          return { kind: "advance", ...(result.candidate ? { candidate: result.candidate } : {}) };
        if (result.pending) return { kind: "poll", delayMs: DEPLOYMENT_LIMITS.stagePollMs };
        if (result.retryable) return { kind: "retry", reason: result.reason };
        return {
          kind: "fail",
          code:
            result.code ??
            (record.state === "checking" ? "CHECK_FAILED" : "DEPENDENCY_UNAVAILABLE"),
          reason: result.reason,
        };
      }
      default:
        throw new TypeError(`No stage runs in ${record.state}`);
    }
  }

  /**
   * One build stage step under the claim's lease (M11 obligation: one serialized `start` per
   * attempt). A running build is polled (`settle`) every `buildPollMs`; an admitted artifact moves
   * on; a `DEPENDENCY_UNAVAILABLE` rejection, including the one an overdue `settle` produces
   * (review N2), starts the next attempt; any other rejection fails the deployment.
   */
  private async build(record: DeploymentRecord): Promise<StageOutcome> {
    const { submission } = record;
    let artifact: ArtifactRecord | null;
    try {
      artifact = await this.options.store.artifactForAttempt(
        record.workspaceId,
        record.appId,
        record.deploymentId,
        record.stageAttempt,
      );
      artifact ??= await this.options.builds.start({
        submission,
        deploymentId: record.deploymentId,
        attempt: record.stageAttempt,
      });
      if (artifact.state === "building")
        artifact = await this.options.builds.settle(artifact, submission);
    } catch (error) {
      if (error instanceof BuildAdmissionError) {
        if (error.code === "SOURCE_INVALID")
          return { kind: "fail", code: "INVALID_INPUT", reason: "SOURCE_INVALID" };
        if (error.code === "PROVENANCE_INVALID")
          return { kind: "fail", code: "BUILD_FAILED", reason: "PROVENANCE_INVALID" };
      }
      return { kind: "poll-error", reason: "BUILD_PROVIDER" };
    }
    if (artifact.state === "building")
      return { kind: "poll", delayMs: DEPLOYMENT_LIMITS.buildPollMs };
    if (artifact.state === "admitted") return { kind: "advance", artifactId: artifact.artifactId };
    const code = artifact.error ?? "BUILD_FAILED";
    if (RETRYABLE_BUILD_ERRORS.has(code)) return { kind: "retry", reason: `BUILD_${code}` };
    return { kind: "fail", code: buildFailure(code), reason: `BUILD_${code}` };
  }

  /** The artifact to deploy (its own build, or a rollback target's) and the releases around it. */
  private async context(
    record: DeploymentRecord,
    signal: AbortSignal,
  ): Promise<DeploymentStageContext | null> {
    const { store } = this.options;
    const artifact = record.artifactId
      ? await store.artifact(record.workspaceId, record.appId, record.artifactId)
      : null;
    if (!promotableArtifact(record, artifact)) return null;
    const rollback = record.rollbackOf
      ? await store.release(record.workspaceId, record.appId, record.rollbackOf)
      : undefined;
    if (record.rollbackOf && (!rollback || rollback.artifactId !== artifact.artifactId))
      return null;
    const status = await store.appStatus(record.workspaceId, record.appId);
    const active = status?.activeReleaseId
      ? await store.release(record.workspaceId, record.appId, status.activeReleaseId)
      : null;
    return {
      deployment: record,
      artifact,
      signal,
      ...(rollback ? { rollback } : {}),
      ...(active ? { active } : {}),
    };
  }

  /** Cancels running builds of every attempt and removes provisioned candidates (ownership-checked). */
  private async abandon(record: DeploymentRecord): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const artifact = await this.options.store.artifactForAttempt(
        record.workspaceId,
        record.appId,
        record.deploymentId,
        attempt,
      );
      if (artifact?.state === "building") await this.options.builds.abandon(artifact);
    }
    // M15: a deleted app keeps nothing: even the candidate that served goes, and its runtime
    // credential is revoked.
    const status = await this.options.store.appStatus(record.workspaceId, record.appId);
    if (status?.status === "deleted" && this.options.stages.retire)
      await this.options.stages.retire(record);
    else if (record.state !== "active") await this.options.stages.abandon?.(record);
  }

  private async abandonIfEnded(record: DeploymentRecord): Promise<void> {
    const latest = await this.options.store.deployment(
      record.workspaceId,
      record.appId,
      record.deploymentId,
    );
    if (latest && TERMINAL.has(latest.state) && latest.state !== "active")
      await this.abandon(latest);
  }

  private async cleanup(record: DeploymentRecord): Promise<void> {
    let done = true;
    try {
      await this.abandon(record);
    } catch {
      done = false;
    }
    await this.options.store.finishCleanup(
      { workspaceId: record.workspaceId, appId: record.appId, deploymentId: record.deploymentId },
      record.epoch,
      done,
      this.clock.now(),
      this.wake,
    );
  }

  /**
   * MD12 recovery: deployments overdue by more than the grace period with no live lease get a
   * fresh wake (a lost task, or retries exhausted). At most one per deployment, epoch and grace
   * window. Runs after every delivered task and every authenticated deployment request; there is
   * no periodic sweep, so an idle platform stays at zero.
   */
  /** Runs the candidate sweep, at most once per interval unless forced (operator reconcile). */
  public async sweep(force: boolean): Promise<void> {
    const sweeper = this.options.sweeper;
    if (!sweeper) return;
    const now = this.clock.now();
    const interval = this.options.sweepIntervalMs ?? DEPLOYMENT_LIMITS.recoveryGraceMs;
    if (!force && now.getTime() - this.lastSweep < interval) return;
    this.lastSweep = now.getTime();
    await sweeper.sweep(now);
  }

  public async reconcile(limit: number, workspaceId?: string): Promise<{ readonly woken: number }> {
    const now = this.clock.now();
    const overdue = await this.options.store.overdueDeployments(now, limit, workspaceId);
    return reconcileDeployments(this.options.queue, overdue, now);
  }

  private log(record: Omit<DeploymentLogRecord, "type">): void {
    this.options.log?.({ type: "embody.deployment", ...record });
  }
}

/** Shared by the controller and the gateway's request-time recovery. */
export async function reconcileDeployments(
  queue: TaskQueue<DeploymentTaskBody>,
  overdue: readonly DeploymentRecord[],
  now: Date,
): Promise<{ readonly woken: number }> {
  const window = DEPLOYMENT_LIMITS.recoveryGraceMs;
  const bucket = new Date(Math.floor(now.getTime() / window) * window).toISOString();
  let woken = 0;
  for (const record of overdue) {
    const wake = {
      workspaceId: record.workspaceId,
      appId: record.appId,
      deploymentId: record.deploymentId,
      epoch: record.epoch,
      reason: "recover" as const,
      dueAt: bucket,
    };
    const outcome = await queue.enqueue({
      name: deploymentTaskName(wake),
      scheduleAt: now.toISOString(),
      body: {
        v: 1,
        kind: "deployment",
        workspaceId: record.workspaceId,
        appId: record.appId,
        deploymentId: record.deploymentId,
        reason: "recover",
        epoch: record.epoch,
      },
    });
    if (outcome === "created") woken += 1;
  }
  return { woken };
}

export interface DeploymentWorkerOptions {
  readonly controller: DeploymentController;
  /** Accepts only the controller queue's invoker identity for the worker's task audience. */
  readonly verifier: PlatformInvokerVerifier;
  /** M13: the stable per-app wake route of hosted durable apps (see `wake-forwarder.ts`). */
  readonly wake?: WakeRouteOptions;
}
const TASK_ROUTES = new Set(["/_embody/tasks/deployment", "/_embody/tasks/reconcile"]);
/**
 * The deployment worker's HTTP surface: health, task delivery and an operator reconcile. Task
 * routes authenticate before the body is read and accept nothing but a current platform invoker
 * token (shared task ingress, `authenticateTask`). Deploy separately from the gateway with the
 * controller identity and private ingress plus Cloud Run IAM for the invoker.
 */
export function createDeploymentWorker(options: DeploymentWorkerOptions): FastifyInstance {
  const app = Fastify({ bodyLimit: MAX_DEPLOYMENT_TASK_BYTES, logger: false });
  app.get("/health", () => ({ live: true }));
  app.addHook("onRequest", async (request, reply) => {
    if (!TASK_ROUTES.has(request.routeOptions.url ?? "")) return;
    try {
      await authenticateTask(request.headers, options.verifier);
    } catch {
      await reply.status(401).send({ error: "unauthenticated" });
    }
  });
  if (options.wake) registerWakeRoute(app, options.wake);
  app.post("/_embody/tasks/deployment", async (request, reply) => {
    const result = await options.controller.handle(request.body);
    if (result.retryAfterSeconds !== undefined)
      reply.header("retry-after", String(result.retryAfterSeconds));
    return reply.status(result.status).send({ outcome: result.outcome });
  });
  app.post("/_embody/tasks/reconcile", async () => {
    const { woken } = await options.controller.reconcile(DEPLOYMENT_LIMITS.recoveryBatch * 10);
    await options.controller.sweep(true).catch(() => undefined);
    return { woken };
  });
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const status = error.statusCode === 413 ? 413 : error.statusCode === 400 ? 400 : 503;
    return reply.status(status).send({ error: status === 503 ? "unavailable" : "invalid" });
  });
  return app;
}
