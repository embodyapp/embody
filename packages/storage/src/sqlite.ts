/* SQLite calls are synchronous but expose the common asynchronous storage port. */
/* eslint-disable @typescript-eslint/require-await */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import type {
  ClaimOutboxOptions,
  EnqueueOutboxInput,
  EntityCreate,
  EntityListOptions,
  EntityRecord,
  EntityUpdate,
  InboxReservation,
  OutboxEvent,
  OutboxStatus,
  StorageConnection,
  StorageTransaction,
} from "./index.js";
import { normalizeTimestamp, STORAGE_MIGRATIONS } from "./index.js";

type SqliteDatabase = Database.Database;
type Row = Record<string, unknown>;

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Entity data must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") throw new TypeError(`Invalid ${field} stored in SQLite`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`Invalid ${field} stored in SQLite`);
  }
}

function timestamp(value?: string): string {
  return normalizeTimestamp(value ?? new Date());
}

function entityFromRow<TData>(row: Row): EntityRecord<TData> {
  return {
    id: String(row["id"]),
    orgId: String(row["org_id"]),
    entityType: String(row["entity_type"]),
    data: parseJson(row["data"], "entity data") as TData,
    createdAt: normalizeTimestamp(String(row["created_at"])),
    updatedAt: normalizeTimestamp(String(row["updated_at"])),
  };
}

function outboxFromRow(row: Row): OutboxEvent {
  const claimedAt = typeof row["claimed_at"] === "string" ? row["claimed_at"] : undefined;
  const claimedBy = typeof row["claimed_by"] === "string" ? row["claimed_by"] : undefined;
  const lastError = typeof row["last_error"] === "string" ? row["last_error"] : undefined;
  return {
    id: String(row["id"]),
    orgId: String(row["org_id"]),
    eventName: String(row["event_name"]),
    payload: parseJson(row["payload"], "outbox payload"),
    occurredAt: normalizeTimestamp(String(row["occurred_at"])),
    scheduledAt: normalizeTimestamp(String(row["scheduled_at"])),
    attempts: Number(row["attempts"]),
    status: String(row["status"]) as OutboxStatus,
    ...(claimedAt === undefined ? {} : { claimedAt }),
    ...(claimedBy === undefined ? {} : { claimedBy }),
    ...(lastError === undefined ? {} : { lastError }),
  };
}

function jsonPath(field: string): string {
  const segments = field.split(".");
  if (segments.some((segment) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment))) {
    throw new RangeError("Sort and filter fields must be declared entity field names");
  }
  return `$.${segments.join(".")}`;
}

function filterLeaves(
  filter: Readonly<Record<string, unknown>>,
  prefix = "",
): readonly [string, unknown][] {
  return Object.entries(filter).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? filterLeaves(value as Readonly<Record<string, unknown>>, path)
      : [[path, value]];
  });
}

