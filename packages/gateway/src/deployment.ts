import { randomBytes } from "node:crypto";
import { z } from "@embody/core";
import {
  BUILD_RECIPE,
  DeploymentTransitionSchema,
  HOSTED_PROFILE,
  ReleaseManifestSchema,
  canCancel,
  canPromote,
  publicError,
  submissionFingerprint,
  type DeploymentState,
  type DeploymentStatus,
  type DeploymentSubmission,
  type PublicErrorCodeSchema,
  type ReleaseManifest,
} from "@embody/cloud-contracts";
import { deterministicTaskName } from "@embody/host";
import type { ArtifactRecord } from "./build-admission.js";
import type { SourceRecord } from "./source-admission.js";
import type { CatalogApp } from "./store.js";
import type { Registration } from "./index.js";

export type PublicErrorCode = z.infer<typeof PublicErrorCodeSchema>;

/**
 * M12 durable deployment records and the decisions every store shares. A deployment row is both
 * the deployment state and its durable job: `dueAt` says when work is next due, `epoch` fences
 * every claim and transition, and a lease (`leaseToken`/`leaseUntil`) serializes stage attempts.
 * Stores only lock, persist and call the wake hook before commit; all rules live here.
 * See docs/mvp/DEPLOYMENTS.md.
 */

const SECOND = 1000;
const DAY = 86_400_000;
/** Pinned controller policy (M12 step 5). Changing one is a contract change. */
export const DEPLOYMENT_LIMITS = Object.freeze({
  /** A claim holds the deployment this long; a crashed worker's lease wake fires just after. */
  leaseMs: 180 * SECOND,
  /** A stage handler that runs longer is abandoned (no completion; its lease expires). */
  handlerDeadlineMs: 45 * SECOND,
  /** A running build is settled this often (M11: settle promptly). */
  buildPollMs: 15 * SECOND,
  /** Consecutive claims that never completed (crashed or timed-out workers) per stage attempt. */
  maxCrashes: 3,
  /** Transient errors while polling one build attempt before the attempt counts as failed. */
  maxPollFailures: 8,
  /** No deployment stays nonterminal longer than this; it then fails visibly. */
  deploymentDeadlineMs: 2 * 60 * 60 * SECOND,
  /** Overdue by more than this with no live lease: recovery re-enqueues a wake (MD12). */
  recoveryGraceMs: 60 * SECOND,
  /** Wakes one recovery pass enqueues. */
  recoveryBatch: 10,
  /** Cleanup (cancel a running build) retries before it is left to the retention sweeps. */
  maxCleanupAttempts: 10,
  cleanupRetryMs: 60 * SECOND,
  /** Nonterminal deployments allowed per app and per workspace. */
  maxActivePerApp: 3,
  maxActivePerWorkspace: 10,
  /** M13: provisioning (identity, database, migrations, candidate) must finish within this. */
  provisionStageMs: 15 * 60 * SECOND,
  /** M13: a candidate must become ready and pass its checks within this. */
  checkStageMs: 10 * 60 * SECOND,
  /** M13: provider polls while a stage waits on a long-running operation. */
  stagePollMs: 5 * SECOND,
  /** M13: a replaced release's candidate keeps serving calls routed before the switch. */
  drainMs: 10 * 60 * SECOND,
});

export interface DeploymentRecord {
  readonly workspaceId: string;
  readonly appId: string;
  readonly deploymentId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly submission: DeploymentSubmission;
  readonly actorId: string;
  readonly state: DeploymentState;
  readonly stageAttempt: number;
  readonly expectedGeneration: number;
  /** The app's lifecycle fence captured at submission. */
  readonly lifecycleFence: number;
  readonly cancellationFence: number;
  readonly error?: PublicErrorCode;
  /** Operator-facing reason (internal code such as a build error), never public. */
  readonly reason?: string;
  readonly releaseId?: string;
  /** The admitted artifact (set when the build stage completes, or at submission for a rollback). */
  readonly artifactId?: string;
  /**
   * M13 rollback: the retained release whose artifact this deployment provisions afresh and
   * promotes as a new release. A rollback skips the build; every other stage runs as for a deploy.
   */
  readonly rollbackOf?: string;
  /** M13: the candidate the provisioning stage created, named and labelled from this record. */
  readonly candidate?: CandidateRef;
  /** When the current state was entered; bounds provisioning and readiness (M13). */
  readonly stageStartedAt?: string;
  /** Fencing token: advances on every claim, completion and cancellation. */
  readonly epoch: number;
  /** When work is next due (nonterminal), or cleanup is due (terminal with `cleanup`). */
  readonly dueAt: string;
  readonly leaseToken?: string;
  readonly leaseUntil?: string;
  /** Consecutive claims without a completion in this stage attempt. */
  readonly crashes: number;
  /** Transient failures while polling this stage attempt. */
  readonly failures: number;
  /** Terminal, but a build of this deployment may still be running and must be cancelled. */
  readonly cleanup: boolean;
  readonly cleanupAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deadlineAt: string;
  readonly retainUntil: string;
  readonly revision: number;
}

/** A deployed candidate: the provider resource name and its HTTPS origin (the app route). */
export interface CandidateRef {
  readonly service: string;
  readonly endpoint: string;
}

