# 03. Dynamic Entity Engine Specification

## 1. Zero-Migration Dynamic Entity Model

A primary friction point in rapid agent app development is managing relational database migrations whenever new fields or entities are introduced. 

The Embody Dynamic Entity Engine solves this by pairing **TypeScript Zod schemas** with a **Universal Document Store** (Postgres `JSONB` or SQLite JSON). Developers gain strict compile-time and runtime type safety, fast indexed queries, and auto-generated CRUD actions with **zero SQL DDL migration files**.

---

## 2. Storage Architecture & Database Schema

### 2.1 PostgreSQL Production Schema
```sql
CREATE TABLE IF NOT EXISTS embody_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Multi-tenant compound index for fast entity type scanning
CREATE INDEX IF NOT EXISTS idx_entities_tenant_type 
  ON embody_entities (org_id, entity_type);

-- GIN index for high-performance JSONB filtering, containment (@>), and path extraction
CREATE INDEX IF NOT EXISTS idx_entities_data_gin 
  ON embody_entities USING gin (data);
```

### 2.2 SQLite Development Schema
```sql
CREATE TABLE IF NOT EXISTS embody_entities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  data TEXT NOT NULL, -- JSON string
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entities_tenant_type 
  ON embody_entities (org_id, entity_type);
```

---

## 3. Entity Definition Interface

```typescript
import { z } from "zod";

export interface EntityDefinition<TSchema extends z.ZodObject<any> = z.ZodObject<any>> {
  /**
   * Human-readable description for AI agents in MCP tool descriptions.
   */
  description?: string;

  /**
   * Zod validation schema for entity data attributes.
   */
  schema: TSchema;

  /**
   * Optional custom field indexes for explicit B-Tree extraction.
   */
  indexes?: (keyof z.infer<TSchema>)[];

  /**
   * Optional default sorting field and order.
   */
  defaultSort?: { field: string; direction: "asc" | "desc" };
}
```

---

## 4. Auto-Generated Action Matrix

When a plugin declares an entity (e.g. `card` under plugin `kanban`), the framework compiles 5 atomic actions:

### 4.1 `kanban.card.create`
* **Input Schema**: `z.object({ data: CardSchema })`
* **Lifecycle**:
  1. Validates `input.data` against the Zod schema.
  2. Runs `kanban.card.beforeCreate` vetoable hooks.
  3. Inserts record into `embody_entities` with `org_id` from `ctx.orgId`.
  4. Runs `kanban.card.afterCreate` post-commit hooks / outbox events.
  5. Returns created record `{ id, orgId, entityType, data, createdAt, updatedAt }`.

### 4.2 `kanban.card.get`
* **Input Schema**: `z.object({ id: z.string().uuid() })`
* **Lifecycle**:
  1. Executes query `SELECT * FROM embody_entities WHERE id = $1 AND org_id = $2`.
  2. Parses JSON data and returns entity.

### 4.3 `kanban.card.list`
* **Input Schema**:
  ```typescript
  z.object({
    filter: z.record(z.any()).optional(),
    sort: z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) }).optional(),
    limit: z.number().min(1).max(100).default(20),
    offset: z.number().min(0).default(0),
  })
  ```
* **Query Compilation**:
  Compiles SQL using Postgres JSON containment:
  `WHERE org_id = $1 AND entity_type = 'card' AND data @> $2::jsonb ORDER BY data->>$3 LIMIT $4 OFFSET $5`.

### 4.4 `kanban.card.update`
* **Input Schema**: `z.object({ id: z.string().uuid(), data: CardSchema.partial() })`
* **Lifecycle**:
  1. Loads existing record with tenant isolation check.
  2. Merges existing data with patch and validates merged result against Zod schema.
  3. Runs `kanban.card.beforeUpdate` vetoable hooks.
  4. Executes `UPDATE embody_entities SET data = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`.
  5. Dispatches `kanban.card.updated` outbox event.

### 4.5 `kanban.card.delete`
* **Input Schema**: `z.object({ id: z.string().uuid() })`
* **Lifecycle**:
  1. Loads record and verifies tenant ownership.
  2. Runs `kanban.card.beforeDelete` vetoable hooks.
  3. Executes `DELETE FROM embody_entities WHERE id = $1 AND org_id = $2`.
  4. Dispatches `kanban.card.deleted` event.
