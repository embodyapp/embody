import { createHash, randomBytes } from "node:crypto";
import { appManifestSchema } from "@embody/core";
import {
  BUILD_RECIPE,
  BuildOutputSchema,
  HOSTED_PROFILE,
  type ArtifactManifest,
} from "@embody/cloud-contracts";
import { validateRegistration, type Registration } from "./index.js";
import {
  BuildOutputTooLargeError,
  catalogDigestOf,
  type ArtifactRecord,
  type BuildProvider,
} from "./build-admission.js";
import {
  TERMINAL,
  recipeSchemaVersion,
  type CandidateRef,
  type DeploymentRecord,
  type DeploymentStore,
  type ReleaseRecord,
} from "./deployment.js";
import type {
  CandidateSweeper,
  DeploymentStageContext,
  DeploymentStages,
  PromoteResult,
  StageResult,
} from "./deployment-controller.js";

/**
 * M13 provisioning, readiness checks, promotion preparation and candidate retirement against
 * provider ports (Cloud Run, IAM/Secret Manager/Cloud Tasks and the shared Cloud SQL instance in
 * production, memory fakes in tests). Every provider resource is named and labelled from platform
 * records (workspace, app, deployment), never from task input or build output, so a re-run after
 * a crash adopts what an earlier run created, and removal is ownership-checked.
 * See docs/mvp/RELEASES.md.
 */

// ---------------------------------------------------------------------------------------------
// Names. Deterministic, provider-safe and short: hashes of platform IDs plus a platform prefix,
// so two workspaces' apps never share a name and nothing a customer controls appears in one.

const PREFIX = /^[a-z][a-z0-9]{1,7}$/;
const hash = (value: string, length: number) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);
/** Per-app resources: created once, kept for the app's lifetime (removed by app delete, M15). */
export interface AppResourceNames {
  /** Runtime service account ID (no project roles; its own secret and queue only). */
  readonly runtimeAccount: string;
  /** Wake-task invoker service account ID (durable profile; invokes only this app). */
  readonly invokerAccount: string;
  /** Secret holding the runtime `DATABASE_URL`. */
  readonly databaseSecret: string;
  readonly database: string;
  /** Owns the schema; no login. Migrations run as it, never the runtime. */
  readonly ownerRole: string;
  /** The app runtime's login role: DML and the storage runtime functions only. */
  readonly runtimeRole: string;
  /** Cloud Tasks wake queue (durable profile). */
  readonly wakeQueue: string;
}
export function appResourceNames(
  prefix: string,
  workspaceId: string,
  appId: string,
): AppResourceNames {
  if (!PREFIX.test(prefix)) throw new TypeError("Invalid platform resource prefix");
  const key = hash(`${workspaceId}/${appId}`, 16);
  return {
    runtimeAccount: `${prefix}-a${key}`,
    invokerAccount: `${prefix}-w${key}`,
    databaseSecret: `${prefix}-a${key}-db`,
    database: `embody_${prefix}_a${key}`,
    ownerRole: `embody_${prefix}_a${key}_o`,
    runtimeRole: `embody_${prefix}_a${key}_r`,
    wakeQueue: `${prefix}-a${key}`,
  };
}
/** Owner label value: binds a candidate to exactly one workspace, app and deployment. */
export function candidateOwner(record: {
  readonly workspaceId: string;
  readonly appId: string;
  readonly deploymentId: string;
}): string {
  return hash(`${record.workspaceId}/${record.appId}/${record.deploymentId}`, 24);
}
export function candidateName(
  prefix: string,
  record: { readonly workspaceId: string; readonly appId: string; readonly deploymentId: string },
): string {
  if (!PREFIX.test(prefix)) throw new TypeError("Invalid platform resource prefix");
  return `${prefix}-c${candidateOwner(record)}`;
}
export const CANDIDATE_LABELS = Object.freeze({
  platform: "embody-platform",
  role: "embody-role",
  owner: "embody-owner",
});
export const CANDIDATE_ANNOTATIONS = Object.freeze({
  workspace: "embody.dev/workspace",
  app: "embody.dev/app",
  deployment: "embody.dev/deployment",
});

// ---------------------------------------------------------------------------------------------
// Ports.

