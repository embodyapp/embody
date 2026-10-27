import { createHash, randomBytes } from "node:crypto";
import {
  HOSTED_PROFILE,
  MANAGEMENT_LIMITS,
  type AppDeletionReceipt,
  type LogEntry,
  type SecretReference,
  type SecretStatus,
} from "@embody/cloud-contracts";
import type { AuditRecord } from "./dispatch.js";
import {
  DeploymentError,
  TERMINAL,
  decideCancel,
  wakeFor,
  type DeploymentRecord,
  type DeploymentWake,
  type DeploymentWakeHook,
  type ReleaseRecord,
} from "./deployment.js";
import type { CatalogApp } from "./store.js";

/**
 * M15 app lifecycle, secrets, logs and the emergency stop: the decisions every store shares.
 * Stores lock, persist and call the wake hook before commit; the rules live here.
 * See docs/mvp/MANAGEMENT.md.
 */

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------
// Lifecycle (M15 steps 3–4).

export type LifecycleOperation = "disable" | "enable" | "delete";
export interface LifecycleInput {
  readonly workspaceId: string;
  readonly appId: string;
  readonly operation: LifecycleOperation;
  readonly expectedGeneration: number;
  readonly actorId: string;
  readonly now: Date;
}
export interface LifecycleResult {
  readonly app: CatalogApp;
  /** False for a replay (the app was already in the requested state). */
  readonly changed: boolean;
  readonly cancelled: readonly string[];
  readonly receipt?: AppDeletionReceipt;
}
/** The catalog after a lifecycle change (revision, generation and fence are the store's). */
export function lifecycleCatalog(
  app: CatalogApp,
  operation: LifecycleOperation,
): Omit<CatalogApp, "revision" | "generation" | "lifecycleFence"> {
  const { revision: _r, generation: _g, lifecycleFence: _f, ...rest } = app;
  void _r;
  void _g;
  void _f;
  if (operation === "enable")
    return { ...rest, state: app.activeRelease !== null ? "idle" : "unavailable" };
  if (operation === "disable") return { ...rest, state: "disabled" };
  return { ...rest, state: "deleted", activeRelease: null };
}
/**
 * Whether the change applies: disable and delete need the generation the operator saw (a deploy
 * promoted meanwhile conflicts, so nobody disables or deletes a release they have not seen);
 * repeating the request once the app is in that state replays without another change. A deleted
 * app is final. Enabling an app that is not disabled is a replay.
 */
export function decideLifecycle(
  app: CatalogApp | undefined,
  input: LifecycleInput,
): "apply" | "replay" {
  if (!app) throw new DeploymentError("NOT_FOUND");
  if (app.state === "deleted") {
    if (input.operation === "delete") return "replay";
    throw new DeploymentError("NOT_FOUND");
  }
  if (input.operation === "disable" && app.state === "disabled") return "replay";
  if (input.operation === "enable" && app.state !== "disabled") return "replay";
  if (input.expectedGeneration !== app.generation) throw new DeploymentError("STALE_GENERATION");
  return "apply";
}
/**
 * Every nonterminal deployment of the app is cancelled in the lifecycle transaction (its own
 * cancellation fence, so its worker's claim and any queued task are stale), and the app's fence
 * and generation move: no deployment captured before the change can advance or promote.
 */
export function fencedDeployment(
  record: DeploymentRecord,
  operation: "disable" | "delete",
  now: Date,
): { readonly next: DeploymentRecord; readonly wake?: DeploymentWake } | null {
  if (TERMINAL.has(record.state)) return null;
  const decision = decideCancel(record, record.cancellationFence, now);
  return {
    next: { ...decision.next, reason: operation === "disable" ? "APP_DISABLED" : "APP_DELETED" },
    ...(decision.wake ? { wake: decision.wake } : {}),
  };
}
/**
 * Delete: a release's candidate keeps nothing to serve, so the deployment that promoted it gets a
 * cleanup (the controller removes the candidate and revokes the runtime credential). Releases are
 * no longer rollback targets; what they pinned goes back to the retention sweeps now.
 */
