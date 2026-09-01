# Phase 2 — Storage and transactions

**Specs:** 03 §2, 04 RLS flow, 06 §2–3. **Status:** P2-01 to P2-03.

## Objective

Provide a narrow transactional storage abstraction with behaviorally equivalent SQLite and PostgreSQL implementations. Entity/outbox business lifecycle remains in later phases.

## P2-01: storage port and schema

Define internal ports for:

- connection lifecycle and idempotent `ensureSchema()`;
- `transaction(orgId, callback)` with transaction-scoped entity, outbox, inbox, and gateway-delivery repositories;
- entity insert/get/list/update/delete with explicit `orgId` and `entityType` on every operation;
- outbox enqueue, claim batch, complete/fail/dead-letter, and query for inspector;
- inbox idempotency reservation/completion;
- gateway registry/audit/delivery persistence (kept in gateway adapter namespace).

Transaction handles must not escape callback scope. Nested behavior must be explicit (recommended: reuse current transaction with savepoints unsupported initially). Normalize timestamps to ISO UTC and IDs to UUID strings at the boundary.

Schema includes specified entity/outbox tables and indexes plus:

- outbox `dead_letter` status and optional `claimed_at/claimed_by` lease fields;
- `embody_inbox(event_id, handler_id, status, last_error, timestamps)` unique on event/handler;
- gateway registry, audit, and event delivery tables as approved by ADR.

Use forward-only numbered internal schema migrations rather than assuming `CREATE TABLE IF NOT EXISTS` can evolve released installations. This does not violate zero-migration **entity evolution**: framework infrastructure schema still requires safe upgrades.

## P2-02: SQLite adapter

- Store entity/payload JSON as canonical text and parse defensively.
- Compile filter equality/containment using safe parameter binding and JSON1 functions; if JSON1 is unavailable, fail startup clearly.
- Validate sort fields against entity schema before repository call; never interpolate user-provided paths/directions directly.
- Implement claim semantics suitable for one process and serialize worker claims through a short transaction.
- Generate UUIDs in application code.

## P2-03: PostgreSQL adapter and RLS

- Implement JSONB containment, bounded pagination, safe JSON path sorting, `FOR UPDATE SKIP LOCKED`, and schema indexes from specs.
- Add and enable RLS policies using `current_setting('app.current_org', true)`. In every tenant transaction execute `SET LOCAL app.current_org = ...`; use a non-owner/non-superuser runtime role in tests and deployment docs.
- Separate schema-owner credentials from runtime credentials.
- Claims atomically transition rows to processing (or acquire a lease) so handler execution outside the claim transaction cannot be selected again.

## Shared adapter conformance suite

Run exactly the same behavior suite against both adapters:

1. Schema ensure is repeatable and upgrades from each retained prior schema fixture.
2. Commit persists entity and outbox together; thrown callbacks roll both back.
3. Same IDs in different orgs cannot be read/listed/updated/deleted across tenants.
4. Type scans do not mix entity types; filters, sort, defaults, limit, and offset agree between adapters.
5. JSON containing quotes, Unicode, nested objects, arrays, booleans, and null round-trips; injection strings remain data.
6. Optimistic update semantics are defined and tested (recommended `updated_at`/version conflict rather than lost updates).
7. Claim order follows `scheduled_at`; completed/dead-letter/future items are not claimed.
8. Inbox reservation returns “new” once and “duplicate/in-progress/completed” thereafter.
9. All connections/statements close after success and failure.

## PostgreSQL-only success criteria

- Two concurrent worker connections claim disjoint event IDs under contention; total claims equal eligible rows with no duplicates.
- RLS blocks raw SQL cross-org reads and writes even when repository predicates are accidentally omitted in a test-only query.
- `SET LOCAL` does not leak org identity when a pooled connection is returned/reused.
- Query plans for tenant/type list and queue claim use specified indexes on a realistically populated fixture (assert plan shape loosely, not cost numbers).

## SQLite-only success criteria

- Two worker instances sharing a file cannot both own the same claim.
- Lock/busy errors are retried within a bounded policy and then become structured unavailable errors.
- Temporary DB tests work on the minimum supported SQLite/JSON1 version.

Phase 2 passes when adapter conformance is green for real SQLite and containerized PostgreSQL and no SQL construction accepts unvalidated identifier text.