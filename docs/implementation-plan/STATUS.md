# Implementation status

Last updated: 2026-09-02 by `pi`

This file is intentionally simple so small agents can coordinate without a project-management service. Update one row when claiming and completing work. Preserve item IDs because plans and commits may reference them.

## Decision gates

| ID | Decision | State | Owner | Notes/evidence |
|---|---|---|---|---|
| D-01 | Approve baseline stack and package boundaries | DONE | pi | ADR 0001; implemented by P1-01 |
| D-02 | Resolve durable workflow semantics/scope | DONE | pi | ADR 0003: included in MVP as Phase 11; durable DAG, version-pinned instances, at-least-once steps, retries, cancellation/compensation, per-step auth |
| D-03 | Approve cross-app event delivery protocol | DONE | pi | ADR 0004: direct delivery baseline through a transport seam; durable gateway relay is optional P7-04 |
| D-04 | Set supported Node/PostgreSQL/SQLite versions | DONE | pi | ADR 0002: Node 22/24, PostgreSQL 16+, SQLite 3.45+ JSON1 |

## Work items

| ID | Work item | State | Owner | Depends on | Evidence/notes |
|---|---|---|---|---|---|
| P1-01 | Bootstrap workspace and CI | DONE | pi | D-01,D-04 | pnpm workspace, strict TS/ESM, CI matrix, package-boundary self-test, API report |
| P1-02 | Core contracts, errors, and manifest compiler | DONE | pi | P1-01 | 36 core tests; built public consumer fixture; `packages/core/etc/core.api.md` | |
| P2-01 | Storage port and schema ensure | DONE | pi | P1-02 | `@embody/storage` ports, UTC normalization, and v1 SQLite/PostgreSQL infrastructure migrations; `pnpm verify` passed |
| P2-02 | SQLite adapter and conformance suite | DONE | pi | P2-01 | Real JSON1 adapter, tenant-safe CRUD, atomic outbox/inbox, claims, and SQLite conformance tests; `pnpm test` passed |
| P2-03 | PostgreSQL adapter, RLS, and conformance | DONE | pi | P2-01 | PostgreSQL 16 Docker integration passed as non-owner runtime role: JSONB, RLS raw-read isolation, `SET LOCAL` cleanup, and concurrent `FOR UPDATE SKIP LOCKED` claims |
| P3-01 | Plugin graph and service registry | DONE | pi | P1-02 | Deterministic topological sorting, dependency/service access validation, and graph tests; `pnpm verify` passed |
| P3-02 | Kernel boot state machine and hook/action registries | DONE | pi | P2-01,P3-01 | Seven-phase single-flight kernel, lifecycle cleanup, registries, hook traces/vetoes, immutable manifest, and real SQLite/PostgreSQL adapter boot tests; `pnpm verify` passed |
| P4-01 | Entity compiler and stores | DONE | pi | P2-02,P2-03,P3-02 | Compiled Zod object declarations at boot; tenant/transaction-bound typed stores validate data, nested containment filters, sort paths, pagination, and merged updates. SQLite/PostgreSQL integrations passed. |
| P4-02 | Auto-CRUD lifecycle and manifests | NOT_STARTED | — | P4-01 | |
| P5-01 | Execution engine and authorization | NOT_STARTED | — | P4-02 | |
| P5-02 | Remote HTTP host and verifier plugins | NOT_STARTED | — | P5-01 | |
| P5-03 | Registration/heartbeat client | NOT_STARTED | — | P5-02 | |
| P6-01 | Transactional outbox publishing | NOT_STARTED | — | P2-03,P5-01 | |
| P6-02 | Worker retries, concurrency, and shutdown | NOT_STARTED | — | P6-01 | |
| P6-03 | Local and direct cross-app event delivery | NOT_STARTED | — | D-03,P6-02 | Direct transport, destination delivery state, receiver inbox, and conformance seam |
| P6-04 | SSE/progress transport | NOT_STARTED | — | P5-02 | |
| P7-01 | Gateway registry and health watcher | NOT_STARTED | — | P5-03 | |
| P7-02 | Gateway auth, token exchange, RBAC, audit, limits | NOT_STARTED | — | P5-02,P7-01 | |
| P7-03 | Dispatch proxy | NOT_STARTED | — | P7-02 | |
| P7-04 | Optional durable gateway event relay | NOT_STARTED | — | P6-03,P7-03 | Optional adapter; not on the MVP release critical path |
| P8-01 | MCP tool catalog and transports | NOT_STARTED | — | P7-03 | |
| P8-02 | Hierarchical CLI and discovery | NOT_STARTED | — | P7-03 | |
| P8-03 | End-to-end progress forwarding | NOT_STARTED | — | P6-04,P8-01,P8-02 | |
| P9-01 | Testing harness | NOT_STARTED | — | P5-01,P6-02 | |
| P9-02 | `embody dev` and inspector | NOT_STARTED | — | P8-01,P9-01 | |
| P9-03 | App scaffolder | NOT_STARTED | — | P9-01,P9-02 | |
| P10-01 | Kanban reference app | NOT_STARTED | — | P9-03 | |
| P10-02 | Email reference app | NOT_STARTED | — | P10-01 | |
| P10-03 | Distributed reference E2E suite | NOT_STARTED | — | P10-02,P7-03,P8-03 | |
| P11-01 | Approve durable workflow contract | NOT_STARTED | — | D-02,P10-03 | Baseline semantics approved by ADR 0003; finalize executable contract in P11-01 |
| P11-02 | Workflow persistence and engine | NOT_STARTED | — | P11-01 | |
| P11-03 | Workflow surfaces and tooling | NOT_STARTED | — | P11-02 | |
| P12-01 | Security, resilience, and performance hardening | NOT_STARTED | — | P10-03,P11-03 | |
| P12-02 | Packaging, compatibility, and release docs | NOT_STARTED | — | P12-01 | |

