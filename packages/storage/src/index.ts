/** Framework-neutral storage ports shared by database adapters. */

export { PostgresStorage } from "./postgres.js";
export type { PoolConfig } from "pg";
export { SqliteStorage } from "./sqlite.js";
export type StorageDialect = "sqlite" | "postgres";
export type OutboxStatus = "pending" | "processing" | "completed" | "failed" | "dead_letter";
export type InboxStatus = "reserved" | "completed" | "failed";

export interface EntityRecord<TData = Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly orgId: string;
  readonly entityType: string;
  readonly data: TData;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EntityCreate<TData> {
  readonly id?: string;
  readonly data: TData;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface EntityListOptions {
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly sort?: { readonly field: string; readonly direction: "asc" | "desc" };
  readonly limit?: number;
  readonly offset?: number;
}

export interface EntityUpdate<TData> {
  readonly data: TData;
  /** The adapter must reject the update if this value is stale. */
  readonly expectedUpdatedAt?: string;
}

export interface EntityRepository {
  create<TData>(
    orgId: string,
    entityType: string,
    input: EntityCreate<TData>,
  ): Promise<EntityRecord<TData>>;
  get<TData>(orgId: string, entityType: string, id: string): Promise<EntityRecord<TData> | null>;
  list<TData>(
    orgId: string,
    entityType: string,
    options?: EntityListOptions,
  ): Promise<readonly EntityRecord<TData>[]>;
  update<TData>(
    orgId: string,
    entityType: string,
    id: string,
    update: EntityUpdate<TData>,
  ): Promise<EntityRecord<TData> | null>;
  delete<TData = Readonly<Record<string, unknown>>>(
    orgId: string,
    entityType: string,
    id: string,
  ): Promise<EntityRecord<TData> | null>;
}

export interface OutboxEvent {
  readonly id: string;
  readonly orgId: string;
  readonly eventName: string;
  readonly payload: unknown;
  readonly occurredAt: string;
  readonly scheduledAt: string;
  readonly attempts: number;
  readonly status: OutboxStatus;
  readonly claimedAt?: string;
  readonly claimedBy?: string;
  readonly lastError?: string;
}

export interface EnqueueOutboxInput {
  readonly id?: string;
  readonly eventName: string;
  readonly payload: unknown;
  readonly occurredAt?: string;
  readonly scheduledAt?: string;
}

export interface ClaimOutboxOptions {
  readonly limit: number;
  readonly workerId: string;
  readonly now?: string;
  /** A processing claim older than this is recoverable after a worker crash. Defaults to 30 seconds. */
  readonly leaseMs?: number;
}

export interface OutboxRepository {
  enqueue(orgId: string, input: EnqueueOutboxInput): Promise<OutboxEvent>;
  claimBatch(options: ClaimOutboxOptions): Promise<readonly OutboxEvent[]>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string, retryAt?: string): Promise<OutboxEvent | null>;
  deadLetter(id: string, error: string): Promise<OutboxEvent | null>;
  list(options?: {
    readonly status?: OutboxStatus;
    readonly limit?: number;
  }): Promise<readonly OutboxEvent[]>;
}

export interface InboxReservation {
  readonly state: "new" | "duplicate" | "in-progress" | "completed";
  readonly eventId: string;
  readonly handlerId: string;
}

export interface InboxRepository {
  reserve(eventId: string, handlerId: string): Promise<InboxReservation>;
  complete(eventId: string, handlerId: string): Promise<void>;
  fail(eventId: string, handlerId: string, error: string): Promise<void>;
}

export interface TransactionRepositories {
  readonly entities: EntityRepository;
  readonly outbox: OutboxRepository;
  readonly inbox: InboxRepository;
}

export interface StorageTransaction extends TransactionRepositories {
  readonly orgId: string;
}