export interface ReleaseRecord {
  readonly workspaceId: string;
  readonly appId: string;
  readonly releaseId: string;
  readonly deploymentId: string;
  readonly artifactId: string;
  readonly imageReference: string;
  /** The generation this release was promoted at (the app's generation after promotion). */
  readonly generation: number;
  readonly manifest: ReleaseManifest;
  readonly createdAt: string;
  /**
   * M13: the catalog registration (route and manifest) this release serves, switched into the
   * catalog by the promotion transaction. Absent on releases promoted before M13.
   */
  readonly registration?: Registration;
  readonly candidate?: CandidateRef;
  /** The source upload this release was built from (pinned while the release is active). */
  readonly sourceUploadId?: string;
  /** Storage schema the release's framework needs (`BUILD_RECIPE.storageSchemaVersion`). */
  readonly schemaVersion?: number;
  /** Set when this release was promoted by a rollback to `rollbackOf`. */
  readonly rollbackOf?: string;
  /**
   * Lifecycle, set when another release replaces this one: the candidate keeps serving calls
   * routed before the switch until `drainUntil`, then the candidate sweep removes it; the
   * release stays a rollback target until `retainUntil` (MD15: inactive releases 30 days).
   */
  readonly inactiveSince?: string;
  readonly drainUntil?: string;
  readonly retainUntil?: string;
  /** The candidate was removed (after the drain); the release can still be rolled back to. */
  readonly candidateRemovedAt?: string;
}

export class DeploymentError extends Error {
  public constructor(public readonly code: PublicErrorCode) {
    super(publicError(code).message);
    this.name = "DeploymentError";
  }
}
/** A completion whose claim was superseded (another claim, a cancellation or a terminal state). */
export class StaleDeploymentError extends Error {
  public constructor() {
    super("Deployment claim superseded");
    this.name = "StaleDeploymentError";
  }
}

export const TERMINAL: ReadonlySet<DeploymentState> = new Set(["active", "failed", "cancelled"]);
const NEXT: Partial<Record<DeploymentState, DeploymentState>> = {
  accepted: "validating",
  validating: "building",
  building: "provisioning",
  provisioning: "checking",
  checking: "promoting",
};

// ---------------------------------------------------------------------------------------------
// Tasks. A task is only a wake-up: its body names a deployment and every decision is made from the
// platform record. Bodies are strict, carry no URLs, headers, resource names or credentials.

export const DEPLOYMENT_TASK_REASONS = [
  "submit",
  "lease",
  "due",
  "cancel",
  "cleanup",
  "recover",
  "follow-up",
] as const;
export const deploymentTaskSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal("deployment"),
  workspaceId: z.string().regex(/^ws_[a-z0-9]{8,64}$/),
  appId: z.string().regex(/^app_[a-z0-9]{8,64}$/),
  deploymentId: z.string().regex(/^dep_[a-z0-9]{8,64}$/),
  reason: z.enum(DEPLOYMENT_TASK_REASONS),
  /** The record epoch the task was created for; a later epoch means a newer wake exists. */
  epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /** PostgreSQL transaction that created the task (an early task retries while it is open). */
  txid: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
});
export type DeploymentTaskBody = z.infer<typeof deploymentTaskSchema>;
/** Largest accepted task body. */
export const MAX_DEPLOYMENT_TASK_BYTES = 1024;

/** A wake the store asks for, computed from the record it is about to commit. */
export interface DeploymentWake {
  readonly workspaceId: string;
  readonly appId: string;
  readonly deploymentId: string;
  readonly epoch: number;
  readonly reason: DeploymentTaskBody["reason"];
  readonly dueAt: string;
}
/** Called by a store inside the transaction, before COMMIT. A failure aborts the write. */
export type DeploymentWakeHook = (wakes: readonly DeploymentWake[], txid: string) => Promise<void>;

/** Deterministic: a retried transaction gets a new txid, so a new name (M20 rule). */
export function deploymentTaskName(wake: DeploymentWake, txid?: string): string {
  return deterministicTaskName(
    "dep",
    wake.workspaceId,
    wake.appId,
    wake.deploymentId,
    wake.epoch,
    wake.reason,
    wake.dueAt,
    txid,
  );
}
/** A follow-up scheduled by a delivered task: one per (task body, target), however often retried. */
export function followUpTaskName(body: DeploymentTaskBody, target: string): string {
  return deterministicTaskName(
    "depf",
    body.workspaceId,
    body.appId,
    body.deploymentId,
    body.reason,
    body.txid,
    target,
  );
}

/** The wake a committed record needs, if any. */
export function wakeFor(
  record: DeploymentRecord,
  reason: DeploymentTaskBody["reason"],
): DeploymentWake | undefined {
  if (TERMINAL.has(record.state) && !record.cleanup) return undefined;
  return {
    workspaceId: record.workspaceId,
    appId: record.appId,
    deploymentId: record.deploymentId,
    epoch: record.epoch,
    reason: TERMINAL.has(record.state) ? "cleanup" : reason,
    dueAt: record.dueAt,
  };
}

// ---------------------------------------------------------------------------------------------
// App view used by every decision: the catalog app is authoritative (M04 generation, M12 fence).

export interface AppControl {
  readonly generation: number;
  readonly lifecycleFence: number;
  readonly status: "enabled" | "disabled" | "deleted";
  readonly activeReleaseId: string | null;
}
export function appControl(app: CatalogApp | null | undefined): AppControl | null {
  if (!app) return null;
  return {
    generation: app.generation,
    lifecycleFence: app.lifecycleFence ?? 0,
    status: app.state === "deleted" ? "deleted" : app.state === "disabled" ? "disabled" : "enabled",
    activeReleaseId: app.activeRelease,
  };
}

// ---------------------------------------------------------------------------------------------
// Submission.

export interface SubmitInput {
  readonly submission: DeploymentSubmission;
  readonly fingerprint: string;
  readonly actorId: string;
  readonly now: Date;
}
export interface SubmitUsage {
  readonly activeForApp: number;
  readonly activeForWorkspace: number;
}
export type SubmitDecision =
  | { readonly replay: true; readonly record: DeploymentRecord }
  | {
      readonly replay: false;
      readonly record: Omit<DeploymentRecord, "revision">;
      /** The source record retained for the deployment's retention (CAS on its revision). */
      readonly source: SourceRecord;
    };