export function deletedRelease(release: ReleaseRecord, now: Date): ReleaseRecord {
  const at = now.toISOString();
  return {
    ...release,
    inactiveSince: release.inactiveSince ?? at,
    drainUntil: at,
    retainUntil: at,
  };
}
export function deletionCleanup(
  record: DeploymentRecord,
  now: Date,
): { readonly next: DeploymentRecord; readonly wake: DeploymentWake } | null {
  if (record.state !== "active" || record.cleanup) return null;
  const next: DeploymentRecord = {
    ...record,
    cleanup: true,
    cleanupAttempts: 0,
    epoch: record.epoch + 1,
    dueAt: now.toISOString(),
    updatedAt: now.toISOString(),
    revision: record.revision + 1,
  };
  return { next, wake: wakeFor(next, "cleanup")! };
}
/** An unpinned, immediately expired source or artifact: the existing sweeps delete it. */
export function releasedForDeletion<
  T extends { readonly pinnedBy?: string; readonly retainUntil: string },
>(record: T, now: Date): T {
  const { pinnedBy: _pin, ...rest } = record;
  void _pin;
  return { ...rest, retainUntil: now.toISOString() } as unknown as T;
}
export function deletionReceipt(
  app: CatalogApp,
  input: LifecycleInput,
  lifecycleFence: number,
  cancelled: readonly string[],
): AppDeletionReceipt {
  const now = input.now.getTime();
  return {
    version: 1,
    workspaceId: app.workspaceId as AppDeletionReceipt["workspaceId"],
    appId: app.appId as AppDeletionReceipt["appId"],
    name: (app.name ?? app.registration?.appId)!,
    deletedAt: iso(now),
    actorId: input.actorId,
    lifecycleFence,
    cancelledDeployments: cancelled.slice(0, 20) as AppDeletionReceipt["cancelledDeployments"],
    retention: {
      databaseUntil: iso(now + MANAGEMENT_LIMITS.deletedDatabaseRetentionDays * DAY),
      sourcesAndImages: "released",
      backups: "instance-backup-retention",
      secrets: "revoked",
      audit: "retained",
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Secrets (M15 step 2). The platform keeps metadata only; values go straight to the vault.

export interface SecretVersionRecord {
  readonly secretVersion: number;
  /** The vault's version name: platform data, never public. */
  readonly providerVersion: string;
  readonly state: "enabled" | "revoked";
  readonly createdAt: string;
  readonly revokedAt?: string;
  /** The vault confirmed the version is disabled (revocation is complete). */
  readonly disabled?: boolean;
}
export interface SecretRecord {
  readonly workspaceId: string;
  readonly appId: string;
  readonly name: string;
  readonly secretId: string;
  /** The vault secret: deterministic from platform IDs and the name. */
  readonly providerSecret: string;
  readonly versions: readonly SecretVersionRecord[];
  readonly revision: number;
}
/**
 * The customer secret vault (Secret Manager in production). The gateway writes and disables
 * versions; it never reads a payload. Only the app's runtime identity may access the secret.
 */
export interface SecretVault {
  /** Creates or adopts the secret; its only accessor is `accessorEmail`. */
  ensure(secret: string, accessorEmail: string, signal: AbortSignal): Promise<void>;
  addVersion(secret: string, payload: string, signal: AbortSignal): Promise<string>;
  /** Disables one version (idempotent): nobody can access it afterwards. */
  disableVersion(secret: string, version: string, signal: AbortSignal): Promise<void>;
}
/** Where an app's customer secrets live and who may read them. */
export interface SecretNaming {
  secret(workspaceId: string, appId: string, name: string): string;
  accessor(workspaceId: string, appId: string): string;
}
/** `${prefix}-a<app hash>-s<name hash>`: no customer-controlled text in provider names. */
export function customerSecretName(
  prefix: string,
  workspaceId: string,
  appId: string,
  name: string,
): string {
  const key = createHash("sha256").update(`${workspaceId}/${appId}`).digest("hex").slice(0, 16);
  const tag = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `${prefix}-a${key}-s${tag}`;
}
export const newSecretId = () => `sec_${randomBytes(12).toString("hex")}`;
export const latestEnabled = (record: SecretRecord): SecretVersionRecord | undefined =>
  [...record.versions].reverse().find((version) => version.state === "enabled");
export const latestVersion = (record: SecretRecord | undefined): number =>
  record?.versions.at(-1)?.secretVersion ?? 0;
export function secretStatus(record: SecretRecord): SecretStatus {
  return {
    version: 1,
    workspaceId: record.workspaceId as SecretStatus["workspaceId"],
    appId: record.appId as SecretStatus["appId"],
    name: record.name,
    secretId: record.secretId,
    versions: record.versions.map((version) => ({
      secretVersion: version.secretVersion,
      state: version.state,
      createdAt: version.createdAt,
      ...(version.revokedAt ? { revokedAt: version.revokedAt } : {}),
    })),
  };
}
/** The next version record, or a conflict when another writer won (CAS on the latest version). */
export function decideSecretWrite(
  prior: SecretRecord | undefined,
  input: {
    readonly workspaceId: string;
    readonly appId: string;
    readonly name: string;
    readonly expectedVersion: number;
    readonly providerSecret: string;
    readonly providerVersion: string;
    readonly now: Date;
  },
  secretCount: number,
): SecretRecord {
  if (latestVersion(prior) !== input.expectedVersion) throw new DeploymentError("STALE_GENERATION");
  if (!prior && secretCount >= HOSTED_PROFILE.maxSecretReferences)
    throw new DeploymentError("LIMIT_EXCEEDED");
  if (prior && prior.versions.length >= MANAGEMENT_LIMITS.maxSecretVersions)
    throw new DeploymentError("LIMIT_EXCEEDED");
  const version: SecretVersionRecord = {
    secretVersion: input.expectedVersion + 1,
    providerVersion: input.providerVersion,
    state: "enabled",
    createdAt: input.now.toISOString(),
  };
  return prior
    ? { ...prior, versions: [...prior.versions, version], revision: prior.revision + 1 }
    : {
        workspaceId: input.workspaceId,
        appId: input.appId,
        name: input.name,
        secretId: newSecretId(),
        providerSecret: input.providerSecret,
        versions: [version],
        revision: 1,
      };
}
/** Secret versions a release or a deployment needs while it serves or may still promote. */
export function referencedVersions(
  references: readonly SecretReference[],
  name: string,
): Set<number> {
  return new Set(references.filter((ref) => ref.name === name).map((ref) => ref.secretVersion));
}
/**
 * Revocation: the version becomes unusable. It may not be the active release's or a running
 * deployment's (their instances would fail to start); roll out a newer version first.
 */
export function decideRevoke(
  record: SecretRecord | undefined,
  secretVersion: number,
  inUse: ReadonlySet<number>,
  now: Date,
): { readonly next: SecretRecord; readonly changed: boolean } {
  const version = record?.versions.find((entry) => entry.secretVersion === secretVersion);
  if (!record || !version) throw new DeploymentError("NOT_FOUND");
  if (version.state === "revoked") return { next: record, changed: false };
  if (inUse.has(secretVersion)) throw new DeploymentError("SECRET_IN_USE");
  return {
    changed: true,
    next: {
      ...record,
      revision: record.revision + 1,
      versions: record.versions.map((entry) =>
        entry.secretVersion === secretVersion
          ? { ...entry, state: "revoked" as const, revokedAt: now.toISOString(), disabled: false }
          : entry,
      ),
    },
  };
}
export function markDisabled(record: SecretRecord, secretVersion: number): SecretRecord {
  return {
    ...record,
    revision: record.revision + 1,
    versions: record.versions.map((entry) =>
      entry.secretVersion === secretVersion ? { ...entry, disabled: true } : entry,
    ),
  };
}
/** Delete: every version is revoked now (the vault disables them after the commit). */
export function revokedForDeletion(record: SecretRecord, now: Date): SecretRecord {
  return {
    ...record,
    revision: record.revision + 1,
    versions: record.versions.map((entry) =>
      entry.state === "revoked"
        ? entry
        : { ...entry, state: "revoked" as const, revokedAt: now.toISOString(), disabled: false },
    ),
  };
}
/** References for a deployment: the latest enabled version of every app secret. */
export function currentReferences(
  records: readonly SecretRecord[],
): Array<Omit<SecretReference, "version"> & { version: 1 }> {
  return records
    .map((record) => ({ record, latest: latestEnabled(record) }))
    .filter((entry): entry is { record: SecretRecord; latest: SecretVersionRecord } =>
      Boolean(entry.latest),
    )
    .sort((a, b) => (a.record.name < b.record.name ? -1 : 1))
    .map(({ record, latest }) => ({
      version: 1 as const,
      workspaceId: record.workspaceId as SecretReference["workspaceId"],
      appId: record.appId as SecretReference["appId"],
      name: record.name,
      secretId: record.secretId,
      secretVersion: latest.secretVersion,
    }));
}
/**
 * Resolves a release's references to vault versions, or the reason it cannot use them: an
 * unknown secret, a foreign ID, or a revoked version (a rollback to a release whose secret was
 * rotated and revoked is refused, M13 step 5).
 */
export function resolveReferences(
  references: readonly SecretReference[],
  records: readonly SecretRecord[],
): { readonly env: ReadonlyArray<{ name: string; secret: string; version: string }> } | string {
  const env: Array<{ name: string; secret: string; version: string }> = [];
  for (const ref of references) {
    const record = records.find((entry) => entry.name === ref.name);
    if (!record || record.secretId !== ref.secretId) return "SECRET_UNKNOWN";
    const version = record.versions.find((entry) => entry.secretVersion === ref.secretVersion);
    if (!version) return "SECRET_UNKNOWN";
    if (version.state !== "enabled") return "SECRET_REVOKED";
    env.push({ name: ref.name, secret: record.providerSecret, version: version.providerVersion });
  }
  return { env };
}

// ---------------------------------------------------------------------------------------------
// Logs (M15 step 1): the platform's own records for one app, never provider queries.

export interface LogCursor {
  readonly time: string;
  readonly id: string;
}
export function encodeCursor(cursor: LogCursor): string {
  return Buffer.from(`${cursor.time}|${cursor.id}`, "utf8").toString("base64url");
}
export function decodeCursor(value: string | undefined): LogCursor | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new DeploymentError("INVALID_INPUT");
  const [time, id, extra] = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (extra !== undefined || !time || !id || !Number.isFinite(Date.parse(time)))
    throw new DeploymentError("INVALID_INPUT");
  return { time: new Date(time).toISOString(), id };
}
/** Strictly older than the cursor, in (time desc, id desc) order. */
export const olderThan = (entry: LogCursor, cursor: LogCursor | undefined): boolean =>
  !cursor || entry.time < cursor.time || (entry.time === cursor.time && entry.id < cursor.id);
export const newestFirst = (a: LogCursor, b: LogCursor): number =>
  a.time === b.time ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.time < b.time ? 1 : -1;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_TARGET = /^[A-Za-z0-9_.:/-]{1,200}$/;
/**
 * An audit record as a log entry: identifiers, outcome, error code and duration only. Audit
 * records carry no payloads; anything that does not match a safe shape is dropped or replaced.
 */
export function requestEntry(record: AuditRecord, time: string): LogEntry | null {
  if (!SAFE_ID.test(record.requestId)) return null;
  const outcome = /^[a-z:_-]{1,40}$/.test(record.outcome) ? record.outcome : "unknown";
  return {
    time,
    kind: "request",
    id: record.requestId,
    target: record.target && SAFE_TARGET.test(record.target) ? record.target : "-",
    outcome,
    ...(record.errorCode && /^[A-Z_]{1,40}$/.test(record.errorCode)
      ? { errorCode: record.errorCode }
      : {}),
    durationMs: Math.max(0, Math.trunc(record.durationMs)),
    ...(record.actorId && record.actorId.length <= 200 ? { actorId: record.actorId } : {}),
    ...(record.surface === "http" || record.surface === "mcp" ? { surface: record.surface } : {}),
  };
}
/** A deployment as a log entry: public state and error code, never the internal reason. */
export function deploymentEntry(record: DeploymentRecord): LogEntry {
  return {
    time: record.updatedAt,
    kind: "deployment",
    id: record.deploymentId,
    target: record.rollbackOf ? "rollback" : "deployment",
    outcome: record.state,
    ...(record.state === "failed" && record.error ? { errorCode: record.error } : {}),
    actorId: record.actorId.slice(0, 200),
    surface: "platform",
  };
}
export interface LogQuery {
  readonly workspaceId: string;
  readonly appId: string;
  /** Other names the app's requests are audited under (its catalog namespace). */
  readonly aliases?: readonly string[];
  readonly limit: number;
  readonly before?: LogCursor;
  /** Oldest time returned (bounded by the log retention). */
  readonly since: string;
}
/** Merges both sources newest first and pages them. */
export function logPage(
  entries: readonly LogEntry[],
  limit: number,
): { readonly entries: LogEntry[]; readonly nextCursor?: string } {
  const sorted = [...entries].sort((a, b) => newestFirst(a, b));
  const page = sorted.slice(0, limit);
  const last = page.at(-1);
  return {
    entries: page,
    ...(sorted.length > limit && last
      ? { nextCursor: encodeCursor({ time: last.time, id: last.id }) }
      : {}),
  };
}
export function logSince(now: Date, requested?: string): string {
  const floor = now.getTime() - MANAGEMENT_LIMITS.maxLogAgeDays * DAY;
  const asked = requested === undefined ? floor : Date.parse(requested);
  if (!Number.isFinite(asked)) throw new DeploymentError("INVALID_INPUT");
  return iso(Math.max(floor, asked));
}

// ---------------------------------------------------------------------------------------------
// Persistence.

export type StopScope = "global" | `ws_${string}`;
export interface ManagementStore {
  /** Atomic: CAS, catalog state/fence, deployment fencing, delete retention, wakes before commit. */
  changeLifecycle(input: LifecycleInput, wake: DeploymentWakeHook): Promise<LifecycleResult>;
  deletionReceipt(workspaceId: string, appId: string): Promise<AppDeletionReceipt | null>;
  secrets(workspaceId: string, appId: string): Promise<readonly SecretRecord[]>;
  /** CAS on the latest version; the value is already in the vault as `providerVersion`. */
  putSecretVersion(input: {
    readonly workspaceId: string;
    readonly appId: string;
    readonly name: string;
    readonly expectedVersion: number;
    readonly providerSecret: string;
    readonly providerVersion: string;
    readonly now: Date;
  }): Promise<SecretRecord>;
  /** Marks a version revoked unless the active release or a running deployment references it. */
  revokeSecretVersion(input: {
    readonly workspaceId: string;
    readonly appId: string;
    readonly name: string;
    readonly secretVersion: number;
    readonly now: Date;
  }): Promise<SecretRecord>;
  /** Records that the vault disabled a revoked version. */
  confirmSecretDisabled(
    workspaceId: string,
    appId: string,
    name: string,
    secretVersion: number,
  ): Promise<void>;
  /** Bounded, newest first: audit records of the app's requests and its deployments. */
  appLogs(query: LogQuery): Promise<readonly LogEntry[]>;
  /** Operator emergency stop (global or one workspace); never deletes anything. */
  setStop(scope: StopScope, stopped: boolean, actor: string, now: Date): Promise<void>;
  stopped(workspaceId: string): Promise<boolean>;
}

/**
 * The vault in tests and local topologies. `read` stands in for the runtime identity's access at
 * instance start: only the accessor may read, and only an enabled version.
 */
export class MemorySecretVault implements SecretVault {
  public readonly secrets = new Map<
    string,
    { accessor: string; versions: Array<{ payload: string; enabled: boolean }> }
  >();
  public failNext: "ensure" | "addVersion" | "disableVersion" | undefined;
  private check(operation: "ensure" | "addVersion" | "disableVersion"): void {
    if (this.failNext === operation) {
      this.failNext = undefined;
      throw new Error("vault unavailable");
    }
  }
  public ensure(secret: string, accessorEmail: string): Promise<void> {
    this.check("ensure");
    const found = this.secrets.get(secret);
    if (found) found.accessor = accessorEmail;
    else this.secrets.set(secret, { accessor: accessorEmail, versions: [] });
    return Promise.resolve();
  }
  public addVersion(secret: string, payload: string): Promise<string> {
    this.check("addVersion");
    const found = this.secrets.get(secret);
    if (!found) return Promise.reject(new Error("Secret not found"));
    found.versions.push({ payload, enabled: true });
    return Promise.resolve(String(found.versions.length));
  }
  public disableVersion(secret: string, version: string): Promise<void> {
    this.check("disableVersion");
    const entry = this.secrets.get(secret)?.versions[Number(version) - 1];
    if (entry) entry.enabled = false;
    return Promise.resolve();
  }
  public read(secret: string, version: string, accessorEmail: string): string | null {
    const found = this.secrets.get(secret);
    const entry = found?.versions[Number(version) - 1];
    return found && found.accessor === accessorEmail && entry?.enabled ? entry.payload : null;
  }
}
/** The Secret Manager vault: the gateway's identity may add and disable versions only. */
export function secretManagerVault(provider: {
  ensureSecret(secretId: string, accessorEmail: string, signal: AbortSignal): Promise<void>;
  addSecretVersion(secretId: string, payload: string, signal: AbortSignal): Promise<string>;
  disableSecretVersion(secretId: string, version: string, signal: AbortSignal): Promise<void>;
}): SecretVault {
  return {
    ensure: (secret, accessor, signal) => provider.ensureSecret(secret, accessor, signal),
    addVersion: (secret, payload, signal) => provider.addSecretVersion(secret, payload, signal),
    disableVersion: (secret, version, signal) =>
      provider.disableSecretVersion(secret, version, signal),
  };
}
