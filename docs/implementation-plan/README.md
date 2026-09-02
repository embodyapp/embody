# Embody implementation plan

This directory is the execution source of truth for agents implementing the specifications in [`../specs/`](../specs/). Read this file, [`STATUS.md`](./STATUS.md), and [`00-architecture-and-decisions.md`](./00-architecture-and-decisions.md) before taking work.

## Delivery order

| Phase | Plan | Depends on |
|---|---|---|
| 0 | [Architecture and decisions](./00-architecture-and-decisions.md) | — |
| 1 | [Workspace and public contracts](./01-workspace-and-contracts.md) | 0 |
| 2 | [Storage and transactions](./02-storage-and-transactions.md) | 1 |
| 3 | [Kernel and plugin lifecycle](./03-kernel-and-plugin-lifecycle.md) | 1–2 |
| 4 | [Dynamic entities and auto-CRUD](./04-dynamic-entities.md) | 2–3 |
| 5 | [Host, execution, and auth](./05-host-execution-and-auth.md) | 3–4 |
| 6 | [Outbox, events, and progress](./06-outbox-events-and-progress.md) | 2–5 |
| 7 | [Gateway registry, security, and routing](./07-gateway.md) | 1, 5–6 |
| 8 | [MCP and CLI surfaces](./08-mcp-and-cli.md) | 4–7 |
| 9 | [Developer tooling and testing package](./09-developer-tooling.md) | 3–8 |
| 10 | [Reference applications and end-to-end proof](./10-reference-apps.md) | 4–9 |
| 11 | [Durable workflows](./11-durable-workflows.md) | 3, 6, 8–10, D-02 |
| 12 | [Hardening and release](./12-hardening-and-release.md) | 1–11 |

Also read [the cross-cutting test strategy](./TEST-STRATEGY.md) and [specification traceability matrix](./SPEC-TRACEABILITY.md). Each phase contains its own executable success criteria; a phase is not complete merely because code exists.

## Intended repository shape

```text
apps/
  gateway/                 deployable central gateway
examples/
  kanban/                  reference remote app
  email/                   reference remote app
packages/
  core/                     contracts, plugin definition, kernel
  storage/                  PostgreSQL and SQLite adapters
  host/                     remote app HTTP/SSE server and gateway client
  auth/                     built-in providers and verifiers
  gateway/                  reusable gateway engine
  mcp/                      MCP schema/tool adapters
  cli/                      embody binary and dev command
  testing/                  in-memory/SQLite harness
  create-embody-app/        scaffolder
```

Keep dependency direction inward: examples/apps → host/gateway/cli/testing → core/storage/auth/mcp. `core` must not import HTTP frameworks, database drivers, or reference-app domain code.

## Agent workflow

1. Claim one unblocked work item in `STATUS.md`; add your agent/session identifier and change its state to `IN_PROGRESS`.
2. Read the linked specification and all prior phase plans. Do not silently choose an answer to an item marked `OPEN` or `BLOCKED`.
3. Implement the smallest item, including tests named in its phase plan.
4. Run the item-level tests, then all affected package tests/type checks/lint. Record commands and results in `STATUS.md`.
5. Mark an item `DONE` only when its success criteria are met. Add follow-up work explicitly; do not hide it in comments.
6. Keep public API changes and wire-protocol changes atomic with their contract tests and documentation.

### Status values

- `NOT_STARTED`: available only when dependencies are done.
- `BLOCKED`: dependency or decision is unresolved; explain why in Notes.
- `IN_PROGRESS`: exactly one owner is actively working it.
- `IN_REVIEW`: implementation complete, checks recorded, review pending.
- `DONE`: success criteria and required checks passed.

## Global definition of done

For every phase:

- Public behavior is covered by tests at the lowest useful level and by at least one boundary/integration test.
- Tenant isolation, authentication failure, invalid input, and dependency failure paths are tested where relevant.
- No test relies on arbitrary sleeps; fake clocks, polling helpers, or explicit worker ticks are used.
- PostgreSQL-specific behavior is tested against real PostgreSQL, not mocked SQL. SQLite parity tests use a real temporary database.
- Public exports and HTTP/MCP payloads have contract tests.
- Tests, type checking, linting, and package builds pass from the workspace root.
- User-facing behavior and any intentional deviation from the specs are documented.
- `STATUS.md` includes evidence (commands and concise results).

## Scope rule

The specifications are authoritative for product behavior. The architecture decision document supplies implementation detail where the specs are silent. Items explicitly deferred by an approved ADR (for example provider-specific Clerk integration) must not be presented as implemented. ADR 0003 includes durable workflows in MVP, so phase 11 must pass before phase 12 and release.