const iso = (ms: number) => new Date(ms).toISOString();
export const newDeploymentId = () => `dep_${randomBytes(12).toString("hex")}`;
export const newReleaseId = () => `rel_${randomBytes(12).toString("hex")}`;

/**
 * Same key and body replays the original deployment (even after it finished); a different body
 * conflicts. A new deployment needs an enabled app at the expected generation, a verified,
 * unexpired source of the same app whose digest and size match (M10 `verifySubmissionSource`
 * rules, re-checked inside the transaction) and room under the active-deployment limits.
 */
export function decideSubmit(input: {
  readonly existing: DeploymentRecord | null;
  readonly request: SubmitInput;
  readonly app: AppControl | null;
  readonly source: SourceRecord | null;
  readonly usage: SubmitUsage;
  readonly deploymentId: string;
}): SubmitDecision {
  const { existing, request, app, source } = input;
  if (existing) {
    if (existing.fingerprint !== request.fingerprint)
      throw new DeploymentError("IDEMPOTENCY_CONFLICT");
    return { replay: true, record: existing };
  }
  const { submission } = request;
  // Rollback deployments use derived keys (`rollbackKey`); a submission cannot occupy them.
  if (submission.idempotencyKey.startsWith(ROLLBACK_KEY_PREFIX))
    throw new DeploymentError("INVALID_INPUT");
  if (!app || app.status === "deleted") throw new DeploymentError("NOT_FOUND");
  if (app.status === "disabled") throw new DeploymentError("FORBIDDEN");
  if (submission.expectedGeneration !== app.generation)
    throw new DeploymentError("STALE_GENERATION");
  const now = request.now.getTime();
  if (
    !source ||
    source.purging ||
    source.workspaceId !== submission.workspaceId ||
    source.appId !== submission.appId ||
    source.state !== "verified" ||
    source.digest !== submission.source.digest ||
    source.bytes !== submission.source.bytes ||
    (Date.parse(source.retainUntil) <= now && !source.pinnedBy)
  )
    throw new DeploymentError("INVALID_INPUT");
  if (
    input.usage.activeForApp >= DEPLOYMENT_LIMITS.maxActivePerApp ||
    input.usage.activeForWorkspace >= DEPLOYMENT_LIMITS.maxActivePerWorkspace
  )
    throw new DeploymentError("LIMIT_EXCEEDED");
  const retainUntil = now + HOSTED_PROFILE.deploymentRetentionDays * DAY;
  const record: Omit<DeploymentRecord, "revision"> = {
    workspaceId: submission.workspaceId,
    appId: submission.appId,
    deploymentId: input.deploymentId,
    idempotencyKey: submission.idempotencyKey,
    fingerprint: request.fingerprint,
    submission,
    actorId: request.actorId,
    state: "accepted",
    stageAttempt: 1,
    expectedGeneration: submission.expectedGeneration,
    lifecycleFence: app.lifecycleFence,
    cancellationFence: 0,
    epoch: 1,
    dueAt: iso(now),
    crashes: 0,
    failures: 0,
    cleanup: false,
    cleanupAttempts: 0,
    createdAt: iso(now),
    updatedAt: iso(now),
    stageStartedAt: iso(now),
    deadlineAt: iso(now + DEPLOYMENT_LIMITS.deploymentDeadlineMs),
    retainUntil: iso(retainUntil),
  };
  // Retained as long as the deployment (MD15: 90 days), not pinned: the source sweep and the
  // workspace quota release it when that retention ends, whatever the deployment's outcome. The
  // build reads exactly this object long before then (deadline 2 h). Only a release pins source
  // indefinitely (promotion, below).
  const retained: SourceRecord = {
    ...source,
    retainUntil: iso(Math.max(Date.parse(source.retainUntil), retainUntil)),
  };
  return { replay: false, record, source: retained };
}

// ---------------------------------------------------------------------------------------------
// Rollback (M13 step 5). A rollback is a deployment of a retained release's admitted artifact: it
// skips the build, provisions a fresh candidate from the same digest, re-runs every check and
// promotes a new release through the same CAS, so concurrent deploys, cancellation and stale
// workers behave exactly as for a deploy (M13.c).

export const ROLLBACK_KEY_PREFIX = "rollback-";
/** One rollback per target and generation: a retry replays it, a later generation is new. */
export function rollbackKey(releaseId: string, generation: number): string {
  return `${ROLLBACK_KEY_PREFIX}${releaseId}-g${generation}`;
}
export interface RollbackInput {
  readonly workspaceId: string;
  readonly appId: string;
  readonly releaseId: string;
  readonly expectedGeneration: number;
  readonly actorId: string;
  readonly now: Date;
}
export type RollbackDecision =
  | { readonly replay: true; readonly record: DeploymentRecord }
  | {
      readonly replay: false;
      readonly record: Omit<DeploymentRecord, "revision">;
      /** The target's source and artifact, retained at least as long as this deployment. */
      readonly source: SourceRecord;
      readonly artifact: ArtifactRecord;
    };