class SqliteTransaction implements StorageTransaction {
  public readonly entities = {
    create: async <TData>(orgId: string, entityType: string, input: EntityCreate<TData>) => {
      asObject(input.data);
      const createdAt = timestamp(input.createdAt);
      const updatedAt = timestamp(input.updatedAt ?? createdAt);
      const id = input.id ?? randomUUID();
      this.database
        .prepare(
          "INSERT INTO embody_entities (id, org_id, entity_type, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(id, orgId, entityType, JSON.stringify(input.data), createdAt, updatedAt);
      return { id, orgId, entityType, data: input.data, createdAt, updatedAt };
    },
    get: async <TData>(orgId: string, entityType: string, id: string) => {
      const row = this.database
        .prepare("SELECT * FROM embody_entities WHERE id = ? AND org_id = ? AND entity_type = ?")
        .get(id, orgId, entityType) as Row | undefined;
      return row === undefined ? null : entityFromRow<TData>(row);
    },
    list: async <TData>(orgId: string, entityType: string, options: EntityListOptions = {}) => {
      const clauses = ["org_id = ?", "entity_type = ?"];
      const parameters: unknown[] = [orgId, entityType];
      for (const [field, value] of filterLeaves(options.filter ?? {})) {
        clauses.push("json_extract(data, ?) = json_extract(?, '$')");
        parameters.push(jsonPath(field), JSON.stringify(value));
      }
      const direction = options.sort?.direction === "desc" ? "DESC" : "ASC";
      const order =
        options.sort === undefined
          ? "id ASC"
          : "json_extract(data, ?) IS NULL ASC, json_extract(data, ?) " + direction + ", id ASC";
      if (options.sort !== undefined)
        parameters.push(jsonPath(options.sort.field), jsonPath(options.sort.field));
      const limit = options.limit ?? 20;
      const offset = options.offset ?? 0;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0
      ) {
        throw new RangeError("Invalid pagination");
      }
      parameters.push(limit, offset);
      const rows = this.database
        .prepare(
          `SELECT * FROM embody_entities WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
        )
        .all(...parameters) as Row[];
      return rows.map(entityFromRow<TData>);
    },
    update: async <TData>(
      orgId: string,
      entityType: string,
      id: string,
      update: EntityUpdate<TData>,
    ) => {
      asObject(update.data);
      const updatedAt = timestamp();
      const expectedClause = update.expectedUpdatedAt === undefined ? "" : " AND updated_at = ?";
      const parameters: unknown[] = [JSON.stringify(update.data), updatedAt, id, orgId, entityType];
      if (update.expectedUpdatedAt !== undefined)
        parameters.push(normalizeTimestamp(update.expectedUpdatedAt));
      const result = this.database
        .prepare(
          `UPDATE embody_entities SET data = ?, updated_at = ? WHERE id = ? AND org_id = ? AND entity_type = ?${expectedClause}`,
        )
        .run(...parameters);
      if (result.changes === 0) return null;
      return this.entities.get<TData>(orgId, entityType, id);
    },
    delete: async <TData>(orgId: string, entityType: string, id: string) => {
      const existing = await this.entities.get<TData>(orgId, entityType, id);
      if (existing === null) return null;
      this.database
        .prepare("DELETE FROM embody_entities WHERE id = ? AND org_id = ? AND entity_type = ?")
        .run(id, orgId, entityType);
      return existing;
    },
  };

  public readonly outbox = {
    enqueue: async (orgId: string, input: EnqueueOutboxInput) => {
      const event: OutboxEvent = {
        id: input.id ?? randomUUID(),
        orgId,
        eventName: input.eventName,
        payload: input.payload,
        occurredAt: timestamp(input.occurredAt),
        scheduledAt: timestamp(input.scheduledAt),
        attempts: 0,
        status: "pending",
      };
      this.database
        .prepare(
          "INSERT INTO embody_outbox (id, org_id, event_name, payload, occurred_at, scheduled_at, attempts, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          event.id,
          event.orgId,
          event.eventName,
          JSON.stringify(event.payload),
          event.occurredAt,
          event.scheduledAt,
          event.attempts,
          event.status,
        );
      return event;
    },
    claimBatch: async (options: ClaimOutboxOptions) => this.claim(options),
    complete: async (id: string) => {
      this.database
        .prepare(
          "UPDATE embody_outbox SET status = 'completed', claimed_at = NULL, claimed_by = NULL WHERE id = ?",
        )
        .run(id);
    },
    fail: async (id: string, error: string, retryAt?: string) =>
      this.transitionFailure(id, error, retryAt, false),
    deadLetter: async (id: string, error: string) =>
      this.transitionFailure(id, error, undefined, true),
    list: async (options: { readonly status?: OutboxStatus; readonly limit?: number } = {}) => {
      const limit = options.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new RangeError("Invalid limit");
      const rows =
        options.status === undefined
          ? this.database
              .prepare("SELECT * FROM embody_outbox ORDER BY scheduled_at, id LIMIT ?")
              .all(limit)
          : this.database
              .prepare(
                "SELECT * FROM embody_outbox WHERE status = ? ORDER BY scheduled_at, id LIMIT ?",
              )
              .all(options.status, limit);
      return (rows as Row[]).map(outboxFromRow);
    },
  };

  public readonly inbox = {
    reserve: async (eventId: string, handlerId: string): Promise<InboxReservation> => {
      const now = timestamp();
      const inserted = this.database
        .prepare(
          "INSERT INTO embody_inbox (event_id, handler_id, status, created_at, updated_at) VALUES (?, ?, 'reserved', ?, ?) ON CONFLICT(event_id, handler_id) DO NOTHING",
        )
        .run(eventId, handlerId, now, now);
      if (inserted.changes === 1) return { state: "new", eventId, handlerId };
      const row = this.database
        .prepare("SELECT status FROM embody_inbox WHERE event_id = ? AND handler_id = ?")
        .get(eventId, handlerId) as Row;
      const state =
        row["status"] === "completed"
          ? "completed"
          : row["status"] === "reserved"
            ? "in-progress"
            : "duplicate";
      return { state, eventId, handlerId };
    },
    complete: async (eventId: string, handlerId: string) => {
      this.database
        .prepare(
          "UPDATE embody_inbox SET status = 'completed', last_error = NULL, updated_at = ? WHERE event_id = ? AND handler_id = ?",
        )
        .run(timestamp(), eventId, handlerId);
    },
    fail: async (eventId: string, handlerId: string, error: string) => {
      this.database
        .prepare(
          "UPDATE embody_inbox SET status = 'failed', last_error = ?, updated_at = ? WHERE event_id = ? AND handler_id = ?",
        )
        .run(error, timestamp(), eventId, handlerId);
    },
  };

  public constructor(
    public readonly orgId: string,
    private readonly database: SqliteDatabase,
  ) {}

  private async claim(options: ClaimOutboxOptions): Promise<readonly OutboxEvent[]> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
      throw new RangeError("Invalid claim limit");
    const now = timestamp(options.now);
    const expired = new Date(new Date(now).getTime() - (options.leaseMs ?? 30_000)).toISOString();
    const rows = this.database
      .prepare(
        "SELECT * FROM embody_outbox WHERE (status IN ('pending', 'failed') AND scheduled_at <= ?) OR (status = 'processing' AND claimed_at <= ?) ORDER BY scheduled_at, id LIMIT ?",
      )
      .all(now, expired, options.limit) as Row[];
    const claimed: OutboxEvent[] = [];
    for (const row of rows) {
      const updated = this.database
        .prepare(
          "UPDATE embody_outbox SET status = 'processing', claimed_at = ?, claimed_by = ?, attempts = attempts + 1 WHERE id = ? AND (status IN ('pending', 'failed') OR (status = 'processing' AND claimed_at <= ?))",
        )
        .run(now, options.workerId, row["id"], expired);
      if (updated.changes === 1)
        claimed.push(
          outboxFromRow({
            ...row,
            status: "processing",
            claimed_at: now,
            claimed_by: options.workerId,
            attempts: Number(row["attempts"]) + 1,
          }),
        );
    }
    return claimed;
  }

  private async transitionFailure(
    id: string,
    error: string,
    retryAt: string | undefined,
    dead: boolean,
  ): Promise<OutboxEvent | null> {
    this.database
      .prepare(
        `UPDATE embody_outbox SET status = ?, last_error = ?, scheduled_at = COALESCE(?, scheduled_at), claimed_at = NULL, claimed_by = NULL WHERE id = ?`,
      )
      .run(
        dead ? "dead_letter" : "failed",
        error,
        retryAt === undefined ? null : timestamp(retryAt),
        id,
      );
    const row = this.database.prepare("SELECT * FROM embody_outbox WHERE id = ?").get(id) as
      Row | undefined;
    return row === undefined ? null : outboxFromRow(row);
  }
}

export interface SqliteStorageOptions {
  readonly filename: string;
}

/** SQLite/JSON1 adapter. A connection serializes claims with BEGIN IMMEDIATE. */
export class SqliteStorage implements StorageConnection {
  private readonly database: SqliteDatabase;
  private active = false;

  public constructor(options: SqliteStorageOptions) {
    this.database = new Database(options.filename);
    try {
      this.database.prepare("SELECT json('{}')").get();
    } catch {
      this.database.close();
      throw new Error("SQLite JSON1 extension is required");
    }
  }

  public async ensureSchema(): Promise<void> {
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS embody_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    for (const migration of STORAGE_MIGRATIONS) {
      const exists = this.database
        .prepare("SELECT 1 FROM embody_schema_migrations WHERE version = ?")
        .get(migration.version);
      if (exists !== undefined) continue;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(migration.sqlite);
        this.database
          .prepare("INSERT INTO embody_schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, timestamp());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  public async transaction<T>(
    orgId: string,
    callback: (tx: StorageTransaction) => Promise<T>,
  ): Promise<T> {
    if (this.active) throw new Error("Nested SQLite transactions are not supported");
    this.active = true;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = await callback(new SqliteTransaction(orgId, this.database));
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.active = false;
    }
  }

  public async close(): Promise<void> {
    this.database.close();
  }
}
