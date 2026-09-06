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
  EventDelivery,
  CreateEventDeliveryInput,
  InboxReservation,
  OutboxEvent,
  OutboxStatus,
  WorkflowInstance,
  StoredPrincipal,
  WorkflowSnapshot,
  WorkflowStep,
  WorkflowRepository,
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
    payload: parseJson(row["payload"], "outbox payload"),
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

function deliveryFromRow(row: Row): EventDelivery {
  const claimedAt = typeof row["claimed_at"] === "string" ? row["claimed_at"] : undefined;
  const claimedBy = typeof row["claimed_by"] === "string" ? row["claimed_by"] : undefined;
  const lastError = typeof row["last_error"] === "string" ? row["last_error"] : undefined;
  return {
    id: String(row["id"]),
    eventId: String(row["event_id"]),
    orgId: String(row["org_id"]),
    destinationAppId: String(row["destination_app_id"]),
    destinationEndpoint: String(row["destination_endpoint"]),
    envelope: parseJson(row["envelope"], "event delivery envelope"),
    scheduledAt: normalizeTimestamp(String(row["scheduled_at"])),
    attempts: Number(row["attempts"]),
    status: String(row["status"]) as OutboxStatus,
    ...(claimedAt === undefined ? {} : { claimedAt }),
    ...(claimedBy === undefined ? {} : { claimedBy }),
    ...(lastError === undefined ? {} : { lastError }),
  };
}

