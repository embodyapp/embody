import { randomBytes, createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  principalSchema,
  type Principal,
} from "@embody/core";
import {
  ScopedGrantSchema,
  WorkspaceIdSchema,
  AppIdSchema,
  ReleaseIdSchema,
  DeploymentSubmissionSchema,
  type ScopedGrant,
} from "@embody/cloud-contracts";
import { validateRegistration, type Registration, type GatewayRegistryOptions } from "./index.js";
import { DispatchRateLimitedError, type AuditRecord, type DispatchAdmission } from "./dispatch.js";
import {
  decideSourceAdmission,
  type SourceAdmitInput,
  type SourceRecord,
  type SourceStore,
  type SourceUsage,
} from "./source-admission.js";
import {
  artifactTransitionAllowed,
  type ArtifactCursor,
  type ArtifactRecord,
  type ArtifactStore,
  type ArtifactWrite,
} from "./build-admission.js";
import {
  DEPLOYMENT_LIMITS,
  DeploymentError,
  StaleDeploymentError,
  TERMINAL,
  appControl,
  decideCancel,
  decideCleanup,
  decideClaim,
  decideComplete,
  decideSubmit,
  isOverdue,
  newDeploymentId,
  releaseManifest,
  wakeFor,
  type AppControl,
  type ClaimDecision,
  type CompletionFence,
  type DeploymentRecord,
  type DeploymentStore,
  type DeploymentWakeHook,
  type ReleaseRecord,
  type StageOutcome,
  type SubmitInput,
} from "./deployment.js";

