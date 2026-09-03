import { randomUUID } from "node:crypto";
import { Pool, type PoolConfig, type PoolClient } from "pg";

import type {
  ClaimOutboxOptions,
  EnqueueOutboxInput,
  EntityCreate,
  EntityListOptions,
  EntityRecord,
  EntityUpdate,
  EventDelivery,
  CreateEventDeliveryInput,
  InboxReservation,
  OutboxEvent,
  OutboxStatus,
  StorageConnection,
  StorageTransaction,
} from "./index.js";
import { normalizeTimestamp, STORAGE_MIGRATIONS } from "./index.js";

type Row = Record<string, unknown>;
type Client = Pool | PoolClient;
function asRow(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid PostgreSQL row");
  }
  return value as Row;
}
const timestamp = (value?: string) => normalizeTimestamp(value ?? new Date());

function entity<T>(value: unknown): EntityRecord<T> {
  const row = asRow(value);
  return {
    id: String(row["id"]),
    orgId: String(row["org_id"]),
    entityType: String(row["entity_type"]),
    data: row["data"] as T,
    createdAt: normalizeTimestamp(String(row["created_at"])),
    updatedAt: normalizeTimestamp(String(row["updated_at"])),
  };
}
function outbox(value: unknown): OutboxEvent {
  const row = asRow(value);
  const claimedValue = row["claimed_at"];
  const claimedAt =
    typeof claimedValue === "string" || claimedValue instanceof Date
      ? normalizeTimestamp(claimedValue)
      : undefined;
  const claimedBy = typeof row["claimed_by"] === "string" ? row["claimed_by"] : undefined;
  const lastError = typeof row["last_error"] === "string" ? row["last_error"] : undefined;
  const optional = (field: string): string | undefined =>
    typeof row[field] === "string" ? String(row[field]) : undefined;
  const correlationId = optional("correlation_id");
  const causationId = optional("causation_id");
  const producerPluginId = optional("producer_plugin_id");
  const schemaVersion = optional("schema_version");
  return {
    id: String(row["id"]),
    orgId: String(row["org_id"]),
    eventName: String(row["event_name"]),
    payload: row["payload"],
    occurredAt: normalizeTimestamp(String(row["occurred_at"])),
    scheduledAt: normalizeTimestamp(String(row["scheduled_at"])),
    attempts: Number(row["attempts"]),
    status: String(row["status"]) as OutboxStatus,
    ...(claimedAt === undefined ? {} : { claimedAt }),
    ...(claimedBy === undefined ? {} : { claimedBy }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(causationId === undefined ? {} : { causationId }),
    ...(producerPluginId === undefined ? {} : { producerPluginId }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
  };
}
function delivery(value: unknown): EventDelivery {
  const row = asRow(value);
  const optionalTimestamp = (field: string): string | undefined => {
    const value = row[field];
    return typeof value === "string" || value instanceof Date
      ? normalizeTimestamp(value)
      : undefined;
  };
  const claimedAt = optionalTimestamp("claimed_at");
  const claimedBy = typeof row["claimed_by"] === "string" ? row["claimed_by"] : undefined;
  const lastError = typeof row["last_error"] === "string" ? row["last_error"] : undefined;
  return {
    id: String(row["id"]),
    eventId: String(row["event_id"]),
    orgId: String(row["org_id"]),
    destinationAppId: String(row["destination_app_id"]),
    destinationEndpoint: String(row["destination_endpoint"]),
    envelope: row["envelope"],
    scheduledAt: normalizeTimestamp(String(row["scheduled_at"])),
    attempts: Number(row["attempts"]),
    status: String(row["status"]) as OutboxStatus,
    ...(claimedAt === undefined ? {} : { claimedAt }),
    ...(claimedBy === undefined ? {} : { claimedBy }),
    ...(lastError === undefined ? {} : { lastError }),
  };
}
function field(fieldName: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName))
    throw new RangeError("Sort and filter fields must be simple entity field names");
  return fieldName;
}