## Current verification snapshot

| Check | Command | Last result | Date/owner |
|---|---|---|---|
| Install | `pnpm install --frozen-lockfile` | Passed | 2026-09-01/pi |
| Lint | `pnpm lint` | Passed | 2026-09-01/pi (P2) |
| Type check | `pnpm typecheck` | Passed | 2026-09-01/pi (P2) |
| Unit/integration | `source .env && pnpm test` | 54 passed against SQLite and local PostgreSQL 16 | 2026-09-01/pi (P2/P3) |
| PostgreSQL integration | `source .env && pnpm test:postgres` | Passed: 2 PostgreSQL 16 runtime-role/RLS/concurrency tests | 2026-09-01/pi (P2/P3) |
| End-to-end | `pnpm test:e2e` | Passed; no suites until later phases | 2026-09-01/pi |
| Build | `pnpm build` | Passed for all packages | 2026-09-01/pi (P2) |

## Activity log

Append concise entries; do not rewrite history.

- YYYY-MM-DD `<agent>`: initialized planning tracker; no implementation exists yet.
- 2026-09-01 `pi`: completed phase 1 workspace/contracts with TDD; `pnpm verify`, frozen install, PostgreSQL placeholder, and E2E placeholder commands pass.
- 2026-09-01 `pi`: completed P2-01 storage ports and versioned schema migration contract; `pnpm verify` passed.
- 2026-09-01 `pi`: completed P2-02 SQLite adapter and conformance coverage. Implemented P2-03 PostgreSQL adapter/RLS and integration test, pending real PostgreSQL 16+ runtime-role verification because Docker is unavailable locally; lint, typecheck, unit tests, build, and formatting pass.
- 2026-09-01 `pi`: completed P3-01 graph/service registry. Implemented P3-02 kernel lifecycle, registries, hooks, traces, and tests; `pnpm verify` passed. Real SQLite/PostgreSQL kernel boot verification remains pending P2-03 PostgreSQL runtime availability.
- 2026-09-01 `pi`: completed P2-03 and P3-02 review gates using local PostgreSQL 16 Docker with a non-owner runtime role. RLS raw reads, `SET LOCAL` cleanup, concurrent claims, and real-adapter kernel boot tests passed.
- 2026-09-02 `pi`: approved D-02 in ADR 0003. Durable workflows are included in MVP as the final feature phase before hardening/release; P11 is no longer blocked by a product decision.
- 2026-09-02 `pi`: approved D-03 in ADR 0004. Direct app-to-app event delivery is the MVP baseline behind a transport seam; durable gateway relay is optional P7-04.
- 2026-09-02 `pi`: completed P4-01 entity compiler and contextual stores. `pnpm verify` plus real PostgreSQL contextual-store integration passed; full lifecycle verification is pending P4-02.