/** Why a release cannot be rolled back to; the operator-facing reason, never public. */
export function rollbackRefusal(
  target: ReleaseRecord,
  app: AppControl,
  artifact: ArtifactRecord | null,
  source: SourceRecord | null,
  now: number,
): string | null {
  if (app.activeReleaseId === target.releaseId) return "ROLLBACK_TO_ACTIVE";
  if (!target.registration || !target.sourceUploadId) return "RELEASE_PREDATES_M13";
  if (!target.retainUntil || Date.parse(target.retainUntil) <= now) return "RELEASE_EXPIRED";
  if (
    !artifact ||
    artifact.purging ||
    artifact.state !== "admitted" ||
    artifact.appId !== target.appId ||
    artifact.artifactId !== target.artifactId ||
    artifact.imageReference !== target.imageReference
  )
    return "ARTIFACT_MISSING";
  if (
    !source ||
    source.purging ||
    source.state !== "verified" ||
    source.appId !== target.appId ||
    source.uploadId !== target.sourceUploadId ||
    (Date.parse(source.retainUntil) <= now && !source.pinnedBy)
  )
    return "SOURCE_MISSING";
  return null;
}
/**
 * Same key (target and generation) replays the rollback; otherwise the app must be enabled at
 * `expectedGeneration` and the target a retained, inactive release of this app whose artifact
 * and source are still kept. A target that is not is refused explicitly
 * (`ROLLBACK_INCOMPATIBLE`); schema and workflow compatibility are checked by the stages against
 * the app's database, and fail the rollback with the same code.
 */
