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
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly producerPluginId?: string;
  readonly schemaVersion?: string;
}

export interface EnqueueOutboxInput {
  readonly id?: string;
  readonly eventName: string;
  readonly payload: unknown;
  readonly occurredAt?: string;
  readonly scheduledAt?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly producerPluginId?: string;
  readonly schemaVersion?: string;
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

export interface EventDelivery {
  readonly id: string;
  readonly eventId: string;
  readonly orgId: string;
  readonly destinationAppId: string;
  readonly destinationEndpoint: string;
  readonly envelope: unknown;
  readonly scheduledAt: string;
  readonly attempts: number;
  readonly status: OutboxStatus;
  readonly claimedAt?: string;
  readonly claimedBy?: string;
  readonly lastError?: string;
}

export interface CreateEventDeliveryInput {
  readonly id?: string;
  readonly eventId: string;
  readonly orgId: string;
  readonly destinationAppId: string;
  readonly destinationEndpoint: string;
  readonly envelope: unknown;
  readonly scheduledAt?: string;
}

export interface EventDeliveryRepository {
  /** Idempotently creates a snapshotted destination for an event. */
  create(input: CreateEventDeliveryInput): Promise<EventDelivery>;
  claimBatch(options: ClaimOutboxOptions): Promise<readonly EventDelivery[]>;
  complete(id: string): Promise<void>;
  fail(id: string, error: string, retryAt?: string): Promise<EventDelivery | null>;
  deadLetter(id: string, error: string): Promise<EventDelivery | null>;
  list(options?: {
    readonly status?: OutboxStatus;
    readonly limit?: number;
  }): Promise<readonly EventDelivery[]>;
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

export type WorkflowStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "compensating"
  | "compensated";
export type WorkflowStepStatus =
  | "blocked"
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "compensating"
  | "compensated"
  | "compensation_failed";
export interface StoredPrincipal {
  readonly orgId: string;
  readonly actorId: string;
  readonly actorType: "agent" | "human" | "system";
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface WorkflowInstance {
  readonly id: string;
  readonly orgId: string;
  readonly definition: string;
  readonly definitionVersion: string;
  readonly idempotencyKey: string;
  readonly inputHash: string;
  readonly input: unknown;
  readonly principal: StoredPrincipal;
  readonly status: WorkflowStatus;
  readonly output?: unknown;
  readonly error?: string;
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly optimisticVersion: number;
}
export interface WorkflowStep {
  readonly id: string;
  readonly instanceId: string;
  readonly orgId: string;
  readonly name: string;
  readonly status: WorkflowStepStatus;
  readonly dependencies: readonly string[];
  readonly attempt: number;
  readonly scheduledAt: string;
  readonly compensatable: boolean;
  readonly output?: unknown;
  readonly error?: string;
  readonly claimedAt?: string;
  readonly claimedBy?: string;
}
export interface WorkflowSnapshot extends WorkflowInstance {
  readonly steps: readonly WorkflowStep[];
}
/** Identity of a claimed step; the fencing token for later processing. */
export interface WorkflowStepClaim {
  readonly id: string;
  readonly orgId: string;
  readonly attempt: number;
  readonly workerId: string;
}
/** A workflow definition version that still has running or retryable instances. */
export interface ActiveWorkflowVersion {
  readonly definition: string;
  readonly definitionVersion: string;
  readonly instances: number;
}
export interface WorkflowRepository {
  start(input: {
    readonly id: string;
    readonly orgId: string;
    readonly definition: string;
    readonly definitionVersion: string;
    readonly idempotencyKey: string;
    readonly inputHash: string;
    readonly input: unknown;
    readonly principal: StoredPrincipal;
    readonly now: string;
    readonly steps: readonly {
      readonly id: string;
      readonly name: string;
      readonly dependencies: readonly string[];
      readonly scheduledAt: string;
      readonly compensatable: boolean;
    }[];
  }): Promise<{ readonly instance: WorkflowInstance; readonly created: boolean }>;
  get(id: string): Promise<WorkflowSnapshot | null>;
  cancel(id: string, now: string): Promise<WorkflowSnapshot | null>;
  retry(id: string, now: string): Promise<WorkflowSnapshot | null>;
  /** Claims due steps visible to the current tenant only. */
  claimBatch(options: ClaimOutboxOptions): Promise<readonly WorkflowStep[]>;
  /**
   * Claims due steps across tenants for the trusted workflow worker. Returns claim identity only;
   * process each claim in its own tenant transaction via {@link WorkflowRepository.lockClaim}.
   */
  claimDue(options: ClaimOutboxOptions): Promise<readonly WorkflowStepClaim[]>;
  /** Locks a claimed step for processing; null when the claim was lost to another worker. */
  lockClaim(claim: WorkflowStepClaim): Promise<WorkflowStep | null>;
  /** Releases a claimed step, without running it, because its instance was cancelled. */
  releaseCancelled(input: { readonly id: string; readonly now: string }): Promise<void>;
  /** Definition versions with running or retryable instances, across tenants. */
  activeVersions(): Promise<readonly ActiveWorkflowVersion[]>;
  completeStep(input: {
    readonly id: string;
    readonly output: unknown;
    readonly now: string;
    readonly resultStep: boolean;
  }): Promise<void>;
  failStep(input: {
    readonly id: string;
    readonly error: string;
    readonly retryAt?: string;
    readonly terminal: boolean;
    readonly now: string;
  }): Promise<void>;
}

export interface TransactionRepositories {
  readonly entities: EntityRepository;
  readonly outbox: OutboxRepository;
  readonly inbox: InboxRepository;
  readonly eventDeliveries: EventDeliveryRepository;
  readonly workflows: WorkflowRepository;
}

export interface StorageTransaction extends TransactionRepositories {
  readonly orgId: string;
  /**
   * Runs `callback` under a savepoint: its writes roll back if it throws, while the transaction
   * continues. Workflow workers use it so a failed or timed-out step leaves no writes behind.
   */
  savepoint?<T>(callback: () => Promise<T>): Promise<T>;
}

export interface StorageConnection {
  readonly dialect: StorageDialect;
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
  {
    version: 2,
    description: "durable direct event destinations",
    sqlite: `
      CREATE TABLE embody_event_deliveries (id TEXT PRIMARY KEY, event_id TEXT NOT NULL,
        org_id TEXT NOT NULL, destination_app_id TEXT NOT NULL, destination_endpoint TEXT NOT NULL,
        envelope TEXT NOT NULL, scheduled_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', claimed_at TEXT, claimed_by TEXT, last_error TEXT,
        created_at TEXT NOT NULL, completed_at TEXT, UNIQUE (event_id, destination_app_id));
      CREATE INDEX idx_event_deliveries_claim ON embody_event_deliveries (status, scheduled_at);
    `.trim(),
    postgres: `
      CREATE TABLE embody_event_deliveries (id UUID PRIMARY KEY, event_id UUID NOT NULL,
        org_id TEXT NOT NULL, destination_app_id TEXT NOT NULL, destination_endpoint TEXT NOT NULL,
        envelope JSONB NOT NULL, scheduled_at TIMESTAMPTZ NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', claimed_at TIMESTAMPTZ, claimed_by TEXT, last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ,
        UNIQUE (event_id, destination_app_id));
      CREATE INDEX idx_event_deliveries_claim ON embody_event_deliveries (status, scheduled_at);
      ALTER TABLE embody_event_deliveries ENABLE ROW LEVEL SECURITY;
      CREATE POLICY embody_event_deliveries_tenant_isolation ON embody_event_deliveries
        USING (org_id = current_setting('app.current_org', true))
        WITH CHECK (org_id = current_setting('app.current_org', true));
    `.trim(),
  },
  {
    version: 3,
    description: "event envelope metadata",
    sqlite: `
      ALTER TABLE embody_outbox ADD COLUMN correlation_id TEXT;
      ALTER TABLE embody_outbox ADD COLUMN causation_id TEXT;
      ALTER TABLE embody_outbox ADD COLUMN producer_plugin_id TEXT;
      ALTER TABLE embody_outbox ADD COLUMN schema_version TEXT;
    `.trim(),
    postgres: `
      ALTER TABLE embody_outbox ADD COLUMN correlation_id TEXT;
      ALTER TABLE embody_outbox ADD COLUMN causation_id TEXT;
      ALTER TABLE embody_outbox ADD COLUMN producer_plugin_id TEXT;
      ALTER TABLE embody_outbox ADD COLUMN schema_version TEXT;
    `.trim(),
  },
  {
    version: 4,
    description: "durable workflow instances and steps",
    sqlite: `
      CREATE TABLE embody_workflow_instances (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, definition TEXT NOT NULL,
        definition_version TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, input TEXT NOT NULL,
        principal TEXT NOT NULL, status TEXT NOT NULL, output TEXT, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, optimistic_version INTEGER NOT NULL DEFAULT 0,
        UNIQUE(org_id, definition, idempotency_key));
      CREATE INDEX idx_workflow_instances_tenant ON embody_workflow_instances(org_id, id);
      CREATE TABLE embody_workflow_steps (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES embody_workflow_instances(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL, dependencies TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
        scheduled_at TEXT NOT NULL, compensatable INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT, claimed_at TEXT, claimed_by TEXT, completed_at TEXT,
        UNIQUE(instance_id, name));
      CREATE INDEX idx_workflow_steps_claim ON embody_workflow_steps(status, scheduled_at);
    `.trim(),
    postgres: `
      CREATE TABLE embody_workflow_instances (id UUID PRIMARY KEY, org_id TEXT NOT NULL, definition TEXT NOT NULL,
        definition_version TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, input JSONB NOT NULL,
        principal JSONB NOT NULL, status TEXT NOT NULL, output JSONB, error TEXT, cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, optimistic_version INTEGER NOT NULL DEFAULT 0,
        UNIQUE(org_id, definition, idempotency_key));
      CREATE INDEX idx_workflow_instances_tenant ON embody_workflow_instances(org_id, id);
      ALTER TABLE embody_workflow_instances ENABLE ROW LEVEL SECURITY;
      CREATE POLICY embody_workflow_instances_tenant_isolation ON embody_workflow_instances USING (org_id = current_setting('app.current_org', true)) WITH CHECK (org_id = current_setting('app.current_org', true));
      CREATE TABLE embody_workflow_steps (id UUID PRIMARY KEY, instance_id UUID NOT NULL REFERENCES embody_workflow_instances(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL, dependencies JSONB NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
        scheduled_at TIMESTAMPTZ NOT NULL, compensatable BOOLEAN NOT NULL DEFAULT FALSE, output JSONB, error TEXT, claimed_at TIMESTAMPTZ, claimed_by TEXT, completed_at TIMESTAMPTZ,
        UNIQUE(instance_id, name));
      CREATE INDEX idx_workflow_steps_claim ON embody_workflow_steps(status, scheduled_at);
      ALTER TABLE embody_workflow_steps ENABLE ROW LEVEL SECURITY;
      CREATE POLICY embody_workflow_steps_tenant_isolation ON embody_workflow_steps USING (org_id = current_setting('app.current_org', true)) WITH CHECK (org_id = current_setting('app.current_org', true));
    `.trim(),
  },
  {
    version: 5,
    description: "Runtime-role workflow claims and active version listing without RLS bypass",
    sqlite: "SELECT 1;",
    postgres: `
      CREATE FUNCTION embody_claim_workflow_steps(p_now TIMESTAMPTZ, p_expired TIMESTAMPTZ, p_limit INTEGER, p_worker TEXT)
      RETURNS TABLE (step_id UUID, step_org_id TEXT, step_attempt INTEGER)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
      DECLARE orphan RECORD;
      BEGIN
        IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'Invalid claim limit'; END IF;
        IF p_worker IS NULL OR length(p_worker) = 0 OR length(p_worker) > 200 THEN RAISE EXCEPTION 'Invalid worker'; END IF;
        -- Worker clocks may differ slightly from the database, never by more than ten minutes.
        IF p_now IS NULL OR p_expired IS NULL OR p_expired > p_now
          OR p_now > now() + interval '10 minutes' OR p_now < now() - interval '10 minutes'
        THEN RAISE EXCEPTION 'Invalid claim time'; END IF;
        -- A step whose worker died after its instance was cancelled must still settle. Instance
        -- first, then step, as every other write path; SKIP LOCKED so a step a live worker is
        -- still processing never blocks this claim.
        FOR orphan IN
          SELECT s.id AS step_id, s.instance_id FROM public.embody_workflow_steps s
          JOIN public.embody_workflow_instances i ON i.id = s.instance_id
          WHERE i.cancel_requested AND s.status = 'running' AND s.claimed_at <= p_expired
          ORDER BY s.instance_id, s.id LIMIT 100
        LOOP
          PERFORM 1 FROM public.embody_workflow_instances i WHERE i.id = orphan.instance_id FOR UPDATE SKIP LOCKED;
          CONTINUE WHEN NOT FOUND;
          UPDATE public.embody_workflow_steps s
            SET status = CASE WHEN s.compensatable THEN 'compensating' ELSE 'cancelled' END,
                scheduled_at = p_now, claimed_at = NULL, claimed_by = NULL
            WHERE s.id = (SELECT x.id FROM public.embody_workflow_steps x
              WHERE x.id = orphan.step_id AND x.status = 'running' AND x.claimed_at <= p_expired
              FOR UPDATE SKIP LOCKED);
          CONTINUE WHEN NOT FOUND;
          UPDATE public.embody_workflow_instances i SET status = CASE
              WHEN EXISTS (SELECT 1 FROM public.embody_workflow_steps x WHERE x.instance_id = i.id AND x.status = 'compensating') THEN 'compensating'
              WHEN EXISTS (SELECT 1 FROM public.embody_workflow_steps x WHERE x.instance_id = i.id AND x.status = 'running') THEN i.status
              WHEN EXISTS (SELECT 1 FROM public.embody_workflow_steps x WHERE x.instance_id = i.id AND x.status = 'compensated') THEN 'compensated'
              ELSE 'cancelled' END,
            updated_at = p_now, optimistic_version = i.optimistic_version + 1
          WHERE i.id = orphan.instance_id AND i.status <> 'failed';
        END LOOP;
        -- Claims lock step rows only, with SKIP LOCKED, so a claim never waits on another writer.
        RETURN QUERY
        WITH candidates AS (
          SELECT s.id FROM public.embody_workflow_steps s
          JOIN public.embody_workflow_instances i ON i.id = s.instance_id
          WHERE (i.cancel_requested = FALSE
              AND ((s.status IN ('pending','waiting','blocked') AND s.scheduled_at <= p_now) OR (s.status = 'running' AND s.claimed_at <= p_expired))
              AND NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text(s.dependencies) AS d(value)
                LEFT JOIN public.embody_workflow_steps p ON p.instance_id = s.instance_id AND p.name = d.value
                WHERE p.status IS NULL OR p.status != 'completed'))
            OR (s.status = 'compensating' AND s.scheduled_at <= p_now
              AND (s.claimed_at IS NULL OR s.claimed_at <= p_expired)
              AND NOT EXISTS (SELECT 1 FROM public.embody_workflow_steps later
                WHERE later.instance_id = s.instance_id AND later.position > s.position
                  AND later.status IN ('compensating','running')))
          ORDER BY s.scheduled_at, s.id LIMIT p_limit FOR UPDATE OF s SKIP LOCKED),
        claimed AS (
          UPDATE public.embody_workflow_steps s
          SET status = CASE WHEN s.status = 'compensating' THEN 'compensating' ELSE 'running' END,
              claimed_at = p_now, claimed_by = p_worker, attempt = s.attempt + 1
          FROM candidates WHERE s.id = candidates.id
          RETURNING s.id, s.org_id, s.attempt)
        SELECT claimed.id, claimed.org_id, claimed.attempt FROM claimed;
      END $$;
      REVOKE ALL ON FUNCTION embody_claim_workflow_steps(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT) FROM PUBLIC;
      CREATE FUNCTION embody_active_workflow_versions()
      RETURNS TABLE (workflow_definition TEXT, workflow_version TEXT, running_instances BIGINT)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
        SELECT definition, definition_version, count(*) FROM public.embody_workflow_instances
        WHERE status NOT IN ('completed','cancelled','compensated')
        GROUP BY definition, definition_version ORDER BY definition, definition_version
      $$;
      REVOKE ALL ON FUNCTION embody_active_workflow_versions() FROM PUBLIC;
    `.trim(),
  },
];

/**
 * Functions the runtime role must be granted EXECUTE on, in addition to table DML. They are
 * SECURITY DEFINER, so they run as the migration owner and expose only the narrow operation.
 */
export const STORAGE_RUNTIME_FUNCTIONS: readonly string[] = [
  "embody_claim_workflow_steps(timestamptz, timestamptz, integer, text)",
  "embody_active_workflow_versions()",
];

export function normalizeTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid timestamp");
  return date.toISOString();
}