export interface StorageConnection {
  /** Applies all missing numbered infrastructure migrations. Safe to call repeatedly. */
  ensureSchema(): Promise<void>;
  transaction<T>(orgId: string, callback: (tx: StorageTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface GatewayRegistryRepository {
  register(input: GatewayAppRegistration): Promise<void>;
  heartbeat(appId: string, at?: string): Promise<void>;
  remove(appId: string): Promise<void>;
  get(appId: string): Promise<GatewayAppRegistration | null>;
  list(): Promise<readonly GatewayAppRegistration[]>;
}

export interface GatewayAppRegistration {
  readonly appId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly manifest: unknown;
  readonly registeredAt: string;
  readonly lastHeartbeatAt: string;
  readonly status: "healthy" | "unhealthy";
}

export interface GatewayAuditRepository {
  append(entry: GatewayAuditEntry): Promise<void>;
  list(options?: {
    readonly appId?: string;
    readonly limit?: number;
  }): Promise<readonly GatewayAuditEntry[]>;
}

export interface GatewayAuditEntry {
  readonly id: string;
  readonly appId?: string;
  readonly action: string;
  readonly orgId?: string;
  readonly actorId?: string;
  readonly outcome: "success" | "failure";
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GatewayDeliveryRepository {
  create(input: GatewayDeliveryInput): Promise<void>;
  claimBatch(options: ClaimOutboxOptions): Promise<readonly GatewayDeliveryInput[]>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string, retryAt?: string): Promise<void>;
}

export interface GatewayDeliveryInput {
  readonly id: string;
  readonly eventId: string;
  readonly appId: string;
  readonly orgId: string;
  readonly eventName: string;
  readonly payload: unknown;
  readonly scheduledAt: string;
}

export interface SchemaMigration {
  readonly version: number;
  readonly description: string;
  readonly sqlite: string;
  readonly postgres: string;
}

/**
 * Infrastructure migrations are intentionally separate from dynamic entity evolution.
 * Adapters execute these in ascending order and record applied versions transactionally.
 */
export const STORAGE_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    description: "initial storage and delivery tables",
    sqlite: `
      CREATE TABLE embody_entities (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, entity_type TEXT NOT NULL,
        data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX idx_entities_tenant_type ON embody_entities (org_id, entity_type);
      CREATE TABLE embody_outbox (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, event_name TEXT NOT NULL,
        payload TEXT NOT NULL, occurred_at TEXT NOT NULL, scheduled_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', claimed_at TEXT, claimed_by TEXT, last_error TEXT);
      CREATE INDEX idx_outbox_claim ON embody_outbox (status, scheduled_at);
      CREATE TABLE embody_inbox (event_id TEXT NOT NULL, handler_id TEXT NOT NULL, status TEXT NOT NULL,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (event_id, handler_id));
      CREATE TABLE embody_gateway_registry (app_id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
        manifest TEXT NOT NULL, registered_at TEXT NOT NULL, last_heartbeat_at TEXT NOT NULL,
        status TEXT NOT NULL);
      CREATE TABLE embody_gateway_audit (id TEXT PRIMARY KEY, app_id TEXT, action TEXT NOT NULL,
        org_id TEXT, actor_id TEXT, outcome TEXT NOT NULL, occurred_at TEXT NOT NULL, metadata TEXT);
      CREATE TABLE embody_gateway_deliveries (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, app_id TEXT NOT NULL,
        org_id TEXT NOT NULL, event_name TEXT NOT NULL, payload TEXT NOT NULL, scheduled_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', claimed_at TEXT,
        claimed_by TEXT, last_error TEXT, UNIQUE (event_id, app_id));
      CREATE INDEX idx_gateway_deliveries_claim ON embody_gateway_deliveries (status, scheduled_at);
      CREATE TABLE IF NOT EXISTS embody_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    `.trim(),
    postgres: `
      CREATE TABLE embody_entities (id UUID PRIMARY KEY, org_id TEXT NOT NULL, entity_type TEXT NOT NULL,
        data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
      CREATE INDEX idx_entities_tenant_type ON embody_entities (org_id, entity_type);
      CREATE INDEX idx_entities_data_gin ON embody_entities USING gin (data);
      ALTER TABLE embody_entities ENABLE ROW LEVEL SECURITY;
      CREATE POLICY embody_entities_tenant_isolation ON embody_entities
        USING (org_id = current_setting('app.current_org', true))
        WITH CHECK (org_id = current_setting('app.current_org', true));
      CREATE TABLE embody_outbox (id UUID PRIMARY KEY, org_id TEXT NOT NULL, event_name TEXT NOT NULL,
        payload JSONB NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, scheduled_at TIMESTAMPTZ NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', claimed_at TIMESTAMPTZ, claimed_by TEXT, last_error TEXT);
      CREATE INDEX idx_outbox_claim ON embody_outbox (status, scheduled_at);
      ALTER TABLE embody_outbox ENABLE ROW LEVEL SECURITY;
      CREATE POLICY embody_outbox_tenant_isolation ON embody_outbox
        USING (org_id = current_setting('app.current_org', true))
        WITH CHECK (org_id = current_setting('app.current_org', true));
      CREATE TABLE embody_inbox (event_id UUID NOT NULL, handler_id TEXT NOT NULL, status TEXT NOT NULL,
        last_error TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (event_id, handler_id));
      CREATE TABLE embody_gateway_registry (app_id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
        manifest JSONB NOT NULL, registered_at TIMESTAMPTZ NOT NULL, last_heartbeat_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL);
      CREATE TABLE embody_gateway_audit (id UUID PRIMARY KEY, app_id TEXT, action TEXT NOT NULL,
        org_id TEXT, actor_id TEXT, outcome TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL, metadata JSONB);
      CREATE TABLE embody_gateway_deliveries (id UUID PRIMARY KEY, event_id UUID NOT NULL, app_id TEXT NOT NULL,
        org_id TEXT NOT NULL, event_name TEXT NOT NULL, payload JSONB NOT NULL, scheduled_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', claimed_at TIMESTAMPTZ,
        claimed_by TEXT, last_error TEXT, UNIQUE (event_id, app_id));
      CREATE INDEX idx_gateway_deliveries_claim ON embody_gateway_deliveries (status, scheduled_at);
      CREATE TABLE IF NOT EXISTS embody_schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL);
    `.trim(),
  },
];

export function normalizeTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid timestamp");
  return date.toISOString();
}