export function decideRollback(input: {
  readonly existing: DeploymentRecord | null;
  readonly request: RollbackInput;
  readonly app: AppControl | null;
  readonly target: ReleaseRecord | null;
  /** The deployment that built the target (its submission is reused). */
  readonly origin: DeploymentRecord | null;
  readonly artifact: ArtifactRecord | null;
  readonly source: SourceRecord | null;
  readonly usage: SubmitUsage;
  readonly deploymentId: string;
}): RollbackDecision {
  const { request, app, target } = input;
  if (!app || app.status === "deleted") throw new DeploymentError("NOT_FOUND");
  if (!target || target.appId !== request.appId || target.workspaceId !== request.workspaceId)
    throw new DeploymentError("NOT_FOUND");
  const submission: DeploymentSubmission | undefined = input.origin
    ? {
        ...input.origin.submission,
        idempotencyKey: rollbackKey(target.releaseId, request.expectedGeneration),
        expectedGeneration: request.expectedGeneration,
      }
    : undefined;
  const fingerprint = submission ? submissionFingerprint(submission) : "";
  if (input.existing) {
    if (input.existing.rollbackOf !== target.releaseId || input.existing.fingerprint !== fingerprint)
      throw new DeploymentError("IDEMPOTENCY_CONFLICT");
    return { replay: true, record: input.existing };
  }
  if (app.status === "disabled") throw new DeploymentError("FORBIDDEN");
  if (request.expectedGeneration !== app.generation) throw new DeploymentError("STALE_GENERATION");
  const now = request.now.getTime();
  if (
    !submission ||
    input.origin?.appId !== target.appId ||
    rollbackRefusal(target, app, input.artifact, input.source, now) !== null
  )
    throw new DeploymentError("ROLLBACK_INCOMPATIBLE");
  if (
    input.usage.activeForApp >= DEPLOYMENT_LIMITS.maxActivePerApp ||
    input.usage.activeForWorkspace >= DEPLOYMENT_LIMITS.maxActivePerWorkspace
  )
    throw new DeploymentError("LIMIT_EXCEEDED");
  const retainUntil = now + HOSTED_PROFILE.deploymentRetentionDays * DAY;
  const record: Omit<DeploymentRecord, "revision"> = {
    workspaceId: request.workspaceId,
    appId: request.appId,
    deploymentId: input.deploymentId,
    idempotencyKey: submission.idempotencyKey,
    fingerprint,
    submission,
    actorId: request.actorId,
    state: "accepted",
    stageAttempt: 1,
    expectedGeneration: request.expectedGeneration,
    lifecycleFence: app.lifecycleFence,
    cancellationFence: 0,
    artifactId: target.artifactId,
    rollbackOf: target.releaseId,
    epoch: 1,
    dueAt: iso(now),
    crashes: 0,
    failures: 0,
    cleanup: false,
    cleanupAttempts: 0,
    createdAt: iso(now),
    updatedAt: iso(now),
    stageStartedAt: iso(now),
    deadlineAt: iso(now + DEPLOYMENT_LIMITS.deploymentDeadlineMs),
    retainUntil: iso(retainUntil),
  };
  // Keep what the rollback needs at least as long as the deployment record (as for a deploy); the
  // sweeps reclaim both afterwards unless the rollback's release pins them.
  const source = input.source!;
  const artifact = input.artifact!;
  return {
    replay: false,
    record,
    source: { ...source, retainUntil: iso(Math.max(Date.parse(source.retainUntil), retainUntil)) },
    artifact: {
      ...artifact,
      retainUntil: iso(Math.max(Date.parse(artifact.retainUntil), retainUntil)),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Claims.

export type ClaimDecision =
  | { readonly kind: "terminal" }
  | { readonly kind: "cleanup"; readonly record: DeploymentRecord }
  | { readonly kind: "leased"; readonly until: string; readonly epoch: number }
  | { readonly kind: "early"; readonly dueAt: string; readonly epoch: number }
  /** Committed without running a stage: deadline expiry or a crash-loop retry. */
  | { readonly kind: "settled"; readonly next: DeploymentRecord; readonly wake?: DeploymentWake }
  | { readonly kind: "claimed"; readonly next: DeploymentRecord; readonly wake: DeploymentWake };

const RETRYABLE: ReadonlySet<DeploymentState> = new Set([
  "validating",
  "building",
  "provisioning",
  "checking",
  "promoting",
]);
/** Stages after which a build or provisioned candidate may exist. */
const CLEANUP_STATES: ReadonlySet<DeploymentState> = new Set([
  "building",
  "provisioning",
  "checking",
  "promoting",
]);
function retryDelayMs(attempt: number): number {
  const delays = HOSTED_PROFILE.retryDelaySeconds;
  return delays[Math.min(attempt, delays.length) - 1]! * SECOND;
}
function settled(
  prior: DeploymentRecord,
  changes: Partial<DeploymentRecord>,
  now: number,
): DeploymentRecord {
  const next: DeploymentRecord = {
    ...prior,
    epoch: prior.epoch + 1,
    crashes: 0,
    updatedAt: iso(now),
    ...changes,
    ...(changes.state !== undefined && changes.state !== prior.state
      ? { stageStartedAt: iso(now) }
      : {}),
    revision: prior.revision + 1,
  };
  const { leaseToken: _token, leaseUntil: _until, ...rest } = next;
  void _token;
  void _until;
  const result = rest as DeploymentRecord;
  if (result.state !== prior.state || result.stageAttempt !== prior.stageAttempt)
    // M02 transition rules: forward one stage, retry the same stage with attempt + 1, or end.
    DeploymentTransitionSchema.parse({
      version: 1,
      workspaceId: prior.workspaceId,
      appId: prior.appId,
      deploymentId: prior.deploymentId,
      from: prior.state,
      to: result.state,
      attempt: prior.stageAttempt,
      nextAttempt: result.stageAttempt,
    });
  return result;
}
function failed(
  prior: DeploymentRecord,
  code: PublicErrorCode,
  reason: string,
  now: number,
): DeploymentRecord {
  return settled(
    prior,
    {
      state: "failed",
      stageAttempt: 1,
      error: code,
      reason,
      // A build or candidate of this deployment may still exist: cancel/remove it promptly.
      cleanup: CLEANUP_STATES.has(prior.state),
      cleanupAttempts: 0,
      dueAt: iso(now),
    },
    now,
  );
}
/** Transient stage failure: the next attempt after the M02 delay, or a visible failure. */
function retried(
  prior: DeploymentRecord,
  reason: string,
  now: number,
  code: PublicErrorCode = "DEPENDENCY_UNAVAILABLE",
): DeploymentRecord {
  if (!RETRYABLE.has(prior.state) || prior.stageAttempt >= HOSTED_PROFILE.maxStageAttempts)
    return failed(prior, code, reason, now);
  return settled(
    prior,
    {
      stageAttempt: prior.stageAttempt + 1,
      failures: 0,
      reason,
      dueAt: iso(now + retryDelayMs(prior.stageAttempt)),
    },
    now,
  );
}

export function decideClaim(record: DeploymentRecord, now: Date, token: string): ClaimDecision {
  const ms = now.getTime();
  if (TERMINAL.has(record.state))
    return record.cleanup && Date.parse(record.dueAt) <= ms
      ? { kind: "cleanup", record }
      : record.cleanup
        ? { kind: "early", dueAt: record.dueAt, epoch: record.epoch }
        : { kind: "terminal" };
  if (record.leaseUntil && Date.parse(record.leaseUntil) > ms)
    return { kind: "leased", until: record.leaseUntil, epoch: record.epoch };
  if (ms >= Date.parse(record.deadlineAt)) {
    const next = failed(record, "DEPENDENCY_UNAVAILABLE", "DEADLINE_EXCEEDED", ms);
    const wake = wakeFor(next, "cleanup");
    return { kind: "settled", next, ...(wake ? { wake } : {}) };
  }
  if (Date.parse(record.dueAt) > ms)
    return { kind: "early", dueAt: record.dueAt, epoch: record.epoch };
  if (record.crashes >= DEPLOYMENT_LIMITS.maxCrashes) {
    // Workers keep dying (or timing out) in this stage attempt: count it as a failed attempt.
    const next = retried(record, "WORKER_LOST", ms);
    const wake = wakeFor(next, "due");
    return { kind: "settled", next, ...(wake ? { wake } : {}) };
  }
  const until = iso(ms + DEPLOYMENT_LIMITS.leaseMs);
  const next: DeploymentRecord = {
    ...record,
    epoch: record.epoch + 1,
    leaseToken: token,
    leaseUntil: until,
    crashes: record.crashes + 1,
    updatedAt: iso(ms),
    revision: record.revision + 1,
  };
  // The lease wake reclaims the deployment if this worker dies (M20 lease-wake rule).
  return {
    kind: "claimed",
    next,
    wake: { ...wakeFor(next, "lease")!, dueAt: iso(ms + DEPLOYMENT_LIMITS.leaseMs + SECOND) },
  };
}

// ---------------------------------------------------------------------------------------------
// Completions.

export type StageOutcome =
  /** The stage finished: move to the next stage. */
  | { readonly kind: "advance"; readonly artifactId?: string; readonly candidate?: CandidateRef }
  /** Still running (a build, a provider operation): look again after `delayMs`, same attempt. */
  | { readonly kind: "poll"; readonly delayMs: number }
  /** A transient error while polling: back off, same attempt, bounded by `maxPollFailures`. */
  | { readonly kind: "poll-error"; readonly reason: string }
  /** The attempt failed transiently: next attempt after the M02 delay, or fail. */
  | { readonly kind: "retry"; readonly reason: string }
  /** Permanent failure with a public code. */
  | { readonly kind: "fail"; readonly code: PublicErrorCode; readonly reason: string }
  /**
   * Promotion CAS (promoting stage only). M13 carries the registration (route and manifest) the
   * transaction switches into the catalog; without one the catalog registration is unchanged.
   */
  | { readonly kind: "promote"; readonly releaseId: string; readonly registration?: Registration };

export interface CompletionFence {
  readonly workspaceId: string;
  readonly appId: string;
  readonly deploymentId: string;
  readonly epoch: number;
  readonly leaseToken: string;
}
export type CompleteDecision =
  | { readonly next: DeploymentRecord; readonly wake?: DeploymentWake; readonly promote?: never }
  | {
      readonly next: DeploymentRecord;
      readonly wake?: undefined;
      /** Store writes these in the same transaction: release, app pointer/generation, pin. */
      readonly promote: {
        readonly releaseId: string;
        readonly generation: number;
        readonly registration?: Registration;
      };
    };

/**
 * Applies a stage outcome under the claim's fence. Every transition re-validates the workspace,
 * the claim (epoch and lease token) and the app: a disabled, deleted or re-generated app (its
 * lifecycle fence or generation moved since submission) fails the deployment, so no stale worker
 * advances it, and promotion is the `canPromote` CAS inside the store's transaction.
 */
export function decideComplete(input: {
  readonly record: DeploymentRecord;
  readonly fence: CompletionFence;
  readonly outcome: StageOutcome;
  readonly app: AppControl | null;
  readonly now: Date;
}): CompleteDecision {
  const { record, fence, outcome, app } = input;
  const ms = input.now.getTime();
  if (
    record.workspaceId !== fence.workspaceId ||
    record.appId !== fence.appId ||
    record.deploymentId !== fence.deploymentId ||
    record.epoch !== fence.epoch ||
    record.leaseToken !== fence.leaseToken ||
    TERMINAL.has(record.state)
  )
    throw new StaleDeploymentError();
  const withWake = (next: DeploymentRecord): CompleteDecision => {
    const wake = wakeFor(next, "due");
    return wake ? { next, wake } : { next };
  };
  const appMoved =
    !app ||
    app.status !== "enabled" ||
    app.lifecycleFence !== record.lifecycleFence ||
    app.generation !== record.expectedGeneration;
  if (outcome.kind === "fail") return withWake(failed(record, outcome.code, outcome.reason, ms));
  if (appMoved) return withWake(failed(record, "STALE_GENERATION", "APP_CHANGED", ms));
  switch (outcome.kind) {
    case "advance": {
      const to = NEXT[record.state];
      if (!to) throw new TypeError(`No stage follows ${record.state}`);
      return withWake(
        settled(
          record,
          {
            state: to,
            stageAttempt: 1,
            failures: 0,
            dueAt: iso(ms),
            ...(outcome.artifactId ? { artifactId: outcome.artifactId } : {}),
            ...(outcome.candidate ? { candidate: outcome.candidate } : {}),
          },
          ms,
        ),
      );
    }
    case "poll":
      return withWake(settled(record, { failures: 0, dueAt: iso(ms + outcome.delayMs) }, ms));
    case "poll-error": {
      if (record.failures + 1 >= DEPLOYMENT_LIMITS.maxPollFailures)
        return withWake(retried(record, outcome.reason, ms));
      const backoff = Math.min(DEPLOYMENT_LIMITS.buildPollMs * 2 ** record.failures, 120 * SECOND);
      return withWake(
        settled(
          record,
          { failures: record.failures + 1, reason: outcome.reason, dueAt: iso(ms + backoff) },
          ms,
        ),
      );
    }
    case "retry":
      return withWake(retried(record, outcome.reason, ms));
    case "promote": {
      if (
        !canPromote(
          {
            expectedGeneration: record.expectedGeneration,
            lifecycleFence: record.lifecycleFence,
            cancellationFence: record.cancellationFence,
          },
          {
            generation: app.generation,
            lifecycleFence: app.lifecycleFence,
            enabled: app.status === "enabled",
          },
          { cancellationFence: record.cancellationFence, state: record.state },
        )
      )
        return withWake(failed(record, "STALE_GENERATION", "PROMOTION_CAS", ms));
      const next = settled(
        record,
        { state: "active", stageAttempt: 1, releaseId: outcome.releaseId, dueAt: iso(ms) },
        ms,
      );
      return {
        next,
        promote: {
          releaseId: outcome.releaseId,
          generation: app.generation + 1,
          ...(outcome.registration ? { registration: outcome.registration } : {}),
        },
      };
    }
  }
}

/**
 * Cancellation targets one deployment: a matching fence on a nonterminal deployment advances the
 * fence and the epoch (invalidating any claim) and ends it `cancelled` in one transaction. A
 * repeated cancel returns the cancelled record without advancing the fence again; cancelling a
 * deployment that already became active or failed conflicts.
 */
export function decideCancel(
  record: DeploymentRecord,
  cancellationFence: number,
  now: Date,
): { readonly changed: boolean; readonly next: DeploymentRecord; readonly wake?: DeploymentWake } {
  if (record.state === "cancelled") return { changed: false, next: record };
  if (!canCancel({ cancellationFence }, record)) throw new DeploymentError("STALE_GENERATION");
  const ms = now.getTime();
  const { error: _error, ...rest } = record;
  void _error;
  const next = settled(
    rest,
    {
      state: "cancelled",
      stageAttempt: 1,
      cancellationFence: record.cancellationFence + 1,
      reason: "CANCELLED",
      cleanup: CLEANUP_STATES.has(record.state),
      cleanupAttempts: 0,
      dueAt: iso(ms),
    },
    ms,
  );
  const wake = wakeFor(next, "cancel");
  return { changed: true, next, ...(wake ? { wake } : {}) };
}

/** After a cleanup pass: done, or retried later (bounded; the retention sweeps are the backstop). */
export function decideCleanup(
  record: DeploymentRecord,
  epoch: number,
  done: boolean,
  now: Date,
): { readonly next: DeploymentRecord; readonly wake?: DeploymentWake } | null {
  if (!record.cleanup || record.epoch !== epoch) return null;
  const ms = now.getTime();
  const attempts = record.cleanupAttempts + 1;
  const finished = done || attempts >= DEPLOYMENT_LIMITS.maxCleanupAttempts;
  const next: DeploymentRecord = {
    ...record,
    epoch: record.epoch + 1,
    cleanup: !finished,
    cleanupAttempts: attempts,
    dueAt: iso(finished ? ms : ms + DEPLOYMENT_LIMITS.cleanupRetryMs),
    updatedAt: iso(ms),
    revision: record.revision + 1,
  };
  const wake = wakeFor(next, "cleanup");
  return wake ? { next, wake } : { next };
}

/** Nonterminal deployments (or pending cleanups) overdue with no live lease (MD12 recovery). */
export function isOverdue(record: DeploymentRecord, now: Date): boolean {
  const limit = now.getTime() - DEPLOYMENT_LIMITS.recoveryGraceMs;
  if (TERMINAL.has(record.state) && !record.cleanup) return false;
  return (
    Date.parse(record.dueAt) < limit &&
    (record.leaseUntil === undefined || Date.parse(record.leaseUntil) < limit)
  );
}

/**
 * The deployment's own source, still live: promotion pins it to the release in the same
 * transaction (MD15: an active release keeps its source indefinitely), so a release never points
 * at source the sweep may delete.
 */
export function releaseSourceUsable(
  record: DeploymentRecord,
  source: SourceRecord | null | undefined,
): source is SourceRecord {
  return (
    !!source &&
    !source.purging &&
    source.workspaceId === record.workspaceId &&
    source.appId === record.appId &&
    source.uploadId === record.submission.source.uploadId &&
    source.state === "verified" &&
    source.digest === record.submission.source.digest &&
    source.bytes === record.submission.source.bytes
  );
}

/** Release manifest for a promoted deployment, validated against the M02 contract. */
export function releaseManifest(
  record: DeploymentRecord,
  artifact: ArtifactRecord,
  releaseId: string,
): ReleaseManifest {
  return ReleaseManifestSchema.parse({
    version: 1,
    workspaceId: record.workspaceId,
    appId: record.appId,
    releaseId,
    deploymentId: record.deploymentId,
    sourceDigest: record.submission.source.digest,
    imageDigest: artifact.imageDigest,
    scaffold: HOSTED_PROFILE.scaffold,
    nodeMajor: artifact.manifest?.nodeMajor,
    capabilities: record.submission.capabilities,
    artifact: artifact.manifest,
    secretReferences: record.submission.secretReferences,
  });
}

/** Storage schema an artifact's framework needs: the one its pinned recipe bundles. */
export function recipeSchemaVersion(recipe: string): number {
  if (recipe !== BUILD_RECIPE.id) throw new TypeError("Unknown build recipe");
  return BUILD_RECIPE.storageSchemaVersion;
}

/** The artifact a deployment may promote: its own build, or a rollback's target artifact. */
export function promotableArtifact(
  record: DeploymentRecord,
  artifact: ArtifactRecord | null | undefined,
): artifact is ArtifactRecord {
  return (
    !!artifact &&
    !artifact.purging &&
    artifact.state === "admitted" &&
    !!artifact.imageReference &&
    artifact.workspaceId === record.workspaceId &&
    artifact.appId === record.appId &&
    artifact.artifactId === record.artifactId &&
    (record.rollbackOf !== undefined || artifact.deploymentId === record.deploymentId)
  );
}

/** The catalog namespace (`registration.appId`) of an app: platform data, never a build claim. */
export function catalogName(app: CatalogApp): string | undefined {
  return app.name ?? app.registration?.appId;
}

/**
 * What the promotion transaction may switch into the catalog. The registration must name the
 * app's own namespace and route to this deployment's candidate; a reserved app (no registration
 * yet) needs one. `validate` is the store's registration policy (M04/M06 checks). Returns the
 * failure reason, or null.
 */
export function registrationRefusal(
  record: DeploymentRecord,
  app: CatalogApp,
  registration: Registration | undefined,
  validate: (registration: Registration) => void,
): string | null {
  if (!registration) return app.registration ? null : "REGISTRATION_MISSING";
  if (registration.appId !== catalogName(app)) return "REGISTRATION_INVALID";
  if (!record.candidate || registration.endpoint !== record.candidate.endpoint)
    return "REGISTRATION_INVALID";
  try {
    validate(registration);
  } catch {
    return "REGISTRATION_INVALID";
  }
  return null;
}

/** The release record a promotion inserts. */
export function promotedRelease(
  record: DeploymentRecord,
  artifact: ArtifactRecord,
  promote: { readonly releaseId: string; readonly generation: number; readonly registration?: Registration },
  schemaVersion: number,
  now: Date,
): ReleaseRecord {
  return {
    workspaceId: record.workspaceId,
    appId: record.appId,
    releaseId: promote.releaseId,
    deploymentId: record.deploymentId,
    artifactId: artifact.artifactId,
    imageReference: artifact.imageReference!,
    generation: promote.generation,
    manifest: releaseManifest(record, artifact, promote.releaseId),
    createdAt: now.toISOString(),
    ...(promote.registration ? { registration: promote.registration } : {}),
    ...(record.candidate ? { candidate: record.candidate } : {}),
    sourceUploadId: record.submission.source.uploadId,
    schemaVersion,
    ...(record.rollbackOf ? { rollbackOf: record.rollbackOf } : {}),
  };
}

/**
 * The catalog after promotion: the active release, the generation step and, in the same write,
 * the release's route and manifest (M13.a). A reserved app becomes `idle` (dispatchable, woken
 * on demand); any other state is kept. Runtime state never moves the generation elsewhere.
 */
export function promotedCatalog(
  app: CatalogApp,
  release: ReleaseRecord,
  generation: number,
): CatalogApp {
  return {
    ...app,
    ...(release.registration ? { registration: release.registration } : {}),
    activeRelease: release.releaseId,
    state: app.state === "unavailable" && app.activeRelease === null ? "idle" : app.state,
    generation,
    revision: app.revision + 1,
  };
}

const INACTIVE_RETENTION_MS = HOSTED_PROFILE.inactiveReleaseRetentionDays * DAY;
/**
 * A release another promotion replaced: its candidate drains, then the candidate sweep removes
 * it; the release stays a rollback target for 30 days (MD15), as do its artifact and source.
 */
export function replacedRelease(prior: ReleaseRecord, now: Date): ReleaseRecord {
  const ms = now.getTime();
  return {
    ...prior,
    inactiveSince: iso(ms),
    drainUntil: iso(ms + DEPLOYMENT_LIMITS.drainMs),
    retainUntil: iso(ms + INACTIVE_RETENTION_MS),
  };
}
/**
 * Unpins an artifact or source the replaced release pinned (M12 re-review N1, M13 step 4): it
 * stays for the inactive release's 30 days and the ordinary sweeps reclaim it afterwards, so the
 * workspace source quota stops counting it then. Pins held by another release are untouched, and
 * the new release re-pins what it shares in the same transaction. Null when nothing changes.
 */
export function releasedPin<T extends { readonly pinnedBy?: string; readonly retainUntil: string }>(
  record: T,
  releaseId: string,
  now: Date,
): T | null {
  if (record.pinnedBy !== releaseId) return null;
  const { pinnedBy: _pin, ...rest } = record;
  void _pin;
  return {
    ...rest,
    retainUntil: iso(Math.max(Date.parse(record.retainUntil), now.getTime() + INACTIVE_RETENTION_MS)),
  } as unknown as T;
}

/** Public status: fixed error messages, no reasons, leases or provider names. */
export function deploymentStatus(record: DeploymentRecord): DeploymentStatus {
  return {
    version: 1,
    workspaceId: record.workspaceId as DeploymentStatus["workspaceId"],
    appId: record.appId as DeploymentStatus["appId"],
    deploymentId: record.deploymentId as DeploymentStatus["deploymentId"],
    ...(record.releaseId ? { releaseId: record.releaseId as DeploymentStatus["releaseId"] } : {}),
    sourceDigest: record.submission.source.digest,
    state: record.state,
    stageAttempt: record.stageAttempt,
    expectedGeneration: record.expectedGeneration,
    cancellationFence: record.cancellationFence,
    lifecycleFence: record.lifecycleFence,
    ...(record.state === "failed" ? { error: publicError(record.error ?? "BUILD_FAILED") } : {}),
  };
}

/** Persistence for M12; implemented by the memory and PostgreSQL gateway stores. */
export interface DeploymentStore {
  /** Atomic: idempotency, app/source checks, source retention, insert, wake before commit. */
  submitDeployment(
    input: SubmitInput,
    wake: DeploymentWakeHook,
  ): Promise<{ readonly record: DeploymentRecord; readonly replay: boolean }>;
  deployment(
    workspaceId: string,
    appId: string,
    deploymentId: string,
  ): Promise<DeploymentRecord | null>;
  /** Locks the record, decides, commits the claim/settlement and its wake. */
  claimDeployment(
    key: { readonly workspaceId: string; readonly appId: string; readonly deploymentId: string },
    now: Date,
    wake: DeploymentWakeHook,
  ): Promise<{ readonly decision: ClaimDecision | { readonly kind: "missing" } }>;
  /** Fenced completion; StaleDeploymentError when the claim was superseded. */
  completeDeployment(
    fence: CompletionFence,
    outcome: StageOutcome,
    now: Date,
    wake: DeploymentWakeHook,
  ): Promise<DeploymentRecord>;
  /**
   * M13 rollback: atomic like a submission (idempotency by target and generation, app and
   * target checks, retention of the target's artifact and source, insert, wake before commit).
   */
  submitRollback(
    input: RollbackInput,
    wake: DeploymentWakeHook,
  ): Promise<{ readonly record: DeploymentRecord; readonly replay: boolean }>;
  /** The release a deployment promoted, if any (candidate sweep). */
  releaseForDeployment(
    workspaceId: string,
    appId: string,
    deploymentId: string,
  ): Promise<ReleaseRecord | null>;
  /** Records that a replaced release's candidate was removed after its drain. */
  markCandidateRemoved(
    workspaceId: string,
    appId: string,
    releaseId: string,
    now: Date,
  ): Promise<void>;
  cancelDeployment(
    key: { readonly workspaceId: string; readonly appId: string; readonly deploymentId: string },
    cancellationFence: number,
    now: Date,
    wake: DeploymentWakeHook,
  ): Promise<{ readonly record: DeploymentRecord; readonly changed: boolean }>;
  finishCleanup(
    key: { readonly workspaceId: string; readonly appId: string; readonly deploymentId: string },
    epoch: number,
    done: boolean,
    now: Date,
    wake: DeploymentWakeHook,
  ): Promise<void>;
  appStatus(workspaceId: string, appId: string): Promise<AppControl | null>;
  release(workspaceId: string, appId: string, releaseId: string): Promise<ReleaseRecord | null>;
  /** Overdue deployments, oldest due first, optionally within one workspace. */
  overdueDeployments(
    now: Date,
    limit: number,
    workspaceId?: string,
  ): Promise<readonly DeploymentRecord[]>;
  /** Outcome of the transaction that created a task (PostgreSQL `txid_status`). */
  transactionStatus(txid: string): Promise<"in-progress" | "committed" | "aborted" | "unknown">;
}
