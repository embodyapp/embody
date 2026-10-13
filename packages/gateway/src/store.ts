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
  type ScopedGrant,
} from "@embody/cloud-contracts";
import { validateRegistration, type Registration, type GatewayRegistryOptions } from "./index.js";
import { DispatchRateLimitedError, type AuditRecord, type DispatchAdmission } from "./dispatch.js";

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
}
export type CatalogWrite = Omit<CatalogApp, "revision" | "generation">;
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
/* eslint-disable @typescript-eslint/require-await -- Atomic memory operations contain no await; async converts validation/CAS errors to rejections. */
export class MemoryGatewayStore implements GatewayStore {
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
  public async close(): Promise<void> {}
}
/* eslint-enable @typescript-eslint/require-await */
/** Platform database only. Migrations must be invoked separately using the maintenance role. */
export class PostgresGatewayStore implements GatewayStore {
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
        CREATE INDEX IF NOT EXISTS embody_platform_audit_lease ON embody_platform_audit(workspace_id,lease_until) WHERE NOT completed;`);
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
  public close(): Promise<void> {
    return (this.closing ??= this.pool.end());
  }
}
