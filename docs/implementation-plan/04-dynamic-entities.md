# Phase 4 — Dynamic entities and auto-CRUD

**Spec:** 03 and Kanban portions of 08. **Status:** P4-01 to P4-03.

## Objective

Compile each declared Zod entity into tenant-safe stores, five atomic actions, hooks/events, and manifest entries with matching behavior on SQLite and PostgreSQL.

## P4-01: entity compiler and contextual stores

- Validate entity names, object schemas, index keys, and default sort at boot. Reject unsupported schema constructs with plugin/entity location.
- Bind `ctx.entities.<entity>` to current org and transaction; never accept caller-provided org IDs.
- Entity record shape: `{id, orgId, entityType, data, createdAt, updatedAt}`; decide not-found behavior consistently (`get` recommended to throw, optional internal `find`).
- Validate filters and sort fields against declared schema. MVP filters are exact nested containment only; document unsupported operators. Sort values should have deterministic null handling and ID tie-breaker.
- Cap list limit at 100 and ensure defaults of 20/0.

## P4-02: generated action lifecycle

Generate `<plugin>.<entity>.create|get|list|update|delete`:

- **create:** parse input/defaults → begin tenant transaction → run `beforeCreate` → insert → run `afterCreate` → enqueue standard `created` event if approved → commit.
- **get/list:** parse and execute tenant-bound reads. Permission enforcement happens in execution phase, but these handlers cannot bypass org binding.
- **update:** lock/load current → merge patch → parse full schema/default semantics → `beforeUpdate({current, patch})` → update → `afterUpdate({current, updated})` → publish `updated` → commit. Empty patch policy is explicit.
- **delete:** lock/load → `beforeDelete` → delete → `afterDelete({deleted})` → publish `deleted` → commit.

Resolve generated event naming consistently (`plugin.entity.created|updated|deleted`). Publishing must share the mutation transaction via transaction-bound context. Return records only after successful commit.

## P4-03: transactional bulk entity operations

Add typed `getMany` and `updateMany` contextual-store operations so custom actions do not reimplement common atomicity rules. The interface must explicitly define empty and duplicate ID behavior, validate tenant ownership for the complete input before mutation, preserve input/result ordering, run each record's normal lifecycle hooks and events, and roll back the entire operation after any validation, guardrail, conflict, or outbox failure. Implement equivalent behavior on SQLite and PostgreSQL without exposing adapter transactions to plugins.

Zod errors become safe field-path validation details. Unknown fields obey the schema's explicit policy; generated patch must not accidentally make nested required objects partially valid.

## Tests and success criteria

Run CRUD lifecycle tests once against SQLite and once against PostgreSQL:

1. Declaring one entity registers exactly five actions with expected canonical names and valid manifest JSON Schemas.
2. Create applies Zod defaults, rejects invalid/missing/unknown data per policy, invokes hooks in order, and returns normalized record.
3. Get/list expose only current org and entity type, including attempts using another org's known UUID.
4. List exact filters nested JSON correctly; sort asc/desc is stable; limit 0/101, negative offset, unknown sort/filter paths, and SQL-injection-like fields are rejected.
5. Update accepts valid partial data, validates the fully merged result, preserves omitted fields, changes `updatedAt`, and rejects invalid merged data.
6. Concurrent updates follow the phase-2 conflict/locking policy rather than silently losing one update.
7. Delete runs hooks and makes record unavailable; repeated delete gets stable not-found behavior.
8. Every before-hook veto rolls back mutation and outbox; every after-hook failure also rolls back both.
9. Successful create/update/delete commits entity change and corresponding outbox rows atomically. A forced enqueue failure rolls back entity change.
10. Entity data with Zod evolution (new optional/default field) reads old records without DDL; newly written records use new validation/default behavior.
11. Contextual store calls from a custom action have identical validation, hook, tenant, transaction, and event behavior; they must not be a lower-level bypass.
12. UUID/timestamp and pagination output are stable across adapters.
13. Bulk reads preserve order and reject missing/cross-tenant IDs without partial results; bulk updates reject duplicate/empty IDs according to the documented policy, run all normal hooks/events, and roll back every mutation when any item fails.

Add compile-time tests showing inferred entity create/update/store types. Add manifest golden tests for the Kanban card schema, including enum/default/URL/optional fields.

Phase 4 passes when both adapter suites are green and a sample plugin can perform all CRUD through only public kernel APIs with no migration after adding an optional entity field.