# Implementation status

Last updated: YYYY-MM-DD by `<agent>`

This file is intentionally simple so small agents can coordinate without a project-management service. Update one row when claiming and completing work. Preserve item IDs because plans and commits may reference them.

## Decision gates

| ID | Decision | State | Owner | Notes/evidence |
|---|---|---|---|---|
| D-01 | Approve baseline stack and package boundaries | NOT_STARTED | — | See phase 0 |
| D-02 | Resolve durable workflow semantics/scope | NOT_STARTED | — | See phase 0 |
| D-03 | Approve cross-app event relay protocol | NOT_STARTED | — | See phases 0 and 6 |
| D-04 | Set supported Node/PostgreSQL/SQLite versions | NOT_STARTED | — | See phases 0 and 11 |

## Work items

| ID | Work item | State | Owner | Depends on | Evidence/notes |
|---|---|---|---|---|---|
| P1-01 | Bootstrap workspace and CI | NOT_STARTED | — | D-01,D-04 | |
| P1-02 | Core contracts, errors, and manifest compiler | NOT_STARTED | — | P1-01 | |
| P2-01 | Storage port and schema ensure | NOT_STARTED | — | P1-02 | |
| P2-02 | SQLite adapter and conformance suite | NOT_STARTED | — | P2-01 | |
| P2-03 | PostgreSQL adapter, RLS, and conformance | NOT_STARTED | — | P2-01 | |
| P3-01 | Plugin graph and service registry | NOT_STARTED | — | P1-02 | |
| P3-02 | Kernel boot state machine and hook/action registries | NOT_STARTED | — | P2-01,P3-01 | |
| P4-01 | Entity compiler and stores | NOT_STARTED | — | P2-02,P2-03,P3-02 | |
| P4-02 | Auto-CRUD lifecycle and manifests | NOT_STARTED | — | P4-01 | |
| P5-01 | Execution engine and authorization | NOT_STARTED | — | P4-02 | |
| P5-02 | Remote HTTP host and verifier plugins | NOT_STARTED | — | P5-01 | |
| P5-03 | Registration/heartbeat client | NOT_STARTED | — | P5-02 | |
| P6-01 | Transactional outbox publishing | NOT_STARTED | — | P2-03,P5-01 | |
| P6-02 | Worker retries, concurrency, and shutdown | NOT_STARTED | — | P6-01 | |
| P6-03 | Local and cross-app event delivery | BLOCKED | — | D-03,P6-02 | |
| P6-04 | SSE/progress transport | NOT_STARTED | — | P5-02 | |
| P7-01 | Gateway registry and health watcher | NOT_STARTED | — | P5-03 | |
| P7-02 | Gateway auth, token exchange, RBAC, audit, limits | NOT_STARTED | — | P5-02,P7-01 | |
| P7-03 | Dispatch proxy and event relay | NOT_STARTED | — | P6-03,P7-02 | |
| P8-01 | MCP tool catalog and transports | NOT_STARTED | — | P7-03 | |
| P8-02 | Hierarchical CLI and discovery | NOT_STARTED | — | P7-03 | |
| P8-03 | End-to-end progress forwarding | NOT_STARTED | — | P6-04,P8-01,P8-02 | |
| P9-01 | Testing harness | NOT_STARTED | — | P5-01,P6-02 | |
| P9-02 | `embody dev` and inspector | NOT_STARTED | — | P8-01,P9-01 | |
| P9-03 | App scaffolder | NOT_STARTED | — | P9-01,P9-02 | |
| P10-01 | Kanban reference app | NOT_STARTED | — | P9-03 | |
| P10-02 | Email reference app | NOT_STARTED | — | P10-01 | |
| P10-03 | Distributed reference E2E suite | NOT_STARTED | — | P10-02,P7-03,P8-03 | |
| P11-01 | Approve durable workflow contract | BLOCKED | — | D-02,P10-03 | May be explicitly deferred from MVP |
| P11-02 | Workflow persistence and engine | BLOCKED | — | P11-01 | |
| P11-03 | Workflow surfaces and tooling | BLOCKED | — | P11-02 | |
| P12-01 | Security, resilience, and performance hardening | NOT_STARTED | — | P10-03,P11-03 or approved deferral | |
| P12-02 | Packaging, compatibility, and release docs | NOT_STARTED | — | P12-01 | |

## Current verification snapshot

| Check | Command | Last result | Date/owner |
|---|---|---|---|
| Install | `pnpm install --frozen-lockfile` | Not run | — |
| Lint | `pnpm lint` | Not run | — |
| Type check | `pnpm typecheck` | Not run | — |
| Unit/integration | `pnpm test` | Not run | — |
| PostgreSQL integration | `pnpm test:postgres` | Not run | — |
| End-to-end | `pnpm test:e2e` | Not run | — |
| Build | `pnpm build` | Not run | — |

## Activity log

Append concise entries; do not rewrite history.

- YYYY-MM-DD `<agent>`: initialized planning tracker; no implementation exists yet.