function workflowInstanceFromRow(row: Row): WorkflowInstance {
  return {
    id: String(row["id"]),
    orgId: String(row["org_id"]),
    definition: String(row["definition"]),
    definitionVersion: String(row["definition_version"]),
    idempotencyKey: String(row["idempotency_key"]),
    inputHash: String(row["input_hash"]),
    input: parseJson(row["input"], "workflow input"),
    principal: parseJson(row["principal"], "workflow principal") as StoredPrincipal,
    status: String(row["status"]) as WorkflowInstance["status"],
    ...(row["output"] === null ? {} : { output: parseJson(row["output"], "workflow output") }),
    ...(typeof row["error"] === "string" ? { error: row["error"] } : {}),
    cancelRequested: Number(row["cancel_requested"]) === 1,
    createdAt: normalizeTimestamp(String(row["created_at"])),
    updatedAt: normalizeTimestamp(String(row["updated_at"])),
    optimisticVersion: Number(row["optimistic_version"]),
  };
}
function workflowStepFromRow(row: Row): WorkflowStep {
  return {
    id: String(row["id"]),
    instanceId: String(row["instance_id"]),
    orgId: String(row["org_id"]),
    name: String(row["name"]),
    status: String(row["status"]) as WorkflowStep["status"],
    dependencies: parseJson(row["dependencies"], "workflow dependencies") as string[],
    attempt: Number(row["attempt"]),
    scheduledAt: normalizeTimestamp(String(row["scheduled_at"])),
    compensatable: Number(row["compensatable"]) === 1,
    ...(row["output"] === null ? {} : { output: parseJson(row["output"], "workflow step output") }),
    ...(typeof row["error"] === "string" ? { error: row["error"] } : {}),
    ...(typeof row["claimed_at"] === "string"
      ? { claimedAt: normalizeTimestamp(row["claimed_at"]) }
      : {}),
    ...(typeof row["claimed_by"] === "string" ? { claimedBy: row["claimed_by"] } : {}),
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
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
        ...(input.producerPluginId === undefined
          ? {}
          : { producerPluginId: input.producerPluginId }),
        ...(input.schemaVersion === undefined ? {} : { schemaVersion: input.schemaVersion }),
      };
      this.database
        .prepare(
          "INSERT INTO embody_outbox (id, org_id, event_name, payload, occurred_at, scheduled_at, attempts, status, correlation_id, causation_id, producer_plugin_id, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          event.correlationId ?? null,
          event.causationId ?? null,
          event.producerPluginId ?? null,
          event.schemaVersion ?? null,
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

  public readonly eventDeliveries = {
    create: async (input: CreateEventDeliveryInput): Promise<EventDelivery> => {
      const id = input.id ?? randomUUID();
      const scheduledAt = timestamp(input.scheduledAt);
      this.database
        .prepare(
          "INSERT INTO embody_event_deliveries (id, event_id, org_id, destination_app_id, destination_endpoint, envelope, scheduled_at, attempts, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?) ON CONFLICT(event_id, destination_app_id) DO NOTHING",
        )
        .run(
          id,
          input.eventId,
          input.orgId,
          input.destinationAppId,
          input.destinationEndpoint,
          JSON.stringify(input.envelope),
          scheduledAt,
          timestamp(),
        );
      const row = this.database
        .prepare(
          "SELECT * FROM embody_event_deliveries WHERE event_id = ? AND destination_app_id = ?",
        )
        .get(input.eventId, input.destinationAppId) as Row;
      return deliveryFromRow(row);
    },
    claimBatch: async (options: ClaimOutboxOptions): Promise<readonly EventDelivery[]> => {
      this.assertClaimOptions(options);
      const now = timestamp(options.now);
      const expired = new Date(new Date(now).getTime() - (options.leaseMs ?? 30_000)).toISOString();
      const rows = this.database
        .prepare(
          "SELECT * FROM embody_event_deliveries WHERE (status IN ('pending', 'failed') AND scheduled_at <= ?) OR (status = 'processing' AND claimed_at <= ?) ORDER BY scheduled_at, id LIMIT ?",
        )
        .all(now, expired, options.limit) as Row[];
      const claimed: EventDelivery[] = [];
      for (const row of rows) {
        const changed = this.database
          .prepare(
            "UPDATE embody_event_deliveries SET status = 'processing', claimed_at = ?, claimed_by = ?, attempts = attempts + 1 WHERE id = ? AND (status IN ('pending', 'failed') OR (status = 'processing' AND claimed_at <= ?))",
          )
          .run(now, options.workerId, row["id"], expired);
        if (changed.changes === 1)
          claimed.push(
            deliveryFromRow({
              ...row,
              status: "processing",
              claimed_at: now,
              claimed_by: options.workerId,
              attempts: Number(row["attempts"]) + 1,
            }),
          );
      }
      return claimed;
    },
    complete: async (id: string): Promise<void> => {
      this.database
        .prepare(
          "UPDATE embody_event_deliveries SET status = 'completed', completed_at = ?, claimed_at = NULL, claimed_by = NULL WHERE id = ?",
        )
        .run(timestamp(), id);
    },
    fail: async (id: string, error: string, retryAt?: string) =>
      this.transitionDeliveryFailure(id, error, retryAt, false),
    deadLetter: async (id: string, error: string) =>
      this.transitionDeliveryFailure(id, error, undefined, true),
    list: async (options: { readonly status?: OutboxStatus; readonly limit?: number } = {}) => {
      const limit = options.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new RangeError("Invalid limit");
      const rows =
        options.status === undefined
          ? this.database
              .prepare("SELECT * FROM embody_event_deliveries ORDER BY scheduled_at, id LIMIT ?")
              .all(limit)
          : this.database
              .prepare(
                "SELECT * FROM embody_event_deliveries WHERE status = ? ORDER BY scheduled_at, id LIMIT ?",
              )
              .all(options.status, limit);
      return (rows as Row[]).map(deliveryFromRow);
    },
  };

  public readonly workflows = {
    start: async (input: Parameters<WorkflowRepository["start"]>[0]) => {
      const prior = this.database
        .prepare(
          "SELECT * FROM embody_workflow_instances WHERE org_id = ? AND definition = ? AND idempotency_key = ?",
        )
        .get(input.orgId, input.definition, input.idempotencyKey) as Row | undefined;
      if (prior !== undefined) {
        const instance = workflowInstanceFromRow(prior);
        if (instance.inputHash !== input.inputHash)
          throw new Error("WORKFLOW_IDEMPOTENCY_CONFLICT");
        return { instance, created: false };
      }
      this.database
        .prepare(
          "INSERT INTO embody_workflow_instances (id, org_id, definition, definition_version, idempotency_key, input_hash, input, principal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        )
        .run(
          input.id,
          input.orgId,
          input.definition,
          input.definitionVersion,
          input.idempotencyKey,
          input.inputHash,
          JSON.stringify(input.input),
          JSON.stringify(input.principal),
          input.now,
          input.now,
        );
      for (const [position, step] of input.steps.entries())
        this.database
          .prepare(
            "INSERT INTO embody_workflow_steps (id, instance_id, org_id, name, position, status, dependencies, scheduled_at, compensatable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            step.id,
            input.id,
            input.orgId,
            step.name,
            position,
            step.dependencies.length === 0 ? "pending" : "blocked",
            JSON.stringify(step.dependencies),
            step.scheduledAt,
            step.compensatable ? 1 : 0,
          );
      return {
        instance: workflowInstanceFromRow(
          this.database
            .prepare("SELECT * FROM embody_workflow_instances WHERE id = ?")
            .get(input.id) as Row,
        ),
        created: true,
      };
    },
    get: async (id: string): Promise<WorkflowSnapshot | null> => this.workflowSnapshot(id),
    cancel: async (id: string, now: string): Promise<WorkflowSnapshot | null> => {
      const instance = await this.workflowSnapshot(id);
      if (instance === null) return null;
      if (["completed", "failed", "cancelled", "compensated"].includes(instance.status))
        return instance;
      this.database
        .prepare(
          "UPDATE embody_workflow_instances SET cancel_requested = 1, status = CASE WHEN EXISTS (SELECT 1 FROM embody_workflow_steps WHERE instance_id = ? AND status = 'completed' AND compensatable = 1) THEN 'compensating' ELSE 'cancelled' END, updated_at = ?, optimistic_version = optimistic_version + 1 WHERE id = ?",
        )
        .run(id, now, id);
      this.database
        .prepare(
          "UPDATE embody_workflow_steps SET status = 'cancelled', claimed_at = NULL, claimed_by = NULL WHERE instance_id = ? AND status IN ('pending','blocked','waiting')",
        )
        .run(id);
      this.database
        .prepare(
          "UPDATE embody_workflow_steps SET status = 'compensating', scheduled_at = ? WHERE instance_id = ? AND status = 'completed' AND compensatable = 1",
        )
        .run(now, id);
      return this.workflowSnapshot(id);
    },
    retry: async (id: string, now: string): Promise<WorkflowSnapshot | null> => {
      const instance = await this.workflowSnapshot(id);
      if (instance === null) return null;
      if (instance.status !== "failed") throw new Error("WORKFLOW_NOT_RETRYABLE");
      this.database
        .prepare(
          "UPDATE embody_workflow_instances SET status = 'running', error = NULL, cancel_requested = 0, updated_at = ?, optimistic_version = optimistic_version + 1 WHERE id = ?",
        )
        .run(now, id);
      this.database
        .prepare(
          "UPDATE embody_workflow_steps SET status = 'pending', error = NULL, scheduled_at = ? WHERE instance_id = ? AND status = 'failed'",
        )
        .run(now, id);
      return this.workflowSnapshot(id);
    },
    claimBatch: async (options: ClaimOutboxOptions): Promise<readonly WorkflowStep[]> => {
      this.assertClaimOptions(options);
      const now = timestamp(options.now);
      const expired = new Date(new Date(now).getTime() - (options.leaseMs ?? 30_000)).toISOString();
      const rows = this.database
        .prepare(
          `SELECT s.* FROM embody_workflow_steps s JOIN embody_workflow_instances i ON i.id=s.instance_id WHERE i.cancel_requested=0 AND (((s.status IN ('pending','waiting')) AND s.scheduled_at <= ?) OR (s.status='running' AND s.claimed_at <= ?)) AND NOT EXISTS (SELECT 1 FROM json_each(s.dependencies) d LEFT JOIN embody_workflow_steps p ON p.instance_id=s.instance_id AND p.name=d.value WHERE p.status IS NULL OR p.status != 'completed') UNION ALL SELECT s.* FROM embody_workflow_steps s WHERE s.status='compensating' AND s.scheduled_at <= ? AND NOT EXISTS (SELECT 1 FROM embody_workflow_steps later WHERE later.instance_id=s.instance_id AND later.status='compensating' AND later.position > s.position) ORDER BY scheduled_at, id LIMIT ?`,
        )
        .all(now, expired, now, options.limit) as Row[];
      const claimed: WorkflowStep[] = [];
      for (const row of rows) {
        const next = row["status"] === "compensating" ? "compensating" : "running";
        const changed = this.database
          .prepare(
            "UPDATE embody_workflow_steps SET status=?, claimed_at=?, claimed_by=?, attempt=attempt+1 WHERE id=? AND (status IN ('pending','waiting','compensating') OR (status='running' AND claimed_at <= ?))",
          )
          .run(next, now, options.workerId, row["id"], expired);
        if (changed.changes === 1) {
          this.database
            .prepare(
              "UPDATE embody_workflow_instances SET status = CASE WHEN status='pending' THEN 'running' ELSE status END, updated_at=? WHERE id=?",
            )
            .run(now, row["instance_id"]);
          claimed.push(
            workflowStepFromRow({
              ...row,
              status: next,
              claimed_at: now,
              claimed_by: options.workerId,
              attempt: Number(row["attempt"]) + 1,
            }),
          );
        }
      }
      return claimed;
    },
    completeStep: async (input: {
      readonly id: string;
      readonly output: unknown;
      readonly now: string;
      readonly resultStep: boolean;
    }) => {
      const row = this.database
        .prepare("SELECT * FROM embody_workflow_steps WHERE id=?")
        .get(input.id) as Row | undefined;
      if (!row) return;
      const parent = this.database
        .prepare("SELECT cancel_requested FROM embody_workflow_instances WHERE id=?")
        .get(row["instance_id"]) as Row;
      if (Number(parent["cancel_requested"]) === 1 && row["status"] !== "compensating") {
        this.database
          .prepare(
            "UPDATE embody_workflow_steps SET status=?, output=?, claimed_at=NULL, claimed_by=NULL WHERE id=?",
          )
          .run(
            Number(row["compensatable"]) === 1 ? "compensating" : "cancelled",
            JSON.stringify(input.output),
            input.id,
          );
        this.database
          .prepare("UPDATE embody_workflow_instances SET status=?, updated_at=? WHERE id=?")
          .run(
            Number(row["compensatable"]) === 1 ? "compensating" : "cancelled",
            input.now,
            row["instance_id"],
          );
        return;
      }
      if (row["status"] === "compensating") {
        this.database
          .prepare(
            "UPDATE embody_workflow_steps SET status='compensated', claimed_at=NULL, claimed_by=NULL, completed_at=? WHERE id=?",
          )
          .run(input.now, input.id);
        const remains = this.database
          .prepare(
            "SELECT 1 FROM embody_workflow_steps WHERE instance_id=? AND status='compensating'",
          )
          .get(row["instance_id"]);
        if (!remains)
          this.database
            .prepare(
              "UPDATE embody_workflow_instances SET status='compensated', updated_at=?, optimistic_version=optimistic_version+1 WHERE id=?",
            )
            .run(input.now, row["instance_id"]);
        return;
      }
      this.database
        .prepare(
          "UPDATE embody_workflow_steps SET status='completed', output=?, error=NULL, claimed_at=NULL, claimed_by=NULL, completed_at=? WHERE id=?",
        )
        .run(JSON.stringify(input.output), input.now, input.id);
      this.database
        .prepare(
          `UPDATE embody_workflow_steps SET status='pending' WHERE instance_id=? AND status='blocked' AND EXISTS (SELECT 1 FROM embody_workflow_instances i WHERE i.id=embody_workflow_steps.instance_id AND i.cancel_requested=0) AND NOT EXISTS (SELECT 1 FROM json_each(embody_workflow_steps.dependencies) d LEFT JOIN embody_workflow_steps p ON p.instance_id=embody_workflow_steps.instance_id AND p.name=d.value WHERE p.status IS NULL OR p.status!='completed')`,
        )
        .run(row["instance_id"]);
      if (input.resultStep)
        this.database
          .prepare(
            "UPDATE embody_workflow_instances SET status='completed', output=?, updated_at=?, optimistic_version=optimistic_version+1 WHERE id=?",
          )
          .run(JSON.stringify(input.output), input.now, row["instance_id"]);
      else
        this.database
          .prepare(
            "UPDATE embody_workflow_instances SET updated_at=?, optimistic_version=optimistic_version+1 WHERE id=?",
          )
          .run(input.now, row["instance_id"]);
    },
    failStep: async (input: {
      readonly id: string;
      readonly error: string;
      readonly retryAt?: string;
      readonly terminal: boolean;
      readonly now: string;
    }) => {
      const row = this.database
        .prepare("SELECT * FROM embody_workflow_steps WHERE id=?")
        .get(input.id) as Row | undefined;
      if (!row) return;
      if (row["status"] === "compensating") {
        this.database
          .prepare(
            "UPDATE embody_workflow_steps SET status='compensation_failed', error=?, claimed_at=NULL, claimed_by=NULL WHERE id=?",
          )
          .run(input.error, input.id);
        this.database
          .prepare(
            "UPDATE embody_workflow_instances SET status='failed', error=?, updated_at=?, optimistic_version=optimistic_version+1 WHERE id=?",
          )
          .run("Compensation failed", input.now, row["instance_id"]);
        return;
      }
      this.database
        .prepare(
          "UPDATE embody_workflow_steps SET status=?, error=?, scheduled_at=?, claimed_at=NULL, claimed_by=NULL WHERE id=?",
        )
        .run(
          input.terminal ? "failed" : "waiting",
          input.error,
          input.retryAt ?? input.now,
          input.id,
        );
      this.database
        .prepare(
          "UPDATE embody_workflow_instances SET status=?, error=?, updated_at=?, optimistic_version=optimistic_version+1 WHERE id=?",
        )
        .run(input.terminal ? "failed" : "waiting", input.error, input.now, row["instance_id"]);
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

  private async workflowSnapshot(id: string): Promise<WorkflowSnapshot | null> {
    const row = this.database
      .prepare("SELECT * FROM embody_workflow_instances WHERE id=? AND org_id=?")
      .get(id, this.orgId) as Row | undefined;
    if (row === undefined) return null;
    const steps = this.database
      .prepare("SELECT * FROM embody_workflow_steps WHERE instance_id=? ORDER BY rowid")
      .all(id) as Row[];
    return { ...workflowInstanceFromRow(row), steps: steps.map(workflowStepFromRow) };
  }

  private assertClaimOptions(options: ClaimOutboxOptions): void {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
      throw new RangeError("Invalid claim limit");
  }

  private async claim(options: ClaimOutboxOptions): Promise<readonly OutboxEvent[]> {
    this.assertClaimOptions(options);
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

  private async transitionDeliveryFailure(
    id: string,
    error: string,
    retryAt: string | undefined,
    dead: boolean,
  ): Promise<EventDelivery | null> {
    this.database
      .prepare(
        "UPDATE embody_event_deliveries SET status = ?, last_error = ?, scheduled_at = COALESCE(?, scheduled_at), claimed_at = NULL, claimed_by = NULL WHERE id = ?",
      )
      .run(
        dead ? "dead_letter" : "failed",
        error,
        retryAt === undefined ? null : timestamp(retryAt),
        id,
      );
    const row = this.database
      .prepare("SELECT * FROM embody_event_deliveries WHERE id = ?")
      .get(id) as Row | undefined;
    return row === undefined ? null : deliveryFromRow(row);
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
  public readonly dialect = "sqlite" as const;
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
