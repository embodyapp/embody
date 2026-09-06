# Dynamic Entities & Storage Adapters

> Learn how Embody models business state with Zod, provisions automated CRUD tools, and handles storage in SQLite and PostgreSQL.

---

## 📦 What Are Dynamic Entities?

In traditional frameworks, creating an entity requires writing a database migration, an ORM model, validation rules, REST controllers, and OpenAPI documentation.

In Embody, you declare a **Dynamic Entity** once using a **Zod schema**. Embody handles the rest:
- Creates and manages database storage.
- Enforces strict runtime validation on every read and write.
- Compiles automatic CRUD actions for humans (CLI) and AI agents (MCP).
- Applies optimistic concurrency locking to prevent agents from overwriting concurrent changes.

---

## 🛠️ Declaring an Entity

Entities are declared in the `entities` block of a plugin definition:

```typescript
import { definePlugin, z } from "@embody/core";

export const IssueSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: z.enum(["open", "in_progress", "resolved", "closed"]).default("open"),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  assignedAgentId: z.string().optional(),
  estimatedHours: z.number().positive().optional(),
});

export type Issue = z.output<typeof IssueSchema>;

export const trackerPlugin = definePlugin({
  id: "tracker",
  version: "1.0.0",
  entities: {
    issue: {
      description: "Software bugs and feature tickets tracked by agents",
      schema: IssueSchema,
      indexes: ["status", "severity", "assignedAgentId"],
    },
  },
});
```

### Key Properties:
- `description`: Explains the entity's purpose to AI agents during MCP tool introspection.
- `schema`: A standard Zod schema defining fields, default values, and validations.
- `indexes`: Array of field names that Embody will automatically index in the underlying database for accelerated filtering and sorting.

---

## 🔄 Automatic CRUD Actions

Declaring the `issue` entity above automatically generates six distinct, fully typed actions:

### 1. `create`
Inserts a new record, validates defaults, assigns a UUID, and timestamps the creation:

```bash
embody tracker issue create --title "Fix memory leak in parser" --severity high
```

Programmatic equivalent:
```typescript
const record = await context.entities.issue.create({
  title: "Fix memory leak in parser",
  severity: "high",
});
```

### 2. `get`
Fetches a single record by its UUID:

```bash
embody tracker issue get a7c2e0b5-1234-4567-89ab-cdef01234567
```

Programmatic equivalent:
```typescript
const record = await context.entities.issue.get(issueId);
```

### 3. `list`
Queries records with support for filtering, sorting, and pagination:

```bash
embody tracker issue list --status open --severity critical
```

Programmatic equivalent:
```typescript
const issues = await context.entities.issue.list({
  filter: { status: "open", severity: "critical" },
  sort: { field: "createdAt", direction: "desc" },
  limit: 25,
  offset: 0,
});
```

### 4. `update` (with Optimistic Concurrency Locking)
Applies a partial patch to an existing record:

```bash
embody tracker issue update a7c2e0b5-1234-4567-89ab-cdef01234567 --status in_progress
```

Programmatic equivalent:
```typescript
const updated = await context.entities.issue.update(issueId, {
  status: "in_progress",
  assignedAgentId: "agent-007",
});
```

#### Preventing Concurrent Agent Overwrites (`expectedUpdatedAt`)
When multiple AI agents work on the same tickets concurrently, Agent B might overwrite a change made by Agent A milliseconds earlier. Embody solves this via optimistic locking:

```typescript
// Throws ConflictError if another agent updated this issue in the meantime
await context.entities.issue.update(
  issueId,
  { status: "resolved" },
  { expectedUpdatedAt: issue.updatedAt }
);
```

### 5. `delete`
Removes a record by ID:

```bash
embody tracker issue delete a7c2e0b5-1234-4567-89ab-cdef01234567
```

### 6. `updateMany`
Atomically updates multiple records in a single database transaction:

```typescript
await context.entities.issue.updateMany([
  { id: id1, data: { status: "closed" } },
  { id: id2, data: { status: "closed" } },
]);
```

---

## 🗄️ Storage Adapters: SQLite vs PostgreSQL

Embody includes two first-party transactional storage engines with identical API behavior:

### 1. SQLite Storage (`SqliteStorage`)
- **Default for local development and testing**.
- Embedded and zero-config (stored at `.embody/app.sqlite`).
- Runs in **Write-Ahead Logging (WAL)** mode for fast concurrent reads.
- Synchronous in-process transactions with zero network overhead.

### 2. PostgreSQL Storage (`PostgresStorage`)
- **Engineered for production deployments**.
- Configured automatically when `DATABASE_URL` is set.
- Stores entity data in high-performance **JSONB** columns with GIN indexes.
- Enforces strict tenant isolation via `orgId` and database-level Row-Level Security (RLS).
- Connection pooling managed via Node `pg` pool.

---

## 📑 The Anatomy of an `EntityRecord`

Every entity persisted in Embody is wrapped in a standard `EntityRecord` envelope:

```typescript
interface EntityRecord<TData> {
  /** Unique UUID v4 identifying the record */
  readonly id: string;

  /** Organization / Tenant ID for multi-tenant isolation */
  readonly orgId: string;

  /** The entity name (e.g., "issue") */
  readonly entityType: string;

  /** The user data validated by your Zod schema */
  readonly data: TData;

  /** ISO 8601 UTC timestamp of creation */
  readonly createdAt: string;

  /** ISO 8601 UTC timestamp of last update */
  readonly updatedAt: string;
}
```

This guarantees that every record across your entire organization has uniform IDs, timestamps, and tenant ownership.

Next: **[Actions & Handlers →](./03-actions-and-handlers.md)**