class PostgresTransaction implements StorageTransaction {
  public readonly entities = {
    create: async <T>(orgId: string, entityType: string, input: EntityCreate<T>) => {
      const id = input.id ?? randomUUID();
      const createdAt = timestamp(input.createdAt);
      const updatedAt = timestamp(input.updatedAt ?? createdAt);
      const result = await this.client.query(
        "INSERT INTO embody_entities (id, org_id, entity_type, data, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING *",
        [id, orgId, entityType, JSON.stringify(input.data), createdAt, updatedAt],
      );
      return entity<T>(result.rows[0]);
    },
    get: async <T>(orgId: string, entityType: string, id: string) => {
      const result = await this.client.query(
        "SELECT * FROM embody_entities WHERE id = $1 AND org_id = $2 AND entity_type = $3",
        [id, orgId, entityType],
      );
      return result.rows[0] === undefined ? null : entity<T>(result.rows[0]);
    },
    list: async <T>(orgId: string, entityType: string, options: EntityListOptions = {}) => {
      const values: unknown[] = [orgId, entityType];
      const clauses = ["org_id = $1", "entity_type = $2"];
      for (const [name, value] of Object.entries(options.filter ?? {})) {
        values.push(JSON.stringify({ [field(name)]: value }));
        clauses.push(`data @> $${values.length}::jsonb`);
      }
      const limit = options.limit ?? 20;
      const offset = options.offset ?? 0;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0
      )
        throw new RangeError("Invalid pagination");
      const order =
        options.sort === undefined
          ? "id ASC"
          : `data ->> $${values.push(field(options.sort.field))} ${options.sort.direction === "desc" ? "DESC" : "ASC"} NULLS LAST, id ASC`;
      values.push(limit, offset);
      const result = await this.client.query(
        `SELECT * FROM embody_entities WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      return result.rows.map(entity<T>);
    },
    update: async <T>(orgId: string, entityType: string, id: string, update: EntityUpdate<T>) => {
      const values: unknown[] = [JSON.stringify(update.data), timestamp(), id, orgId, entityType];
      const expected =
        update.expectedUpdatedAt === undefined
          ? ""
          : ` AND updated_at = $${values.push(normalizeTimestamp(update.expectedUpdatedAt))}`;
      const result = await this.client.query(
        `UPDATE embody_entities SET data = $1::jsonb, updated_at = $2 WHERE id = $3 AND org_id = $4 AND entity_type = $5${expected} RETURNING *`,
        values,
      );
      return result.rows[0] === undefined ? null : entity<T>(result.rows[0]);
    },
    delete: async <T>(orgId: string, entityType: string, id: string) => {
      const result = await this.client.query(
        "DELETE FROM embody_entities WHERE id = $1 AND org_id = $2 AND entity_type = $3 RETURNING *",
        [id, orgId, entityType],
      );
      return result.rows[0] === undefined ? null : entity<T>(result.rows[0]);
    },
  };
  public readonly outbox = {
    enqueue: async (orgId: string, input: EnqueueOutboxInput) => {
      const value = {
        id: input.id ?? randomUUID(),
        orgId,
        eventName: input.eventName,
        payload: input.payload,
        occurredAt: timestamp(input.occurredAt),
        scheduledAt: timestamp(input.scheduledAt),
        attempts: 0,
        status: "pending" as const,
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
        ...(input.producerPluginId === undefined
          ? {}
          : { producerPluginId: input.producerPluginId }),
        ...(input.schemaVersion === undefined ? {} : { schemaVersion: input.schemaVersion }),
      };
      const result = await this.client.query(
        "INSERT INTO embody_outbox (id, org_id, event_name, payload, occurred_at, scheduled_at, attempts, status, correlation_id, causation_id, producer_plugin_id, schema_version) VALUES ($1, $2, $3, $4::jsonb, $5, $6, 0, 'pending', $7, $8, $9, $10) RETURNING *",
        [
          value.id,
          orgId,
          value.eventName,
          JSON.stringify(value.payload),
          value.occurredAt,
          value.scheduledAt,
          value.correlationId ?? null,
          value.causationId ?? null,
          value.producerPluginId ?? null,
          value.schemaVersion ?? null,
        ],
      );
      return outbox(result.rows[0]);
    },
    claimBatch: async (options: ClaimOutboxOptions) => this.claim(options),
    complete: async (id: string) => {
      await this.client.query(
        "UPDATE embody_outbox SET status = 'completed', claimed_at = NULL, claimed_by = NULL WHERE id = $1",
        [id],
      );
    },
    fail: async (id: string, error: string, retryAt?: string) =>
      this.fail(id, error, retryAt, false),
    deadLetter: async (id: string, error: string) => this.fail(id, error, undefined, true),
    list: async (options: { readonly status?: OutboxStatus; readonly limit?: number } = {}) => {
      const limit = options.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new RangeError("Invalid limit");
      const result =
        options.status === undefined
          ? await this.client.query(
              "SELECT * FROM embody_outbox ORDER BY scheduled_at, id LIMIT $1",
              [limit],
            )
          : await this.client.query(
              "SELECT * FROM embody_outbox WHERE status = $1 ORDER BY scheduled_at, id LIMIT $2",
              [options.status, limit],
            );
      return result.rows.map(outbox);
    },
  };
  public readonly eventDeliveries = {
    create: async (input: CreateEventDeliveryInput): Promise<EventDelivery> => {
      const result = await this.client.query(
        `INSERT INTO embody_event_deliveries (id, event_id, org_id, destination_app_id, destination_endpoint, envelope, scheduled_at, attempts, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 0, 'pending', $8)
         ON CONFLICT (event_id, destination_app_id) DO UPDATE SET event_id = EXCLUDED.event_id RETURNING *`,
        [
          input.id ?? randomUUID(),
          input.eventId,
          input.orgId,
          input.destinationAppId,
          input.destinationEndpoint,
          JSON.stringify(input.envelope),
          timestamp(input.scheduledAt),
          timestamp(),
        ],
      );
      return delivery(result.rows[0]);
    },
    claimBatch: async (options: ClaimOutboxOptions): Promise<readonly EventDelivery[]> => {
      this.assertClaimOptions(options);
      const now = timestamp(options.now);
      const expired = new Date(new Date(now).getTime() - (options.leaseMs ?? 30_000)).toISOString();
      const result = await this.client.query(
        `WITH candidates AS (SELECT id FROM embody_event_deliveries WHERE (status IN ('pending', 'failed') AND scheduled_at <= $1) OR (status = 'processing' AND claimed_at <= $2) ORDER BY scheduled_at, id FOR UPDATE SKIP LOCKED LIMIT $3)
         UPDATE embody_event_deliveries AS d SET status = 'processing', claimed_at = $1, claimed_by = $4, attempts = d.attempts + 1 FROM candidates WHERE d.id = candidates.id RETURNING d.*`,
        [now, expired, options.limit, options.workerId],
      );
      return result.rows.map(delivery);
    },
    complete: async (id: string): Promise<void> => {
      await this.client.query(
        "UPDATE embody_event_deliveries SET status = 'completed', completed_at = $1, claimed_at = NULL, claimed_by = NULL WHERE id = $2",
        [timestamp(), id],
      );
    },
    fail: async (id: string, error: string, retryAt?: string) =>
      this.failDelivery(id, error, retryAt, false),
    deadLetter: async (id: string, error: string) => this.failDelivery(id, error, undefined, true),
    list: async (options: { readonly status?: OutboxStatus; readonly limit?: number } = {}) => {
      const limit = options.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new RangeError("Invalid limit");
      const result =
        options.status === undefined
          ? await this.client.query(
              "SELECT * FROM embody_event_deliveries ORDER BY scheduled_at, id LIMIT $1",
              [limit],
            )
          : await this.client.query(
              "SELECT * FROM embody_event_deliveries WHERE status = $1 ORDER BY scheduled_at, id LIMIT $2",
              [options.status, limit],
            );
      return result.rows.map(delivery);
    },
  };
  public readonly inbox = {
    reserve: async (eventId: string, handlerId: string): Promise<InboxReservation> => {
      const now = timestamp();
      const insert = await this.client.query(
        "INSERT INTO embody_inbox (event_id, handler_id, status, created_at, updated_at) VALUES ($1, $2, 'reserved', $3, $3) ON CONFLICT (event_id, handler_id) DO NOTHING RETURNING event_id",
        [eventId, handlerId, now],
      );
      if (insert.rowCount === 1) return { state: "new", eventId, handlerId };
      const row = asRow(
        (
          await this.client.query(
            "SELECT status FROM embody_inbox WHERE event_id = $1 AND handler_id = $2",
            [eventId, handlerId],
          )
        ).rows[0],
      );
      return {
        state:
          row["status"] === "completed"
            ? "completed"
            : row["status"] === "reserved"
              ? "in-progress"
              : "duplicate",
        eventId,
        handlerId,
      };
    },
    complete: async (eventId: string, handlerId: string) => {
      await this.client.query(
        "UPDATE embody_inbox SET status = 'completed', last_error = NULL, updated_at = $1 WHERE event_id = $2 AND handler_id = $3",
        [timestamp(), eventId, handlerId],
      );
    },
    fail: async (eventId: string, handlerId: string, error: string) => {
      await this.client.query(
        "UPDATE embody_inbox SET status = 'failed', last_error = $1, updated_at = $2 WHERE event_id = $3 AND handler_id = $4",
        [error, timestamp(), eventId, handlerId],
      );
    },
  };
  public constructor(
    public readonly orgId: string,
    private readonly client: Client,
  ) {}
  private assertClaimOptions(options: ClaimOutboxOptions): void {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
      throw new RangeError("Invalid claim limit");
  }
  private async claim(options: ClaimOutboxOptions): Promise<readonly OutboxEvent[]> {
    this.assertClaimOptions(options);
    const now = timestamp(options.now);
    const expired = new Date(new Date(now).getTime() - (options.leaseMs ?? 30_000)).toISOString();
    const result = await this.client.query(
      `WITH candidates AS (SELECT id FROM embody_outbox WHERE (status IN ('pending', 'failed') AND scheduled_at <= $1) OR (status = 'processing' AND claimed_at <= $2) ORDER BY scheduled_at, id FOR UPDATE SKIP LOCKED LIMIT $3) UPDATE embody_outbox AS o SET status = 'processing', claimed_at = $1, claimed_by = $4, attempts = o.attempts + 1 FROM candidates WHERE o.id = candidates.id RETURNING o.*`,
      [now, expired, options.limit, options.workerId],
    );
    return result.rows.map(outbox);
  }
  private async failDelivery(
    id: string,
    error: string,
    retryAt: string | undefined,
    dead: boolean,
  ): Promise<EventDelivery | null> {
    const result = await this.client.query(
      "UPDATE embody_event_deliveries SET status = $1, last_error = $2, scheduled_at = COALESCE($3, scheduled_at), claimed_at = NULL, claimed_by = NULL WHERE id = $4 RETURNING *",
      [
        dead ? "dead_letter" : "failed",
        error,
        retryAt === undefined ? null : timestamp(retryAt),
        id,
      ],
    );
    return result.rows[0] === undefined ? null : delivery(result.rows[0]);
  }
  private async fail(
    id: string,
    error: string,
    retryAt: string | undefined,
    dead: boolean,
  ): Promise<OutboxEvent | null> {
    const result = await this.client.query(
      "UPDATE embody_outbox SET status = $1, last_error = $2, scheduled_at = COALESCE($3, scheduled_at), claimed_at = NULL, claimed_by = NULL WHERE id = $4 RETURNING *",
      [
        dead ? "dead_letter" : "failed",
        error,
        retryAt === undefined ? null : timestamp(retryAt),
        id,
      ],
    );
    return result.rows[0] === undefined ? null : outbox(result.rows[0]);
  }
}

export class PostgresStorage implements StorageConnection {
  public readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  public constructor(config: PoolConfig) {
    this.pool = new Pool(config);
  }
  public async ensureSchema(): Promise<void> {
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS embody_schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)",
    );
    for (const migration of STORAGE_MIGRATIONS) {
      const prior = await this.pool.query(
        "SELECT 1 FROM embody_schema_migrations WHERE version = $1",
        [migration.version],
      );
      if (prior.rowCount !== 0) continue;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(migration.postgres);
        await client.query(
          "INSERT INTO embody_schema_migrations (version, applied_at) VALUES ($1, $2)",
          [migration.version, timestamp()],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }
  public async transaction<T>(
    orgId: string,
    callback: (tx: StorageTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
      const value = await callback(new PostgresTransaction(orgId, client));
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  public async close(): Promise<void> {
    await this.pool.end();
  }
}