export interface CandidateEnv {
  readonly name: string;
  readonly value?: string;
  /** Secret Manager reference (resolved by the provider at instance start, never logged). */
  readonly secret?: { readonly secret: string; readonly version: string };
}
export interface CandidateSpec {
  readonly name: string;
  /** Digest form only (`repo@sha256:…`), the admitted artifact's `imageReference`. */
  readonly image: string;
  readonly serviceAccount: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly env: readonly CandidateEnv[];
  readonly maxInstances: number;
  readonly cloudSqlConnection?: string;
}
export interface CandidateState {
  readonly name: string;
  readonly endpoint?: string;
  readonly image?: string;
  /** `pending` while the provider deploys; `failed` when the revision cannot become ready. */
  readonly status: "ready" | "pending" | "failed";
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
}
export interface CandidateProvider {
  get(name: string, signal: AbortSignal): Promise<CandidateState | null>;
  /** Starts creation; an existing name is not an error (the caller adopts it after checking). */
  create(spec: CandidateSpec, signal: AbortSignal): Promise<void>;
  /** Replaces the invoker binding with exactly these members (idempotent). */
  setInvokers(name: string, members: readonly string[], signal: AbortSignal): Promise<void>;
  /** Callers verify ownership first. Missing is success. */
  remove(name: string, signal: AbortSignal): Promise<void>;
  /** Candidates carrying this platform's labels (bounded by the provider page size). */
  list(signal: AbortSignal): Promise<readonly CandidateState[]>;
}
export interface AppIdentityProvider {
  /** Creates or adopts the runtime identity; `pending` while the provider propagates it. */
  ensureAccount(
    accountId: string,
    displayName: string,
    signal: AbortSignal,
  ): Promise<{ readonly email: string } | "pending">;
  /**
   * The Cloud SQL connector authorizes by identity: the runtime needs `roles/cloudsql.client`
   * on the project. Database access itself stays per app (its own role, password and database).
   * The controller may grant this one role and no other (conditional project IAM admin).
   */
  ensureDatabaseClient(email: string, signal: AbortSignal): Promise<void>;
  /** Creates or adopts the secret; its only accessor is `accessorEmail`. */
  ensureSecret(secretId: string, accessorEmail: string, signal: AbortSignal): Promise<void>;
  /** Name of the newest enabled version (metadata only: the controller never reads payloads). */
  latestSecretVersion(secretId: string, signal: AbortSignal): Promise<string | null>;
  addSecretVersion(secretId: string, payload: string, signal: AbortSignal): Promise<string>;
  /**
   * Durable profile: the app's own wake queue and invoker. The runtime may enqueue only on its
   * queue and act only as its invoker; the invoker may invoke only this app's candidates.
   */
  ensureWakeQueue(
    queueId: string,
    invokerAccount: string,
    runtimeEmail: string,
    signal: AbortSignal,
  ): Promise<{ readonly queue: string; readonly invokerEmail: string } | "pending">;
}
export interface WorkflowVersionInUse {
  readonly definition: string;
  readonly version: string;
  readonly instances: number;
}
/** The shared Cloud SQL instance, through a provisioner role (CREATEDB, CREATEROLE, no superuser). */
export interface AppDatabase {
  /** Database, owner and runtime roles, schema grants; idempotent. */
  ensure(names: AppResourceNames): Promise<void>;
  /** Which secret version the runtime role's password matches (a role comment), if any. */
  credentialMarker(names: AppResourceNames): Promise<string | null>;
  /** Sets the runtime password and its marker in one transaction. */
  setCredential(names: AppResourceNames, password: string, marker: string): Promise<void>;
  /** The runtime connection URL the secret holds. */
  runtimeUrl(names: AppResourceNames, password: string): string;
  /** Applied storage migration versions, ascending. */
  appliedMigrations(names: AppResourceNames): Promise<readonly number[]>;
  /**
   * Applies the next pending migration up to `target` (one bounded transaction under the owner
   * role, then the runtime grants), after re-checking the policy under an advisory lock.
   */
  applyNextMigration(names: AppResourceNames, target: number): Promise<"applied" | "current">;
  /** `embody_active_workflow_versions()`: versions with running or retryable instances. */
  activeWorkflowVersions(names: AppResourceNames): Promise<readonly WorkflowVersionInUse[]>;
}
/** Readiness of a candidate: its `/health` answers `ready: true` (kernel booted, schema verified). */
export interface HealthProbe {
  ready(endpoint: string, signal: AbortSignal): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------
// Policy.

export interface MigrationPolicyEntry {
  readonly version: number;
  readonly compatibility: "expand" | "contract";
  readonly readerFloor?: number;
}
/**
 * Decides a migration plan before anything executes (M13 step 2): every pending migration up to
 * `target` must be `expand` (a `contract` one would change data the serving release reads, so it
 * is refused and nothing runs), and a reader built for `target` must not be below the floor an
 * applied migration set (an incompatible rollback). Unknown applied versions above the policy
 * mean this controller is older than the database: refuse rather than guess.
 */
export function migrationRefusal(
  applied: readonly number[],
  target: number,
  policy: readonly MigrationPolicyEntry[],
): string | null {
  const known = new Map(policy.map((entry) => [entry.version, entry]));
  if (applied.some((version) => !known.has(version))) return "SCHEMA_AHEAD";
  for (const entry of policy)
    if (
      entry.version <= target &&
      !applied.includes(entry.version) &&
      entry.compatibility !== "expand"
    )
      return "MIGRATION_REJECTED";
  const floor = Math.max(0, ...applied.map((version) => known.get(version)?.readerFloor ?? 0));
  if (target < floor) return "SCHEMA_INCOMPATIBLE";
  return null;
}

const graph = (steps: readonly { name: string; dependsOn: readonly string[] }[]) =>
  JSON.stringify(
    [...steps]
      .map((step) => [step.name, [...step.dependsOn].sort()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
/**
 * M13 step 6: a release must keep every workflow definition version that still has running or
 * retryable instances, unchanged, so they finish on the code they started on (the engine refuses
 * to run an instance whose `definition@version` is not in the serving code). The same version
 * with a different step graph is refused too: a version names one graph.
 */
export function workflowRefusal(
  inUse: readonly WorkflowVersionInUse[],
  next: ArtifactManifest | undefined,
  active: ArtifactManifest | undefined,
): string | null {
  for (const used of inUse) {
    if (used.instances <= 0) continue;
    const kept = next?.workflows.find(
      (workflow) => workflow.target === used.definition && workflow.version === used.version,
    );
    if (!kept) return "WORKFLOW_VERSION_IN_USE";
    const serving = active?.workflows.find(
      (workflow) => workflow.target === used.definition && workflow.version === used.version,
    );
    if (serving && graph(serving.steps) !== graph(kept.steps)) return "WORKFLOW_VERSION_CHANGED";
  }
  return null;
}

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
/**
 * The registration a release serves: the catalog re-read from the retained `manifest.json`,
 * bound to the artifact's `manifestDigest` and `catalogDigest` (BUILDS follow-up: the artifact
 * keeps only digests). The namespace is the platform's app name, never the build's `appId` claim;
 * the route is the candidate's origin. Returns a failure reason instead of throwing.
 */
export async function releaseRegistration(input: {
  readonly artifact: ArtifactRecord;
  readonly name: string;
  readonly endpoint: string;
  readonly readOutput: BuildProvider["readOutput"];
}): Promise<Registration | string> {
  const { artifact } = input;
  if (!artifact.manifest || !artifact.manifestDigest) return "MANIFEST_MISSING";
  let bytes: Uint8Array | null;
  try {
    bytes = await input.readOutput(
      `${artifact.outputPrefix}manifest.json`,
      BUILD_RECIPE.maxManifestBytes,
    );
  } catch (error) {
    if (error instanceof BuildOutputTooLargeError) return "MANIFEST_MISMATCH";
    throw error;
  }
  if (!bytes) return "MANIFEST_MISSING";
  // The build's app name is a claim and never identity: the platform name is. But the hosted host
  // verifies the gateway's principal tokens against its own `defineApp({ appId })`, and the gateway
  // issues them for the platform name, so a release whose built name differs could serve no call.
  if (artifact.manifest.appId !== input.name) return "APP_NAME_MISMATCH";
  if (sha256(bytes) !== artifact.manifestDigest) return "MANIFEST_MISMATCH";
  let catalog;
  try {
    const output = BuildOutputSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    catalog = appManifestSchema.parse(output.catalog);
  } catch {
    return "MANIFEST_MISMATCH";
  }
  if (catalogDigestOf(catalog) !== artifact.manifest.catalogDigest) return "MANIFEST_MISMATCH";
  return {
    protocolVersion: 1,
    appId: input.name,
    version: artifact.manifest.appVersion,
    endpoint: input.endpoint,
    healthCheckUrl: `${input.endpoint}/health`,
    manifest: catalog as Registration["manifest"],
  };
}

// ---------------------------------------------------------------------------------------------
// Stages.

export interface ReleasePlatform {
  /** Resource prefix (2–8 lowercase letters/digits), e.g. `emb`; run-scoped in live tests. */
  readonly prefix: string;
  /** Gateway workload identity: the only caller of app actions (M05). */
  readonly gatewayServiceAccount: string;
  /** Controller identity: probes candidate health during checks. */
  readonly controllerServiceAccount: string;
  readonly jwtIssuer: string;
  readonly jwksUrl: string;
  /** `project:region:instance` of the shared Cloud SQL instance (mounted at `/cloudsql`). */
  readonly cloudSqlConnection?: string;
  /** For Cloud Run's deterministic service URLs (required for durable apps: the drain URL). */
  readonly projectNumber?: string;
  readonly region?: string;
}
export interface ReleaseStagesOptions {
  readonly platform: ReleasePlatform;
  readonly candidates: CandidateProvider;
  readonly identities: AppIdentityProvider;
  readonly database: AppDatabase;
  readonly health: HealthProbe;
  /** Build outputs (the retained `manifest.json`). */
  readonly outputs: Pick<BuildProvider, "readOutput">;
  readonly store: Pick<DeploymentStore, "appStatus">;
  /** Storage migration policy; defaults to the bundled framework's. */
  readonly migrations: readonly MigrationPolicyEntry[];
  /** Registration policy (M04/M06 validation); defaults to the hosted policy. */
  readonly validate?: (registration: Registration) => void;
}

/** A permanent stage failure; a rollback's compatibility failures are explicit refusals. */
const fail = (reason: string, code?: "CHECK_FAILED" | "ROLLBACK_INCOMPATIBLE"): StageResult => ({
  ok: false,
  retryable: false,
  reason,
  ...(code ? { code } : {}),
});
const pending = (reason: string): StageResult => ({ ok: false, pending: true, reason });

export class ReleaseStages implements DeploymentStages {
  private readonly validate: (registration: Registration) => void;
  public constructor(private readonly options: ReleaseStagesOptions) {
    this.validate =
      options.validate ??
      ((registration) => validateRegistration(registration, { credentials: {} }));
    appResourceNames(options.platform.prefix, "ws_validate0", "app_validate0");
  }

  /** Cloud Run's deterministic service URL, when the platform's project number is configured. */
  private endpoint(name: string): string | undefined {
    const { projectNumber, region } = this.options.platform;
    return projectNumber && region
      ? `https://${name}-${projectNumber}.${region}.run.app`
      : undefined;
  }
  private names(record: DeploymentRecord): AppResourceNames {
    return appResourceNames(this.options.platform.prefix, record.workspaceId, record.appId);
  }
  private owned(state: CandidateState, record: DeploymentRecord): boolean {
    const { labels, annotations } = state;
    return (
      labels[CANDIDATE_LABELS.platform] === this.options.platform.prefix &&
      labels[CANDIDATE_LABELS.owner] === candidateOwner(record) &&
      annotations[CANDIDATE_ANNOTATIONS.workspace] === record.workspaceId &&
      annotations[CANDIDATE_ANNOTATIONS.app] === record.appId &&
      annotations[CANDIDATE_ANNOTATIONS.deployment] === record.deploymentId
    );
  }

  /**
   * One bounded step: app identity, database and credential, the next migration, the durable
   * wake queue, then the candidate. Each step returns `pending` after a provider operation it
   * started, so no call chain approaches the handler deadline; a re-run adopts what exists.
   */
  public async provision(context: DeploymentStageContext): Promise<StageResult> {
    const { deployment: record, artifact, signal } = context;
    const rollback = record.rollbackOf !== undefined;
    // Customer secret references are served by M15; until then a release cannot use them.
    if (record.submission.secretReferences.length > 0)
      return { ok: false, retryable: false, reason: "SECRETS_UNSUPPORTED", code: "INVALID_INPUT" };
    const names = this.names(record);
    const { identities, database } = this.options;
    const account = await identities.ensureAccount(
      names.runtimeAccount,
      `embody runtime ${record.workspaceId}/${record.appId}`,
      signal,
    );
    if (account === "pending") return pending("IDENTITY_PENDING");
    await identities.ensureDatabaseClient(account.email, signal);
    await database.ensure(names);
    await identities.ensureSecret(names.databaseSecret, account.email, signal);
    // Converge the runtime credential without the controller ever reading a secret payload:
    // the role carries the version its password was taken from.
    const latest = await identities.latestSecretVersion(names.databaseSecret, signal);
    if (!latest || latest !== (await database.credentialMarker(names))) {
      const password = randomBytes(24).toString("base64url");
      const version = await identities.addSecretVersion(
        names.databaseSecret,
        database.runtimeUrl(names, password),
        signal,
      );
      await database.setCredential(names, password, version);
    }
    const target = recipeSchemaVersion(artifact.recipe);
    const refusal = migrationRefusal(
      await database.appliedMigrations(names),
      target,
      this.options.migrations,
    );
    if (refusal) return fail(refusal, rollback ? "ROLLBACK_INCOMPATIBLE" : "CHECK_FAILED");
    if ((await database.applyNextMigration(names, target)) === "applied")
      return pending("MIGRATING");
    let wake: { readonly queue: string; readonly invokerEmail: string } | undefined;
    if (record.submission.capabilities.profile === "durable-v1") {
      // The drain URL must be known before the candidate exists (it is the wake audience).
      if (!this.endpoint(candidateName(this.options.platform.prefix, record)))
        return fail("DURABLE_UNCONFIGURED");
      const ensured = await identities.ensureWakeQueue(
        names.wakeQueue,
        names.invokerAccount,
        account.email,
        signal,
      );
      if (ensured === "pending") return pending("QUEUE_PENDING");
      wake = ensured;
    }
    const name = candidateName(this.options.platform.prefix, record);
    const existing = await this.options.candidates.get(name, signal);
    if (!existing) {
      await this.options.candidates.create(
        this.spec(record, artifact, name, account.email, names, wake),
        signal,
      );
      return pending("CANDIDATE_CREATING");
    }
    // A same-named resource someone else owns is never adopted or touched.
    if (!this.owned(existing, record)) return fail("CANDIDATE_CONFLICT");
    if (existing.image !== artifact.imageReference) return fail("CANDIDATE_IMAGE_MISMATCH");
    const expected = this.endpoint(name);
    if (existing.endpoint && expected && existing.endpoint !== expected)
      return fail("CANDIDATE_ENDPOINT_MISMATCH");
    if (!existing.endpoint) return pending("CANDIDATE_CREATING");
    await this.options.candidates.setInvokers(
      name,
      [
        `serviceAccount:${this.options.platform.gatewayServiceAccount}`,
        `serviceAccount:${this.options.platform.controllerServiceAccount}`,
        ...(wake ? [`serviceAccount:${wake.invokerEmail}`] : []),
      ],
      signal,
    );
    return { ok: true, candidate: { service: name, endpoint: existing.endpoint } };
  }

  private spec(
    record: DeploymentRecord,
    artifact: ArtifactRecord,
    name: string,
    runtimeEmail: string,
    names: AppResourceNames,
    wake: { readonly queue: string; readonly invokerEmail: string } | undefined,
  ): CandidateSpec {
    const { platform } = this.options;
    const drain = wake ? `${this.endpoint(name)}/_embody/drain` : undefined;
    return {
      name,
      image: artifact.imageReference!,
      serviceAccount: runtimeEmail,
      labels: {
        [CANDIDATE_LABELS.platform]: platform.prefix,
        [CANDIDATE_LABELS.role]: "candidate",
        [CANDIDATE_LABELS.owner]: candidateOwner(record),
      },
      annotations: {
        [CANDIDATE_ANNOTATIONS.workspace]: record.workspaceId,
        [CANDIDATE_ANNOTATIONS.app]: record.appId,
        [CANDIDATE_ANNOTATIONS.deployment]: record.deploymentId,
      },
      env: [
        { name: "NODE_ENV", value: "production" },
        { name: "EMBODY_HOST_PROFILE", value: "hosted" },
        { name: "EMBODY_WORKSPACE_ID", value: record.workspaceId },
        { name: "GATEWAY_JWT_ISSUER", value: platform.jwtIssuer },
        { name: "GATEWAY_JWKS_URL", value: platform.jwksUrl },
        { name: "DATABASE_URL", secret: { secret: names.databaseSecret, version: "latest" } },
        ...(wake
          ? [
              { name: "EMBODY_HOSTED_PROFILE", value: "durable" },
              { name: "EMBODY_WAKE_QUEUE", value: wake.queue },
              { name: "EMBODY_DRAIN_URL", value: drain! },
              { name: "EMBODY_DRAIN_AUDIENCE", value: drain! },
              { name: "EMBODY_DRAIN_INVOKER_EMAIL", value: wake.invokerEmail },
            ]
          : []),
      ],
      maxInstances: HOSTED_PROFILE.maxInstancesPerApp,
      ...(platform.cloudSqlConnection ? { cloudSqlConnection: platform.cloudSqlConnection } : {}),
    };
  }

  /**
   * Readiness: the candidate is this deployment's, runs exactly the admitted digest, its revision
   * is ready (the host booted and verified the schema), `/health` answers ready, and the release
   * registration it would serve is valid. Side-effect free: no app action is called.
   */
  public async check(context: DeploymentStageContext): Promise<StageResult> {
    const { deployment: record, artifact, signal } = context;
    const rollback = record.rollbackOf !== undefined;
    const name = candidateName(this.options.platform.prefix, record);
    const state = await this.options.candidates.get(name, signal);
    if (!state || !this.owned(state, record) || !record.candidate) return fail("CANDIDATE_MISSING");
    if (state.image !== artifact.imageReference || state.endpoint !== record.candidate.endpoint)
      return fail("CANDIDATE_IMAGE_MISMATCH");
    if (state.status === "failed") return fail("CANDIDATE_FAILED");
    if (state.status === "pending") return pending("CANDIDATE_NOT_READY");
    if (!(await this.options.health.ready(record.candidate.endpoint, signal)))
      return pending("HEALTH_NOT_READY");
    const registration = await this.registration(context);
    if (typeof registration === "string")
      return fail(registration, rollback ? "ROLLBACK_INCOMPATIBLE" : "CHECK_FAILED");
    return { ok: true };
  }

  /**
   * Before the promotion transaction: the registration it switches in (re-read and re-verified,
   * never carried in the record) and the workflow versions still in use (M13.e). The race between
   * this check and the switch is bounded by one handler (see RELEASES "Residual risks").
   */
  public async promote(context: DeploymentStageContext): Promise<PromoteResult> {
    const rollback = context.deployment.rollbackOf !== undefined;
    const registration = await this.registration(context);
    if (typeof registration === "string")
      return {
        ok: false,
        retryable: false,
        reason: registration,
        code: rollback ? "ROLLBACK_INCOMPATIBLE" : "CHECK_FAILED",
      };
    const inUse = await this.options.database.activeWorkflowVersions(
      this.names(context.deployment),
    );
    const refusal = workflowRefusal(
      inUse,
      context.artifact.manifest,
      context.active?.manifest.artifact,
    );
    if (refusal)
      return {
        ok: false,
        retryable: false,
        reason: refusal,
        code: rollback ? "ROLLBACK_INCOMPATIBLE" : "CHECK_FAILED",
      };
    return { ok: true, registration };
  }

  private async registration(context: DeploymentStageContext): Promise<Registration | string> {
    const { deployment: record } = context;
    if (!record.candidate) return "CANDIDATE_MISSING";
    const status = await this.options.store.appStatus(record.workspaceId, record.appId);
    if (!status?.name) return "APP_MISSING";
    const endpoint = record.candidate.endpoint;
    let registration: Registration | string;
    if (context.rollback) {
      // The target's registration was verified when it was promoted; only the route is new.
      const prior = context.rollback.registration;
      registration = prior
        ? { ...prior, appId: status.name, endpoint, healthCheckUrl: `${endpoint}/health` }
        : "RELEASE_PREDATES_M13";
    } else
      registration = await releaseRegistration({
        artifact: context.artifact,
        name: status.name,
        endpoint,
        readOutput: (path, max) => this.options.outputs.readOutput(path, max),
      });
    if (typeof registration === "string") return registration;
    try {
      this.validate(registration);
    } catch {
      return "REGISTRATION_INVALID";
    }
    return registration;
  }

  /** Removes this deployment's candidate after a failure or cancellation (ownership-checked). */
  public async abandon(record: DeploymentRecord): Promise<void> {
    const name = candidateName(this.options.platform.prefix, record);
    const signal = AbortSignal.timeout(15_000);
    const state = await this.options.candidates.get(name, signal);
    if (state && this.owned(state, record)) await this.options.candidates.remove(name, signal);
  }
}

// ---------------------------------------------------------------------------------------------
// Candidate sweep: drained releases and orphans (M13 step 4, M12 review finding 1).

export interface CandidateSweepOptions {
  readonly prefix: string;
  readonly candidates: CandidateProvider;
  readonly store: Pick<
    DeploymentStore,
    "deployment" | "releaseForDeployment" | "appStatus" | "markCandidateRemoved"
  >;
  /** Removals per pass; the rest wait for the next pass. */
  readonly maxRemovals?: number;
}
export type SweepDecision = "keep" | "remove" | "foreign";
/**
 * Whether a listed candidate may go. Only candidates whose labels and annotations name exactly
 * one workspace, app and deployment of this platform are considered (anything else is foreign
 * and untouched). A candidate stays while its deployment runs, while its release is active, and
 * while a replaced release drains; it goes when its deployment failed or was cancelled (cleanup
 * missed it, for example a stage that outlived its handler), when its release has drained, or
 * when no deployment record exists for it.
 */
export async function decideSweep(
  state: CandidateState,
  options: Pick<CandidateSweepOptions, "prefix" | "store">,
  now: Date,
): Promise<{ readonly decision: SweepDecision; readonly release?: ReleaseRecord }> {
  const owner = {
    workspaceId: state.annotations[CANDIDATE_ANNOTATIONS.workspace] ?? "",
    appId: state.annotations[CANDIDATE_ANNOTATIONS.app] ?? "",
    deploymentId: state.annotations[CANDIDATE_ANNOTATIONS.deployment] ?? "",
  };
  if (
    state.labels[CANDIDATE_LABELS.platform] !== options.prefix ||
    state.labels[CANDIDATE_LABELS.role] !== "candidate" ||
    !/^ws_[a-z0-9]{8,64}$/.test(owner.workspaceId) ||
    !/^app_[a-z0-9]{8,64}$/.test(owner.appId) ||
    !/^dep_[a-z0-9]{8,64}$/.test(owner.deploymentId) ||
    state.labels[CANDIDATE_LABELS.owner] !== candidateOwner(owner) ||
    state.name !== candidateName(options.prefix, owner)
  )
    return { decision: "foreign" };
  const record = await options.store.deployment(owner.workspaceId, owner.appId, owner.deploymentId);
  if (!record) return { decision: "remove" };
  if (!TERMINAL.has(record.state)) return { decision: "keep" };
  if (record.state !== "active") return { decision: "remove" };
  const release = await options.store.releaseForDeployment(
    owner.workspaceId,
    owner.appId,
    owner.deploymentId,
  );
  if (!release) return { decision: "keep" };
  const status = await options.store.appStatus(owner.workspaceId, owner.appId);
  if (status?.activeReleaseId === release.releaseId) return { decision: "keep", release };
  if (!release.drainUntil || Date.parse(release.drainUntil) > now.getTime())
    return { decision: "keep", release };
  return { decision: "remove", release };
}
export class CandidateSweep implements CandidateSweeper {
  public constructor(private readonly options: CandidateSweepOptions) {}
  public async sweep(now: Date): Promise<{ readonly removed: number; readonly kept: number }> {
    const signal = AbortSignal.timeout(30_000);
    let removed = 0;
    let kept = 0;
    for (const state of await this.options.candidates.list(signal)) {
      if (removed >= (this.options.maxRemovals ?? 10)) break;
      const { decision, release } = await decideSweep(state, this.options, now);
      if (decision !== "remove") {
        kept += decision === "keep" ? 1 : 0;
        continue;
      }
      await this.options.candidates.remove(state.name, signal);
      if (release)
        await this.options.store.markCandidateRemoved(
          release.workspaceId,
          release.appId,
          release.releaseId,
          now,
        );
      removed += 1;
    }
    return { removed, kept };
  }
}
export type { CandidateRef };