export interface Workspace {
  readonly id: string;
  readonly revision: number;
}
export interface CatalogApp {
  readonly workspaceId: string;
  readonly appId: string;
  readonly registration: Registration;
  readonly activeRelease: string | null;
  readonly state: "idle" | "ready" | "unavailable" | "disabled" | "deleted";
  readonly revision: number;
  readonly generation: number;
  /**
   * Advanced when the app becomes disabled or deleted (M02 lifecycle fence). Deployments capture
   * it at submission and cannot advance or promote once it moves. Absent on records written
   * before M12, which reads that as 0.
   */
  readonly lifecycleFence?: number;
}
export type CatalogWrite = Omit<CatalogApp, "revision" | "generation" | "lifecycleFence">;
export interface WorkspaceCredential {
  readonly workspaceId: string;
  readonly id: string;
  readonly hash: string;
  readonly principal: Principal;
  readonly grants: readonly ScopedGrant[];
  readonly expiresAt: string;
  readonly revoked: boolean;
  readonly revision: number;
}
export type CredentialWrite = Omit<WorkspaceCredential, "revision">;
export interface WorkspaceSnapshot {
  readonly workspace: Workspace;
  readonly apps: readonly CatalogApp[];
}
/** Trusted control-plane interface. All mutations are CAS; null means create only. */
export interface GatewayStore extends DispatchAdmission {
  createWorkspace(id: string): Promise<Workspace>;
  snapshot(workspaceId: string): Promise<WorkspaceSnapshot | null>;
  putApp(value: CatalogWrite, expectedRevision: number | null): Promise<CatalogApp>;
  putCredential(
    value: CredentialWrite,
    expectedRevision: number | null,
  ): Promise<WorkspaceCredential>;
  credential(workspaceId: string, hash: string): Promise<WorkspaceCredential | null>;
  close(): Promise<void>;
}
export function credentialHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
/** Plaintext is returned once to provisioning, never passed to or persisted by the store. */
export function newCredential(input: Omit<CredentialWrite, "id" | "hash" | "revoked">): {
  token: string;
  credential: CredentialWrite;
} {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    credential: {
      ...input,
      id: randomBytes(16).toString("hex"),
      hash: credentialHash(token),
      revoked: false,
    },
  };
}
const clone = <T>(value: T): T => structuredClone(value);
function id(value: string): void {
  if (!WorkspaceIdSchema.safeParse(value).success)
    throw new BadRequestError("Invalid workspace ID");
}
function cas(prior: { revision: number } | undefined, expected: number | null): void {
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1))
    throw new BadRequestError("Invalid revision");
  if ((prior?.revision ?? null) !== expected) throw new ConflictError("Revision conflict");
}
function validateApp(value: CatalogWrite, policy: GatewayRegistryOptions): CatalogWrite {
  id(value.workspaceId);
  if (
    !AppIdSchema.safeParse(value.appId).success ||
    !["idle", "ready", "unavailable", "disabled", "deleted"].includes(value.state) ||
    ((value.state === "ready" || value.state === "idle") && value.activeRelease === null) ||
    (value.activeRelease !== null && !ReleaseIdSchema.safeParse(value.activeRelease).success)
  )
    throw new BadRequestError("Invalid catalog record");
  validateRegistration(value.registration, policy);
  return clone({
    workspaceId: value.workspaceId,
    appId: value.appId,
    registration: value.registration,
    activeRelease: value.activeRelease,
    state: value.state,
  });
}
function validateCredential(value: CredentialWrite): CredentialWrite {
  id(value.workspaceId);
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id) ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    typeof value.revoked !== "boolean"
  )
    throw new BadRequestError("Invalid credential record");
  const principal = principalSchema.parse(value.principal);
  if (principal.delegation && principal.actorType !== "agent")
    throw new BadRequestError("Only agent credentials may carry delegation");
  if (principal.orgId !== value.workspaceId)
    throw new BadRequestError("Credential workspace mismatch");
  for (const grant of value.grants) {
    ScopedGrantSchema.parse({ version: 1, ...grant });
    if (grant.workspaceId !== value.workspaceId)
      throw new BadRequestError("Grant workspace mismatch");
  }
  return clone({
    workspaceId: value.workspaceId,
    id: value.id,
    hash: value.hash,
    principal: principal as Principal,
    grants: value.grants,
    expiresAt: value.expiresAt,
    revoked: value.revoked,
  });
}
const defaultPolicy: GatewayRegistryOptions = { credentials: {} };
/** Disabling or deleting an app advances its lifecycle fence; other writes keep it. */
function nextLifecycleFence(prior: CatalogApp | undefined, value: CatalogWrite): number {
  const fence = prior?.lifecycleFence ?? 0;
  const stopped = value.state === "disabled" || value.state === "deleted";
  return stopped && prior?.state !== value.state ? fence + 1 : fence;
}
function validateArtifact(record: ArtifactWrite): void {
  id(record.workspaceId);
  if (
    !AppIdSchema.safeParse(record.appId).success ||
    !/^dep_[a-z0-9]{8,64}$/.test(record.deploymentId) ||
    !/^art_[a-z0-9]{8,64}$/.test(record.artifactId) ||
    !Number.isSafeInteger(record.attempt) ||
    record.attempt < 1 ||
    !["building", "admitted", "rejected"].includes(record.state) ||
    !Number.isFinite(Date.parse(record.retainUntil))
  )
    throw new BadRequestError("Invalid artifact record");
}
function validateSubmission(input: SubmitInput): void {
  // The route parsed it already; stores re-check identity shape so no caller can write a record
  // keyed by an arbitrary string.
  DeploymentSubmissionSchema.parse(input.submission);
  if (
    !/^sha256:[a-f0-9]{64}$/.test(input.fingerprint) ||
    typeof input.actorId !== "string" ||
    !input.actorId ||
    !Number.isFinite(input.now.getTime())
  )
    throw new BadRequestError("Invalid deployment submission");
}
const newLeaseToken = () => randomBytes(16).toString("hex");
function validateSourceInput(input: SourceAdmitInput): void {
  id(input.workspaceId);
  if (!AppIdSchema.safeParse(input.appId).success || !Number.isFinite(input.now.getTime()))
    throw new BadRequestError("Invalid source request");
}
/** Identity, digest and size of a source record are immutable after admission. */
function sameSourceIdentity(a: SourceRecord, b: SourceRecord): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.appId === b.appId &&
    a.uploadId === b.uploadId &&
    a.idempotencyKey === b.idempotencyKey &&
    a.objectKey === b.objectKey &&
    a.digest === b.digest &&
    a.bytes === b.bytes
  );
}
/* eslint-disable @typescript-eslint/require-await -- Atomic memory operations contain no await; async converts validation/CAS errors to rejections. */
export class MemoryGatewayStore
  implements GatewayStore, SourceStore, ArtifactStore, DeploymentStore
{
  private sources = new Map<string, SourceRecord>();
  private artifacts = new Map<string, ArtifactRecord>();
  private workspaces = new Map<string, Workspace>();
  private apps = new Map<string, CatalogApp>();
  private credentials = new Map<string, WorkspaceCredential>();
  private admissions = new Map<
    string,
    { record: AuditRecord; expires: number; completed: boolean }
  >();
  private quotas = new Map<string, { count: number; reset: number }>();
  public async admit(record: AuditRecord): Promise<void> {
    const workspace = record.orgId!;
    if (!this.workspaces.has(workspace)) throw new NotFoundError("Workspace not found");
    const key = `${workspace}/${record.requestId}`;
    if (this.admissions.has(key)) throw new ConflictError("Request already admitted");
    const now = Date.now();
    const prior = this.quotas.get(workspace);
    const quota = prior && prior.reset > now ? prior : { count: 0, reset: now + 60_000 };
    const active = [...this.admissions.values()].filter(
      (a) => a.record.orgId === workspace && a.expires > now,
    ).length;
    if (quota.count >= 60 || active >= 20)
      throw new DispatchRateLimitedError(Math.max(1, Math.ceil((quota.reset - now) / 1000)));
    quota.count++;
    this.quotas.set(workspace, quota);
    this.admissions.set(key, { record: clone(record), expires: now + 60_000, completed: false });
  }
  public async complete(record: AuditRecord): Promise<void> {
    const key = `${record.orgId}/${record.requestId}`;
    const prior = this.admissions.get(key);
    if (prior && !prior.completed)
      this.admissions.set(key, { record: clone(record), expires: 0, completed: true });
  }
  public constructor(private readonly policy: GatewayRegistryOptions = defaultPolicy) {}
  public async createWorkspace(workspaceId: string): Promise<Workspace> {
    id(workspaceId);
    if (this.workspaces.has(workspaceId)) throw new ConflictError("Workspace exists");
    const workspace = { id: workspaceId, revision: 1 };
    this.workspaces.set(workspaceId, workspace);
    return clone(workspace);
  }
  public async snapshot(workspaceId: string): Promise<WorkspaceSnapshot | null> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return null;
    return clone({
      workspace,
      apps: [...this.apps.values()]
        .filter((a) => a.workspaceId === workspaceId)
        .sort((a, b) => a.appId.localeCompare(b.appId)),
    });
  }
  private bump(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    this.workspaces.set(workspaceId, { ...workspace, revision: workspace.revision + 1 });
  }
  public async putApp(input: CatalogWrite, expected: number | null): Promise<CatalogApp> {
    const value = validateApp(input, this.policy);
    const key = `${value.workspaceId}/${value.appId}`;
    const prior = this.apps.get(key);
    cas(prior, expected);
    if (
      [...this.apps.values()].some(
        (app) =>
          app.workspaceId === value.workspaceId &&
          app.appId !== value.appId &&
          app.registration.appId === value.registration.appId,
      )
    )
      throw new ConflictError("App name exists");
    this.bump(value.workspaceId);
    const next = {
      ...value,
      revision: (prior?.revision ?? 0) + 1,
      generation: (prior?.generation ?? 0) + 1,
      lifecycleFence: nextLifecycleFence(prior, value),
    };
    this.apps.set(key, next);
    return clone(next);
  }
  public async putCredential(
    input: CredentialWrite,
    expected: number | null,
  ): Promise<WorkspaceCredential> {
    const value = validateCredential(input);
    const key = `${value.workspaceId}/${value.id}`;
    const prior = this.credentials.get(key);
    cas(prior, expected);
    if (
      [...this.credentials.values()].some(
        (c) => c.workspaceId === value.workspaceId && c.id !== value.id && c.hash === value.hash,
      )
    )
      throw new ConflictError("Credential exists");
    this.bump(value.workspaceId);
    const next = { ...value, revision: (prior?.revision ?? 0) + 1 };
    this.credentials.set(key, next);
    return clone(next);
  }
  public async credential(workspaceId: string, hash: string): Promise<WorkspaceCredential | null> {
    return clone(
      [...this.credentials.values()].find(
        (c) => c.workspaceId === workspaceId && c.hash === hash,
      ) ?? null,
    );
  }
  public async admitSource(
    input: SourceAdmitInput,
  ): Promise<{ record: SourceRecord; replay: boolean }> {
    validateSourceInput(input);
    if (!this.workspaces.has(input.workspaceId)) throw new NotFoundError("Workspace not found");
    const existing = [...this.sources.values()].find(
      (r) =>
        r.workspaceId === input.workspaceId &&
        r.appId === input.appId &&
        r.idempotencyKey === input.idempotencyKey &&
        !r.purging,
    );
    const now = input.now.getTime();
    const others = [...this.sources.values()].filter(
      (r) => r.workspaceId === input.workspaceId && r !== existing && !r.purging,
    );
    const usage: SourceUsage = {
      pendingForApp: others.filter(
        (r) =>
          r.appId === input.appId && r.state === "pending" && Date.parse(r.accessExpiresAt) > now,
      ).length,
      retainedBytes: others
        .filter((r) => Date.parse(r.retainUntil) > now || r.pinnedBy)
        .reduce((total, r) => total + r.bytes, 0),
    };
    const decision = decideSourceAdmission(existing, input, usage);
    if (!decision.write) return { record: clone(existing!), replay: decision.replay };
    const next = { ...decision.record, revision: (existing?.revision ?? 0) + 1 };
    this.sources.set(`${next.workspaceId}/${next.uploadId}`, next);
    return { record: clone(next), replay: decision.replay };
  }
  public async source(
    workspaceId: string,
    appId: string,
    uploadId: string,
  ): Promise<SourceRecord | null> {
    const record = this.sources.get(`${workspaceId}/${uploadId}`);
    return record && record.appId === appId && !record.purging ? clone(record) : null;
  }
  public async updateSource(next: SourceRecord, expected: number): Promise<SourceRecord> {
    const key = `${next.workspaceId}/${next.uploadId}`;
    const prior = this.sources.get(key);
    if (!prior || prior.revision !== expected || prior.purging)
      throw new ConflictError("Revision conflict");
    if (!sameSourceIdentity(prior, next)) throw new BadRequestError("Source identity is immutable");
    const value = { ...clone(next), revision: expected + 1 };
    this.sources.set(key, value);
    return clone(value);
  }
  public async expiredSources(now: Date, limit: number): Promise<SourceRecord[]> {
    return [...this.sources.values()]
      .filter((r) => Date.parse(r.retainUntil) <= now.getTime() && !r.pinnedBy)
      .sort((a, b) => a.retainUntil.localeCompare(b.retainUntil))
      .slice(0, limit)
      .map(clone);
  }
  public async deleteSource(record: SourceRecord): Promise<boolean> {
    const key = `${record.workspaceId}/${record.uploadId}`;
    if (this.sources.get(key)?.revision !== record.revision) return false;
    return this.sources.delete(key);
  }
  public async createArtifact(record: ArtifactWrite): Promise<ArtifactRecord> {
    validateArtifact(record);
    if (!this.workspaces.has(record.workspaceId)) throw new NotFoundError("Workspace not found");
    const duplicate = [...this.artifacts.values()].some(
      (a) =>
        a.workspaceId === record.workspaceId &&
        (a.artifactId === record.artifactId ||
          (a.appId === record.appId &&
            a.deploymentId === record.deploymentId &&
            a.attempt === record.attempt)),
    );
    if (duplicate) throw new ConflictError("Artifact exists");
    const value = { ...clone(record), revision: 1 };
    this.artifacts.set(`${record.workspaceId}/${record.artifactId}`, value);
    return clone(value);
  }
  public async artifact(
    workspaceId: string,
    appId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    const record = this.artifacts.get(`${workspaceId}/${artifactId}`);
    return record && record.appId === appId && !record.purging ? clone(record) : null;
  }
  public async artifactForAttempt(
    workspaceId: string,
    appId: string,
    deploymentId: string,
    attempt: number,
  ): Promise<ArtifactRecord | null> {
    const record = [...this.artifacts.values()].find(
      (a) =>
        a.workspaceId === workspaceId &&
        a.appId === appId &&
        a.deploymentId === deploymentId &&
        a.attempt === attempt &&
        !a.purging,
    );
    return record ? clone(record) : null;
  }
  public async updateArtifact(next: ArtifactRecord, expected: number): Promise<ArtifactRecord> {
    validateArtifact(next);
    const key = `${next.workspaceId}/${next.artifactId}`;
    const prior = this.artifacts.get(key);
    if (!prior || prior.revision !== expected || prior.purging)
      throw new ConflictError("Revision conflict");
    if (!artifactTransitionAllowed(prior, next))
      throw new BadRequestError("Artifact identity and decision are immutable");
    const value = { ...clone(next), revision: expected + 1 };
    this.artifacts.set(key, value);
    return clone(value);
  }
  public async expiredArtifacts(
    now: Date,
    limit: number,
    after?: ArtifactCursor,
  ): Promise<ArtifactRecord[]> {
    const key = (a: ArtifactCursor) =>
      [new Date(a.retainUntil).toISOString(), a.workspaceId, a.artifactId] as const;
    const compare = (a: ArtifactCursor, b: ArtifactCursor) => {
      const [x, y] = [key(a), key(b)];
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
      return 0;
    };
    return [...this.artifacts.values()]
      .filter((a) => Date.parse(a.retainUntil) <= now.getTime() && !a.pinnedBy)
      .filter((a) => !after || compare(a, after) > 0)
      .sort(compare)
      .slice(0, limit)
      .map(clone);
  }
  public async artifactKeys(
    workspaceId: string,
    appId: string,
  ): Promise<{ digests: ReadonlySet<string>; artifactIds: ReadonlySet<string> }> {
    const records = [...this.artifacts.values()].filter(
      (a) => a.workspaceId === workspaceId && a.appId === appId,
    );
    return {
      digests: new Set(records.flatMap((a) => (a.imageDigest ? [a.imageDigest] : []))),
      artifactIds: new Set(records.map((a) => a.artifactId)),
    };
  }
  public async deleteArtifact(record: ArtifactRecord): Promise<boolean> {
    const key = `${record.workspaceId}/${record.artifactId}`;
    const prior = this.artifacts.get(key);
    if (prior?.revision !== record.revision || prior.pinnedBy) return false;
    return this.artifacts.delete(key);
  }
  // M12 deployments. Every operation runs under one lock so a wake hook awaited "inside the
  // transaction" cannot interleave with another writer, and a failed hook writes nothing.
  private deployments = new Map<string, DeploymentRecord>();
  private releases = new Map<string, ReleaseRecord>();
  private txids = new Map<string, "in-progress" | "committed" | "aborted">();
  private txSequence = 1000;
  private serial: Promise<unknown> = Promise.resolve();
  private transaction<T>(work: (txid: string) => Promise<T>): Promise<T> {
    const run = this.serial.then(async () => {
      const txid = String((this.txSequence += 1));
      this.txids.set(txid, "in-progress");
      try {
        const result = await work(txid);
        this.txids.set(txid, "committed");
        return result;
      } catch (error) {
        this.txids.set(txid, "aborted");
        throw error;
      }
    });
    this.serial = run.catch(() => undefined);
    return run;
  }
  private deploymentKey(workspaceId: string, deploymentId: string): string {
    return `${workspaceId}/${deploymentId}`;
  }
  private catalogApp(workspaceId: string, appId: string): CatalogApp | undefined {
    return this.apps.get(`${workspaceId}/${appId}`);
  }
  public async submitDeployment(
    input: SubmitInput,
    wake: DeploymentWakeHook,
  ): Promise<{ record: DeploymentRecord; replay: boolean }> {
    validateSubmission(input);
    const { submission } = input;
    return this.transaction(async (txid) => {
      if (!this.workspaces.has(submission.workspaceId)) throw new DeploymentError("NOT_FOUND");
      const existing =
        [...this.deployments.values()].find(
          (d) =>
            d.workspaceId === submission.workspaceId &&
            d.appId === submission.appId &&
            d.idempotencyKey === submission.idempotencyKey,
        ) ?? null;
      const active = [...this.deployments.values()].filter(
        (d) => d.workspaceId === submission.workspaceId && !TERMINAL.has(d.state),
      );
      const sourceKey = `${submission.workspaceId}/${submission.source.uploadId}`;
      const decision = decideSubmit({
        existing: existing ? clone(existing) : null,
        request: input,
        app: appControl(this.catalogApp(submission.workspaceId, submission.appId)),
        source: clone(this.sources.get(sourceKey) ?? null),
        usage: {
          activeForApp: active.filter((d) => d.appId === submission.appId).length,
          activeForWorkspace: active.length,
        },
        deploymentId: newDeploymentId(),
      });
      if (decision.replay) return { record: clone(decision.record), replay: true };
      const record: DeploymentRecord = { ...decision.record, revision: 1 };
      const priorSource = this.sources.get(sourceKey)!;
      await wake([wakeFor(record, "submit")!], txid);
      this.sources.set(sourceKey, {
        ...clone(decision.source),
        revision: priorSource.revision + 1,
      });
      this.deployments.set(this.deploymentKey(record.workspaceId, record.deploymentId), record);
      return { record: clone(record), replay: false };
    });
  }
  public async deployment(
    workspaceId: string,
    appId: string,
    deploymentId: string,
  ): Promise<DeploymentRecord | null> {
    const record = this.deployments.get(this.deploymentKey(workspaceId, deploymentId));
    return record && record.appId === appId ? clone(record) : null;
  }
  public claimDeployment(
    key: { workspaceId: string; appId: string; deploymentId: string },
    now: Date,
    wake: DeploymentWakeHook,
  ): Promise<{ decision: ClaimDecision | { kind: "missing" } }> {
    return this.transaction(async (txid) => {
      const record = this.deployments.get(this.deploymentKey(key.workspaceId, key.deploymentId));
      if (!record || record.appId !== key.appId) return { decision: { kind: "missing" as const } };
      const decision = decideClaim(clone(record), now, newLeaseToken());
      if (decision.kind === "claimed" || decision.kind === "settled") {
        if (decision.wake) await wake([decision.wake], txid);
        this.deployments.set(this.deploymentKey(key.workspaceId, key.deploymentId), decision.next);
      }
      return { decision: clone(decision) };
    });
  }
  public completeDeployment(
    fence: CompletionFence,
    outcome: StageOutcome,
    now: Date,
    wake: DeploymentWakeHook,
  ): Promise<DeploymentRecord> {
    return this.transaction(async (txid) => {
      const key = this.deploymentKey(fence.workspaceId, fence.deploymentId);
      const record = this.deployments.get(key);
      if (!record) throw new StaleDeploymentError();
      const app = this.catalogApp(fence.workspaceId, fence.appId);
      let applied = outcome;
      let artifact: ArtifactRecord | undefined;
      if (outcome.kind === "promote") {
        artifact = record.artifactId
          ? this.artifacts.get(`${record.workspaceId}/${record.artifactId}`)
          : undefined;
        if (
          !artifact ||
          artifact.state !== "admitted" ||
          artifact.purging ||
          artifact.deploymentId !== record.deploymentId ||
          artifact.appId !== record.appId
        )
          applied = { kind: "fail", code: "DEPENDENCY_UNAVAILABLE", reason: "ARTIFACT_MISSING" };
      }
      const decision = decideComplete({
        record: clone(record),
        fence,
        outcome: applied,
        app: appControl(app),
        now,
      });
      if (decision.wake) await wake([decision.wake], txid);
      if (decision.promote) {
        const manifest = releaseManifest(record, artifact!, decision.promote.releaseId);
        const release: ReleaseRecord = {
          workspaceId: record.workspaceId,
          appId: record.appId,
          releaseId: decision.promote.releaseId,
          deploymentId: record.deploymentId,
          artifactId: artifact!.artifactId,
          imageReference: artifact!.imageReference!,
          generation: decision.promote.generation,
          manifest,
          createdAt: now.toISOString(),
        };
        this.releases.set(`${record.workspaceId}/${release.releaseId}`, release);
        this.apps.set(`${record.workspaceId}/${record.appId}`, {
          ...app!,
          activeRelease: release.releaseId,
          generation: decision.promote.generation,
          revision: app!.revision + 1,
        });
        this.bump(record.workspaceId);
        this.artifacts.set(`${record.workspaceId}/${artifact!.artifactId}`, {
          ...artifact!,
          pinnedBy: release.releaseId,
          revision: artifact!.revision + 1,
        });
      }
      this.deployments.set(key, decision.next);
      return clone(decision.next);
    });
  }
  public cancelDeployment(
    key: { workspaceId: string; appId: string; deploymentId: string },
    cancellationFence: number,
    now: Date,
    wake: DeploymentWakeHook,
  ): Promise<{ record: DeploymentRecord; changed: boolean }> {
    return this.transaction(async (txid) => {
      const id = this.deploymentKey(key.workspaceId, key.deploymentId);
      const record = this.deployments.get(id);
      if (!record || record.appId !== key.appId) throw new DeploymentError("NOT_FOUND");
      const decision = decideCancel(clone(record), cancellationFence, now);
      if (!decision.changed) return { record: clone(record), changed: false };
      if (decision.wake) await wake([decision.wake], txid);
      this.deployments.set(id, decision.next);
      return { record: clone(decision.next), changed: true };
    });
  }
  public finishCleanup(
    key: { workspaceId: string; appId: string; deploymentId: string },
    epoch: number,
    done: boolean,
    now: Date,
    wake: DeploymentWakeHook,
  ): Promise<void> {
    return this.transaction(async (txid) => {
      const id = this.deploymentKey(key.workspaceId, key.deploymentId);
      const record = this.deployments.get(id);
      if (!record || record.appId !== key.appId) return;
      const decision = decideCleanup(clone(record), epoch, done, now);
      if (!decision) return;
      if (decision.wake) await wake([decision.wake], txid);
      this.deployments.set(id, decision.next);
    });
  }
  public async appStatus(workspaceId: string, appId: string): Promise<AppControl | null> {
    return appControl(this.catalogApp(workspaceId, appId));
  }
  public async release(
    workspaceId: string,
    appId: string,
    releaseId: string,
  ): Promise<ReleaseRecord | null> {
    const release = this.releases.get(`${workspaceId}/${releaseId}`);
    return release && release.appId === appId ? clone(release) : null;
  }
  public async overdueDeployments(
    now: Date,
    limit: number,
    workspaceId?: string,
  ): Promise<readonly DeploymentRecord[]> {
    return [...this.deployments.values()]
      .filter(
        (d) => (workspaceId === undefined || d.workspaceId === workspaceId) && isOverdue(d, now),
      )
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .slice(0, Math.max(1, Math.min(100, Math.trunc(limit))))
      .map(clone);
  }
  public async transactionStatus(
    txid: string,
  ): Promise<"in-progress" | "committed" | "aborted" | "unknown"> {
    return this.txids.get(txid) ?? "unknown";
  }
  public async close(): Promise<void> {}
}
/* eslint-enable @typescript-eslint/require-await */
/** Platform database only. Migrations must be invoked separately using the maintenance role. */
export class PostgresGatewayStore
  implements GatewayStore, SourceStore, ArtifactStore, DeploymentStore
{
  private readonly pool: Pool;
  private closing?: Promise<void>;
  public constructor(
    connectionString: string,
    private readonly policy: GatewayRegistryOptions = defaultPolicy,
  ) {
    this.pool = new Pool({
      connectionString,
      max: 5,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      statement_timeout: 5000,
    });
    // pg emits connection errors on checked-out clients as well as its idle pool.
    // Query promises still reject; prevent an uncaught EventEmitter error from
    // crashing the gateway. Never expose driver text or use a stale fallback.
    this.pool.on("error", () => undefined);
    this.pool.on("connect", (client) => {
      client.on("error", () => {
        console.warn(
          "Gateway store connection lost; authoritative requests reconnect or fail closed",
        );
      });
    });
  }
  public async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const authority = await client.query<{ allowed: boolean }>(
        "SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed",
      );
      if (!authority.rows[0]?.allowed)
        throw new Error("Platform migrations require maintenance authority");
      await client.query("SELECT pg_advisory_xact_lock(6240401)");
      await client.query(`CREATE TABLE IF NOT EXISTS embody_platform_workspaces (id text PRIMARY KEY, revision bigint NOT NULL CHECK (revision > 0));
        CREATE TABLE IF NOT EXISTS embody_platform_apps (workspace_id text NOT NULL REFERENCES embody_platform_workspaces(id), id text NOT NULL, name text NOT NULL, document jsonb NOT NULL, PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,name));
        CREATE TABLE IF NOT EXISTS embody_platform_credentials (workspace_id text NOT NULL REFERENCES embody_platform_workspaces(id), id text NOT NULL, hash text NOT NULL, document jsonb NOT NULL, PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,hash));
        CREATE TABLE IF NOT EXISTS embody_platform_quotas (workspace_id text PRIMARY KEY REFERENCES embody_platform_workspaces(id), used integer NOT NULL, reset_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS embody_platform_audit (workspace_id text NOT NULL REFERENCES embody_platform_workspaces(id), request_id text NOT NULL, document jsonb NOT NULL, admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_until timestamptz NOT NULL, completed boolean NOT NULL DEFAULT false, PRIMARY KEY(workspace_id,request_id));
        CREATE INDEX IF NOT EXISTS embody_platform_audit_lease ON embody_platform_audit(workspace_id,lease_until) WHERE NOT completed;
        CREATE TABLE IF NOT EXISTS embody_platform_sources (workspace_id text NOT NULL REFERENCES embody_platform_workspaces(id), upload_id text NOT NULL, app_id text NOT NULL, idempotency_key text NOT NULL, state text NOT NULL CHECK (state IN ('pending','verified','rejected')), bytes bigint NOT NULL CHECK (bytes > 0), access_expires_at timestamptz NOT NULL, retain_until timestamptz NOT NULL, pinned boolean NOT NULL DEFAULT false, purging boolean NOT NULL DEFAULT false, revision bigint NOT NULL CHECK (revision > 0), document jsonb NOT NULL, PRIMARY KEY(workspace_id,upload_id));
        CREATE UNIQUE INDEX IF NOT EXISTS embody_platform_sources_key ON embody_platform_sources(workspace_id,app_id,idempotency_key) WHERE NOT purging;
        CREATE INDEX IF NOT EXISTS embody_platform_sources_retention ON embody_platform_sources(retain_until) WHERE NOT pinned;
        CREATE TABLE IF NOT EXISTS embody_platform_artifacts (workspace_id text NOT NULL REFERENCES embody_platform_workspaces(id), artifact_id text NOT NULL, app_id text NOT NULL, deployment_id text NOT NULL, attempt integer NOT NULL CHECK (attempt > 0), state text NOT NULL CHECK (state IN ('building','admitted','rejected')), image_digest text, retain_until timestamptz NOT NULL, pinned boolean NOT NULL DEFAULT false, purging boolean NOT NULL DEFAULT false, revision bigint NOT NULL CHECK (revision > 0), document jsonb NOT NULL, PRIMARY KEY(workspace_id,artifact_id), UNIQUE(workspace_id,app_id,deployment_id,attempt));
        CREATE INDEX IF NOT EXISTS embody_platform_artifacts_retention ON embody_platform_artifacts(retain_until) WHERE NOT pinned;
        CREATE TABLE IF NOT EXISTS embody_platform_deployments (workspace_id text NOT NULL REFERENCES embody_platform_workspaces(id), deployment_id text NOT NULL, app_id text NOT NULL, idempotency_key text NOT NULL, state text NOT NULL CHECK (state IN ('accepted','validating','building','provisioning','checking','promoting','active','failed','cancelled')), due_at timestamptz NOT NULL, lease_until timestamptz, cleanup boolean NOT NULL DEFAULT false, retain_until timestamptz NOT NULL, revision bigint NOT NULL CHECK (revision > 0), document jsonb NOT NULL, PRIMARY KEY(workspace_id,deployment_id), UNIQUE(workspace_id,app_id,idempotency_key));
        CREATE INDEX IF NOT EXISTS embody_platform_deployments_due ON embody_platform_deployments(due_at) WHERE state NOT IN ('active','failed','cancelled') OR cleanup;
        CREATE TABLE IF NOT EXISTS embody_platform_releases (workspace_id text NOT NULL REFERENCES embody_platform_workspaces(id), release_id text NOT NULL, app_id text NOT NULL, deployment_id text NOT NULL, artifact_id text NOT NULL, created_at timestamptz NOT NULL, document jsonb NOT NULL, PRIMARY KEY(workspace_id,release_id), UNIQUE(workspace_id,deployment_id));`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  public async createWorkspace(workspaceId: string): Promise<Workspace> {
    id(workspaceId);
    try {
      await this.pool.query("INSERT INTO embody_platform_workspaces(id,revision) VALUES($1,1)", [
        workspaceId,
      ]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new ConflictError("Workspace exists");
      throw error;
    }
    return { id: workspaceId, revision: 1 };
  }
  public async snapshot(workspaceId: string): Promise<WorkspaceSnapshot | null> {
    const result = await this.pool.query<{ id: string; revision: string; apps: CatalogApp[] }>(
      `SELECT w.id,w.revision, COALESCE(jsonb_agg(a.document ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL),'[]'::jsonb) AS apps
      FROM embody_platform_workspaces w LEFT JOIN embody_platform_apps a ON a.workspace_id=w.id WHERE w.id=$1 GROUP BY w.id,w.revision`,
      [workspaceId],
    );
    const row = result.rows[0];
    return row
      ? { workspace: { id: row.id, revision: Number(row.revision) }, apps: row.apps }
      : null;
  }
  private async write<T extends { workspaceId: string; id?: string; appId?: string }, R>(
    table: "apps" | "credentials",
    value: T,
    expected: number | null,
    build: (prior: R | undefined) => R,
  ): Promise<R> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const workspace = await client.query(
        "SELECT id FROM embody_platform_workspaces WHERE id=$1 FOR UPDATE",
        [value.workspaceId],
      );
      if (!workspace.rows.length) throw new NotFoundError("Workspace not found");
      const key = value.appId ?? value.id;
      const existing = await client.query<{ document: R }>(
        `SELECT document FROM embody_platform_${table} WHERE workspace_id=$1 AND id=$2`,
        [value.workspaceId, key],
      );
      const prior = existing.rows[0]?.document;
      cas(prior as { revision: number } | undefined, expected);
      const next = build(prior);
      if (table === "credentials")
        await client.query(
          `INSERT INTO embody_platform_credentials(workspace_id,id,hash,document) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,id) DO UPDATE SET hash=EXCLUDED.hash,document=EXCLUDED.document`,
          [value.workspaceId, key, (next as WorkspaceCredential).hash, next],
        );
      else
        await client.query(
          `INSERT INTO embody_platform_apps(workspace_id,id,name,document) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,id) DO UPDATE SET name=EXCLUDED.name,document=EXCLUDED.document`,
          [value.workspaceId, key, (next as CatalogApp).registration.appId, next],
        );
      await client.query("UPDATE embody_platform_workspaces SET revision=revision+1 WHERE id=$1", [
        value.workspaceId,
      ]);
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505")
        throw new ConflictError("Record identity/name exists");
      throw error;
    } finally {
      client.release();
    }
  }
  public async putApp(input: CatalogWrite, expected: number | null): Promise<CatalogApp> {
    const value = validateApp(input, this.policy);
    return this.write<CatalogWrite, CatalogApp>("apps", value, expected, (prior) => ({
      ...value,
      revision: (prior?.revision ?? 0) + 1,
      generation: (prior?.generation ?? 0) + 1,
      lifecycleFence: nextLifecycleFence(prior, value),
    }));
  }
  public async putCredential(
    input: CredentialWrite,
    expected: number | null,
  ): Promise<WorkspaceCredential> {
    const value = validateCredential(input);
    return this.write<CredentialWrite, WorkspaceCredential>(
      "credentials",
      value,
      expected,
      (prior) => ({ ...value, revision: (prior?.revision ?? 0) + 1 }),
    );
  }
  public async credential(workspaceId: string, hash: string): Promise<WorkspaceCredential | null> {
    return (
      (
        await this.pool.query<{ document: WorkspaceCredential }>(
          "SELECT document FROM embody_platform_credentials WHERE workspace_id=$1 AND hash=$2",
          [workspaceId, hash],
        )
      ).rows[0]?.document ?? null
    );
  }
  public async admit(record: AuditRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One serialization point per workspace: quota increment and audit intent commit together.
      const workspace = await client.query(
        "SELECT id FROM embody_platform_workspaces WHERE id=$1 FOR UPDATE",
        [record.orgId],
      );
      if (!workspace.rowCount) throw new NotFoundError("Workspace not found");
      await client.query(
        `INSERT INTO embody_platform_quotas(workspace_id,used,reset_at) VALUES($1,0,clock_timestamp()+interval '60 seconds') ON CONFLICT(workspace_id) DO NOTHING`,
        [record.orgId],
      );
      const quota = await client.query<{ used: number; retry: number }>(
        `SELECT CASE WHEN reset_at <= clock_timestamp() THEN 0 ELSE used END AS used, GREATEST(1,ceil(extract(epoch FROM reset_at-clock_timestamp())))::int AS retry FROM embody_platform_quotas WHERE workspace_id=$1`,
        [record.orgId],
      );
      const active = await client.query<{ count: string }>(
        `SELECT count(*) FROM embody_platform_audit WHERE workspace_id=$1 AND NOT completed AND lease_until>clock_timestamp()`,
        [record.orgId],
      );
      if (quota.rows[0]!.used >= 60 || Number(active.rows[0]!.count) >= 20)
        throw new DispatchRateLimitedError(quota.rows[0]!.retry);
      await client.query(
        `UPDATE embody_platform_quotas SET used=CASE WHEN reset_at<=clock_timestamp() THEN 1 ELSE used+1 END, reset_at=CASE WHEN reset_at<=clock_timestamp() THEN clock_timestamp()+interval '60 seconds' ELSE reset_at END WHERE workspace_id=$1`,
        [record.orgId],
      );
      await client.query(
        `INSERT INTO embody_platform_audit(workspace_id,request_id,document,lease_until) VALUES($1,$2,$3,clock_timestamp()+interval '60 seconds')`,
        [record.orgId, record.requestId, record],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505")
        throw new ConflictError("Request already admitted");
      throw error;
    } finally {
      client.release();
    }
  }
  public async complete(record: AuditRecord): Promise<void> {
    await this.pool.query(
      `UPDATE embody_platform_audit SET document=$3,completed=true,lease_until=clock_timestamp() WHERE workspace_id=$1 AND request_id=$2 AND NOT completed`,
      [record.orgId, record.requestId, record],
    );
  }
  public async admitSource(
    input: SourceAdmitInput,
  ): Promise<{ record: SourceRecord; replay: boolean }> {
    validateSourceInput(input);
    // The sweep's fence and completions CAS the row without the workspace lock, so the upsert is
    // revision-checked; a lost race re-reads (a fenced row is then ignored and a fresh identity
    // allocated, a completed one replayed).
    for (let attempt = 1; ; attempt += 1) {
      const admitted = await this.tryAdmitSource(input);
      if (admitted) return admitted;
      if (attempt >= 3) throw new ConflictError("Revision conflict");
    }
  }
  private async tryAdmitSource(
    input: SourceAdmitInput,
  ): Promise<{ record: SourceRecord; replay: boolean } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Same per-workspace serialization point as catalog writes and dispatch quotas.
      const workspace = await client.query(
        "SELECT id FROM embody_platform_workspaces WHERE id=$1 FOR UPDATE",
        [input.workspaceId],
      );
      if (!workspace.rowCount) throw new NotFoundError("Workspace not found");
      const existing = (
        await client.query<{ document: SourceRecord }>(
          "SELECT document FROM embody_platform_sources WHERE workspace_id=$1 AND app_id=$2 AND idempotency_key=$3 AND NOT purging",
          [input.workspaceId, input.appId, input.idempotencyKey],
        )
      ).rows[0]?.document;
      const usage = (
        await client.query<{ pending: number; bytes: string }>(
          `SELECT count(*) FILTER (WHERE app_id=$2 AND state='pending' AND access_expires_at>$4)::int AS pending,
            COALESCE(sum(bytes) FILTER (WHERE retain_until>$4 OR pinned),0)::text AS bytes
          FROM embody_platform_sources WHERE workspace_id=$1 AND NOT purging AND NOT (app_id=$2 AND idempotency_key=$3)`,
          [input.workspaceId, input.appId, input.idempotencyKey, input.now],
        )
      ).rows[0]!;
      const decision = decideSourceAdmission(existing, input, {
        pendingForApp: usage.pending,
        retainedBytes: Number(usage.bytes),
      });
      if (!decision.write) {
        await client.query("COMMIT");
        return { record: existing!, replay: decision.replay };
      }
      const next: SourceRecord = { ...decision.record, revision: (existing?.revision ?? 0) + 1 };
      const written = await client.query(
        `INSERT INTO embody_platform_sources(workspace_id,upload_id,app_id,idempotency_key,state,bytes,access_expires_at,retain_until,pinned,revision,document)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(workspace_id,upload_id) DO UPDATE SET state=EXCLUDED.state,access_expires_at=EXCLUDED.access_expires_at,retain_until=EXCLUDED.retain_until,pinned=EXCLUDED.pinned,revision=EXCLUDED.revision,document=EXCLUDED.document
        WHERE embody_platform_sources.revision=$12 AND NOT embody_platform_sources.purging`,
        [
          next.workspaceId,
          next.uploadId,
          next.appId,
          next.idempotencyKey,
          next.state,
          next.bytes,
          next.accessExpiresAt,
          next.retainUntil,
          Boolean(next.pinnedBy),
          next.revision,
          next,
          existing?.revision ?? 0,
        ],
      );
      if (!written.rowCount) {
        // Fenced by the sweep or advanced by a completion since it was read.
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("COMMIT");
      return { record: next, replay: decision.replay };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505")
        throw new ConflictError("Source identity exists");
      throw error;
    } finally {
      client.release();
    }
  }
  public async source(
    workspaceId: string,
    appId: string,
    uploadId: string,
  ): Promise<SourceRecord | null> {
    return (
      (
        await this.pool.query<{ document: SourceRecord }>(
          "SELECT document FROM embody_platform_sources WHERE workspace_id=$1 AND app_id=$2 AND upload_id=$3 AND NOT purging",
          [workspaceId, appId, uploadId],
        )
      ).rows[0]?.document ?? null
    );
  }
  public async updateSource(next: SourceRecord, expected: number): Promise<SourceRecord> {
    if (!Number.isSafeInteger(expected) || expected < 1)
      throw new BadRequestError("Invalid revision");
    const value: SourceRecord = { ...next, revision: expected + 1 };
    const result = await this.pool.query<{ document: SourceRecord }>(
      `UPDATE embody_platform_sources SET state=$5,access_expires_at=$6,retain_until=$7,pinned=$8,revision=$9,document=$10,purging=$15
      WHERE workspace_id=$1 AND upload_id=$2 AND app_id=$3 AND revision=$4 AND idempotency_key=$11
        AND document->>'objectKey'=$12 AND document->>'digest'=$13 AND bytes=$14 AND NOT purging RETURNING document`,
      [
        value.workspaceId,
        value.uploadId,
        value.appId,
        expected,
        value.state,
        value.accessExpiresAt,
        value.retainUntil,
        Boolean(value.pinnedBy),
        value.revision,
        value,
        value.idempotencyKey,
        value.objectKey,
        value.digest,
        value.bytes,
        Boolean(value.purging),
      ],
    );
    // Revision, purging tombstone or immutable identity mismatch: never overwrite another record's identity.
    if (!result.rowCount) throw new ConflictError("Revision conflict");
    return value;
  }
  public async expiredSources(now: Date, limit: number): Promise<SourceRecord[]> {
    return (
      await this.pool.query<{ document: SourceRecord; purging: boolean }>(
        "SELECT document,purging FROM embody_platform_sources WHERE retain_until<=$1 AND NOT pinned ORDER BY retain_until LIMIT $2",
        [now, Math.max(1, Math.min(1000, Math.trunc(limit)))],
      )
    ).rows.map((row) => (row.purging ? { ...row.document, purging: true } : row.document));
  }
  public async deleteSource(record: SourceRecord): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM embody_platform_sources WHERE workspace_id=$1 AND upload_id=$2 AND revision=$3 AND NOT pinned",
      [record.workspaceId, record.uploadId, record.revision],
    );
    return (result.rowCount ?? 0) > 0;
  }
  public async createArtifact(record: ArtifactWrite): Promise<ArtifactRecord> {
    validateArtifact(record);
    const value: ArtifactRecord = { ...record, revision: 1 };
    try {
      const result = await this.pool.query(
        `INSERT INTO embody_platform_artifacts(workspace_id,artifact_id,app_id,deployment_id,attempt,state,image_digest,retain_until,pinned,revision,document)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10 WHERE EXISTS (SELECT 1 FROM embody_platform_workspaces WHERE id=$1)`,
        [
          value.workspaceId,
          value.artifactId,
          value.appId,
          value.deploymentId,
          value.attempt,
          value.state,
          value.imageDigest ?? null,
          value.retainUntil,
          Boolean(value.pinnedBy),
          value,
        ],
      );
      if (!result.rowCount) throw new NotFoundError("Workspace not found");
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ConflictError("Artifact exists");
      throw error;
    }
    return value;
  }
  public async artifact(
    workspaceId: string,
    appId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    return (
      (
        await this.pool.query<{ document: ArtifactRecord }>(
          "SELECT document FROM embody_platform_artifacts WHERE workspace_id=$1 AND app_id=$2 AND artifact_id=$3 AND NOT purging",
          [workspaceId, appId, artifactId],
        )
      ).rows[0]?.document ?? null
    );
  }
  public async artifactForAttempt(
    workspaceId: string,
    appId: string,
    deploymentId: string,
    attempt: number,
  ): Promise<ArtifactRecord | null> {
    return (
      (
        await this.pool.query<{ document: ArtifactRecord }>(
          "SELECT document FROM embody_platform_artifacts WHERE workspace_id=$1 AND app_id=$2 AND deployment_id=$3 AND attempt=$4 AND NOT purging",
          [workspaceId, appId, deploymentId, attempt],
        )
      ).rows[0]?.document ?? null
    );
  }
  public async updateArtifact(next: ArtifactRecord, expected: number): Promise<ArtifactRecord> {
    validateArtifact(next);
    if (!Number.isSafeInteger(expected) || expected < 1)
      throw new BadRequestError("Invalid revision");
    const prior = (
      await this.pool.query<{ document: ArtifactRecord }>(
        "SELECT document FROM embody_platform_artifacts WHERE workspace_id=$1 AND artifact_id=$2 AND revision=$3 AND NOT purging",
        [next.workspaceId, next.artifactId, expected],
      )
    ).rows[0]?.document;
    if (!prior) throw new ConflictError("Revision conflict");
    if (!artifactTransitionAllowed(prior, next))
      throw new BadRequestError("Artifact identity and decision are immutable");
    const value: ArtifactRecord = { ...next, revision: expected + 1 };
    const result = await this.pool.query(
      `UPDATE embody_platform_artifacts SET state=$4,image_digest=$5,retain_until=$6,pinned=$7,purging=$8,revision=$9,document=$10
      WHERE workspace_id=$1 AND artifact_id=$2 AND revision=$3 AND NOT purging`,
      [
        value.workspaceId,
        value.artifactId,
        expected,
        value.state,
        value.imageDigest ?? null,
        value.retainUntil,
        Boolean(value.pinnedBy),
        Boolean(value.purging),
        value.revision,
        value,
      ],
    );
    if (!result.rowCount) throw new ConflictError("Revision conflict");
    return value;
  }
  public async expiredArtifacts(
    now: Date,
    limit: number,
    after?: ArtifactCursor,
  ): Promise<ArtifactRecord[]> {
    const bounded = Math.max(1, Math.min(1000, Math.trunc(limit)));
    // Byte-order collation: the cursor order must not depend on the database locale.
    const order =
      'ORDER BY retain_until, workspace_id COLLATE "C", artifact_id COLLATE "C" LIMIT $2';
    const result = after
      ? await this.pool.query<{ document: ArtifactRecord; purging: boolean }>(
          `SELECT document,purging FROM embody_platform_artifacts WHERE retain_until<=$1 AND NOT pinned
          AND (retain_until, workspace_id COLLATE "C", artifact_id COLLATE "C") > ($3::timestamptz, $4 COLLATE "C", $5 COLLATE "C") ${order}`,
          [now, bounded, after.retainUntil, after.workspaceId, after.artifactId],
        )
      : await this.pool.query<{ document: ArtifactRecord; purging: boolean }>(
          `SELECT document,purging FROM embody_platform_artifacts WHERE retain_until<=$1 AND NOT pinned ${order}`,
          [now, bounded],
        );
    return result.rows.map((row) =>
      row.purging ? { ...row.document, purging: true } : row.document,
    );
  }
  public async artifactKeys(
    workspaceId: string,
    appId: string,
  ): Promise<{ digests: ReadonlySet<string>; artifactIds: ReadonlySet<string> }> {
    const rows = (
      await this.pool.query<{ artifact_id: string; image_digest: string | null }>(
        "SELECT artifact_id,image_digest FROM embody_platform_artifacts WHERE workspace_id=$1 AND app_id=$2",
        [workspaceId, appId],
      )
    ).rows;
    return {
      digests: new Set(rows.flatMap((row) => (row.image_digest ? [row.image_digest] : []))),
      artifactIds: new Set(rows.map((row) => row.artifact_id)),
    };
  }
  public async deleteArtifact(record: ArtifactRecord): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM embody_platform_artifacts WHERE workspace_id=$1 AND artifact_id=$2 AND revision=$3 AND NOT pinned",
      [record.workspaceId, record.artifactId, record.revision],
    );
    return (result.rowCount ?? 0) > 0;
  }
  // M12 deployments. Lock order is always workspace row, then deployment row, then the source or
  // artifact row, so submissions, claims, completions and cancellations cannot deadlock. The wake
  // hook runs inside the transaction before COMMIT: an enqueue failure rolls the write back.
  private async deploymentTransaction<T>(
    work: (client: PoolClient, txid: () => Promise<string>) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const txid = async () =>
        (await client.query<{ txid: string }>("SELECT txid_current()::text AS txid")).rows[0]!.txid;
      const result = await work(client, txid);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  private async lockDeployment(
    client: PoolClient,
    workspaceId: string,
    deploymentId: string,
  ): Promise<DeploymentRecord | undefined> {
    return (
      await client.query<{ document: DeploymentRecord }>(
        "SELECT document FROM embody_platform_deployments WHERE workspace_id=$1 AND deployment_id=$2 FOR UPDATE",
        [workspaceId, deploymentId],
      )
    ).rows[0]?.document;
  }
  private async writeDeployment(
    client: PoolClient,
    next: DeploymentRecord,
    expected: number,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE embody_platform_deployments SET state=$3,due_at=$4,lease_until=$5,cleanup=$6,retain_until=$7,revision=$8,document=$9
      WHERE workspace_id=$1 AND deployment_id=$2 AND revision=$10`,
      [
        next.workspaceId,
        next.deploymentId,
        next.state,
        next.dueAt,
        next.leaseUntil ?? null,
        next.cleanup,
        next.retainUntil,
        next.revision,
        next,
        expected,
      ],
    );
    // Rows are locked FOR UPDATE first, so a miss is a broken invariant, never a lost race.
    if (result.rowCount !== 1) throw new ConflictError("Deployment revision conflict");
  }
  private async catalogDocument(
    client: PoolClient,
    workspaceId: string,
    appId: string,
  ): Promise<CatalogApp | undefined> {
    return (
      await client.query<{ document: CatalogApp }>(
        "SELECT document FROM embody_platform_apps WHERE workspace_id=$1 AND id=$2",
        [workspaceId, appId],
      )
    ).rows[0]?.document;
  }
  public async submitDeployment(
    input: SubmitInput,
    wake: DeploymentWakeHook,
  ): Promise<{ record: DeploymentRecord; replay: boolean }> {
    validateSubmission(input);
    const { submission } = input;
    try {
      return await this.deploymentTransaction(async (client, txid) => {
        // Same per-workspace serialization point as catalog writes, quotas and source admission.
        const workspace = await client.query(
          "SELECT id FROM embody_platform_workspaces WHERE id=$1 FOR UPDATE",
          [submission.workspaceId],
        );
        if (!workspace.rowCount) throw new DeploymentError("NOT_FOUND");
        const existing =
          (
            await client.query<{ document: DeploymentRecord }>(
              "SELECT document FROM embody_platform_deployments WHERE workspace_id=$1 AND app_id=$2 AND idempotency_key=$3",
              [submission.workspaceId, submission.appId, submission.idempotencyKey],
            )
          ).rows[0]?.document ?? null;
        const source = (
          await client.query<{ document: SourceRecord; purging: boolean; revision: string }>(
            "SELECT document,purging,revision FROM embody_platform_sources WHERE workspace_id=$1 AND upload_id=$2 AND app_id=$3 FOR UPDATE",
            [submission.workspaceId, submission.source.uploadId, submission.appId],
          )
        ).rows[0];
        const usage = (
          await client.query<{ app: number; workspace: number }>(
            `SELECT count(*) FILTER (WHERE app_id=$2)::int AS app, count(*)::int AS workspace
            FROM embody_platform_deployments WHERE workspace_id=$1 AND state NOT IN ('active','failed','cancelled')`,
            [submission.workspaceId, submission.appId],
          )
        ).rows[0]!;
        const decision = decideSubmit({
          existing,
          request: input,
          app: appControl(
            await this.catalogDocument(client, submission.workspaceId, submission.appId),
          ),
          source: source
            ? source.purging
              ? { ...source.document, purging: true }
              : source.document
            : null,
          usage: { activeForApp: usage.app, activeForWorkspace: usage.workspace },
          deploymentId: newDeploymentId(),
        });
        if (decision.replay) return { record: decision.record, replay: true };
        const record: DeploymentRecord = { ...decision.record, revision: 1 };
        const pinned: SourceRecord = {
          ...decision.source,
          revision: Number(source!.revision) + 1,
        };
        const pin = await client.query(
          `UPDATE embody_platform_sources SET pinned=true,retain_until=$4,revision=$5,document=$6
          WHERE workspace_id=$1 AND upload_id=$2 AND revision=$3 AND NOT purging`,
          [
            pinned.workspaceId,
            pinned.uploadId,
            source!.revision,
            pinned.retainUntil,
            pinned.revision,
            pinned,
          ],
        );
        if (pin.rowCount !== 1) throw new DeploymentError("INVALID_INPUT");
        await client.query(
          `INSERT INTO embody_platform_deployments(workspace_id,deployment_id,app_id,idempotency_key,state,due_at,lease_until,cleanup,retain_until,revision,document)
          VALUES($1,$2,$3,$4,$5,$6,NULL,false,$7,1,$8)`,
          [
            record.workspaceId,
            record.deploymentId,
            record.appId,
            record.idempotencyKey,
            record.state,
            record.dueAt,
            record.retainUntil,
            record,
          ],
        );
        await wake([wakeFor(record, "submit")!], await txid());
        return { record, replay: false };
      });
    } catch (error) {
      // A concurrent submission with the same key (impossible under the workspace lock) or a
      // colliding random ID: report a retryable conflict, never a partial write.
      if ((error as { code?: string }).code === "23505")
        throw new ConflictError("Deployment identity exists");
      throw error;
    }
  }
  public async deployment(
    workspaceId: string,
    appId: string,
    deploymentId: string,
  ): Promise<DeploymentRecord | null> {
    return (
      (
        await this.pool.query<{ document: DeploymentRecord }>(
          "SELECT document FROM embody_platform_deployments WHERE workspace_id=$1 AND app_id=$2 AND deployment_id=$3",
          [workspaceId, appId, deploymentId],
        )
      ).rows[0]?.document ?? null
    );
  }
  public claimDeployment(
    key: { workspaceId: string; appId: string; deploymentId: string },
    now: Date,
    wake: DeploymentWakeHook,
  ): Promise<{ decision: ClaimDecision | { kind: "missing" } }> {
    return this.deploymentTransaction(async (client, txid) => {
      const record = await this.lockDeployment(client, key.workspaceId, key.deploymentId);
      if (!record || record.appId !== key.appId) return { decision: { kind: "missing" as const } };
      const decision = decideClaim(record, now, newLeaseToken());
      if (decision.kind === "claimed" || decision.kind === "settled") {
        await this.writeDeployment(client, decision.next, record.revision);
        if (decision.wake) await wake([decision.wake], await txid());
      }
      return { decision };
    });
  }
  public completeDeployment(
    fence: CompletionFence,
    outcome: StageOutcome,
    now: Date,
    wake: DeploymentWakeHook,
  ): Promise<DeploymentRecord> {
    return this.deploymentTransaction(async (client, txid) => {
      if (outcome.kind === "promote") {
        // Promotion writes the catalog: take the workspace lock first (lock order).
        const workspace = await client.query(
          "SELECT id FROM embody_platform_workspaces WHERE id=$1 FOR UPDATE",
          [fence.workspaceId],
        );
        if (!workspace.rowCount) throw new StaleDeploymentError();
      }
      const record = await this.lockDeployment(client, fence.workspaceId, fence.deploymentId);
      if (!record) throw new StaleDeploymentError();
      const app = await this.catalogDocument(client, fence.workspaceId, fence.appId);
      let applied = outcome;
      let artifact: ArtifactRecord | undefined;
      if (outcome.kind === "promote") {
        const row = record.artifactId
          ? (
              await client.query<{ document: ArtifactRecord; purging: boolean; state: string }>(
                "SELECT document,purging,state FROM embody_platform_artifacts WHERE workspace_id=$1 AND artifact_id=$2 FOR UPDATE",
                [record.workspaceId, record.artifactId],
              )
            ).rows[0]
          : undefined;
        artifact = row && !row.purging && row.state === "admitted" ? row.document : undefined;
        if (
          !artifact ||
          artifact.deploymentId !== record.deploymentId ||
          artifact.appId !== record.appId
        )
          applied = { kind: "fail", code: "DEPENDENCY_UNAVAILABLE", reason: "ARTIFACT_MISSING" };
      }
      const decision = decideComplete({
        record,
        fence,
        outcome: applied,
        app: appControl(app),
        now,
      });
      if (decision.promote) {
        const releaseId = decision.promote.releaseId;
        const manifest = releaseManifest(record, artifact!, releaseId);
        const release: ReleaseRecord = {
          workspaceId: record.workspaceId,
          appId: record.appId,
          releaseId,
          deploymentId: record.deploymentId,
          artifactId: artifact!.artifactId,
          imageReference: artifact!.imageReference!,
          generation: decision.promote.generation,
          manifest,
          createdAt: now.toISOString(),
        };
        await client.query(
          `INSERT INTO embody_platform_releases(workspace_id,release_id,app_id,deployment_id,artifact_id,created_at,document)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            release.workspaceId,
            releaseId,
            release.appId,
            release.deploymentId,
            release.artifactId,
            release.createdAt,
            release,
          ],
        );
        const promoted: CatalogApp = {
          ...app!,
          activeRelease: releaseId,
          generation: decision.promote.generation,
          revision: app!.revision + 1,
        };
        // CAS on the generation read under the workspace lock (canPromote already compared it).
        const pointer = await client.query(
          `UPDATE embody_platform_apps SET document=$3 WHERE workspace_id=$1 AND id=$2 AND (document->>'generation')::bigint=$4`,
          [record.workspaceId, record.appId, promoted, app!.generation],
        );
        if (pointer.rowCount !== 1) throw new ConflictError("App generation conflict");
        await client.query(
          "UPDATE embody_platform_workspaces SET revision=revision+1 WHERE id=$1",
          [record.workspaceId],
        );
        const pinned: ArtifactRecord = {
          ...artifact!,
          pinnedBy: releaseId,
          revision: artifact!.revision + 1,
        };
        const pin = await client.query(
          `UPDATE embody_platform_artifacts SET pinned=true,revision=$3,document=$4
          WHERE workspace_id=$1 AND artifact_id=$2 AND revision=$5 AND state='admitted' AND NOT purging`,
          [pinned.workspaceId, pinned.artifactId, pinned.revision, pinned, artifact!.revision],
        );
        if (pin.rowCount !== 1) throw new ConflictError("Artifact revision conflict");
      }
      await this.writeDeployment(client, decision.next, record.revision);
      if (decision.wake) await wake([decision.wake], await txid());
      return decision.next;
    });
  }
  public cancelDeployment(
    key: { workspaceId: string; appId: string; deploymentId: string },
    cancellationFence: number,
    now: Date,
    wake: DeploymentWakeHook,
  ): Promise<{ record: DeploymentRecord; changed: boolean }> {
    return this.deploymentTransaction(async (client, txid) => {
      const record = await this.lockDeployment(client, key.workspaceId, key.deploymentId);
      if (!record || record.appId !== key.appId) throw new DeploymentError("NOT_FOUND");
      const decision = decideCancel(record, cancellationFence, now);
      if (!decision.changed) return { record, changed: false };
      await this.writeDeployment(client, decision.next, record.revision);
      if (decision.wake) await wake([decision.wake], await txid());
      return { record: decision.next, changed: true };
    });
  }
  public finishCleanup(
    key: { workspaceId: string; appId: string; deploymentId: string },
    epoch: number,
    done: boolean,
    now: Date,
    wake: DeploymentWakeHook,
  ): Promise<void> {
    return this.deploymentTransaction(async (client, txid) => {
      const record = await this.lockDeployment(client, key.workspaceId, key.deploymentId);
      if (!record || record.appId !== key.appId) return;
      const decision = decideCleanup(record, epoch, done, now);
      if (!decision) return;
      await this.writeDeployment(client, decision.next, record.revision);
      if (decision.wake) await wake([decision.wake], await txid());
    });
  }
  public async appStatus(workspaceId: string, appId: string): Promise<AppControl | null> {
    return appControl(
      (
        await this.pool.query<{ document: CatalogApp }>(
          "SELECT document FROM embody_platform_apps WHERE workspace_id=$1 AND id=$2",
          [workspaceId, appId],
        )
      ).rows[0]?.document,
    );
  }
  public async release(
    workspaceId: string,
    appId: string,
    releaseId: string,
  ): Promise<ReleaseRecord | null> {
    return (
      (
        await this.pool.query<{ document: ReleaseRecord }>(
          "SELECT document FROM embody_platform_releases WHERE workspace_id=$1 AND app_id=$2 AND release_id=$3",
          [workspaceId, appId, releaseId],
        )
      ).rows[0]?.document ?? null
    );
  }
  public async overdueDeployments(
    now: Date,
    limit: number,
    workspaceId?: string,
  ): Promise<readonly DeploymentRecord[]> {
    const cutoff = new Date(now.getTime() - DEPLOYMENT_LIMITS.recoveryGraceMs);
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = (
      await this.pool.query<{ document: DeploymentRecord }>(
        `SELECT document FROM embody_platform_deployments
        WHERE (state NOT IN ('active','failed','cancelled') OR cleanup) AND due_at<$1
          AND (lease_until IS NULL OR lease_until<$1) AND ($3::text IS NULL OR workspace_id=$3)
        ORDER BY due_at LIMIT $2`,
        [cutoff, bounded, workspaceId ?? null],
      )
    ).rows;
    return rows.map((row) => row.document).filter((record) => isOverdue(record, now));
  }
  public async transactionStatus(
    txid: string,
  ): Promise<"in-progress" | "committed" | "aborted" | "unknown"> {
    if (!/^\d{1,20}$/.test(txid)) return "unknown";
    const status = (
      await this.pool.query<{ status: string | null }>("SELECT txid_status($1::bigint) AS status", [
        txid,
      ])
    ).rows[0]?.status;
    return status === "in progress"
      ? "in-progress"
      : status === "committed" || status === "aborted"
        ? status
        : "unknown";
  }
  public close(): Promise<void> {
    return (this.closing ??= this.pool.end());
  }
}
