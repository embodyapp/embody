# Implementation status

Last updated: 2026-09-06 by `pi`

This file is intentionally simple so small agents can coordinate without a project-management service. Update one row when claiming and completing work. Preserve item IDs because plans and commits may reference them.

## Decision gates

| ID | Decision | State | Owner | Notes/evidence |
|---|---|---|---|---|
| D-01 | Approve baseline stack and package boundaries | DONE | pi | ADR 0001; implemented by P1-01 |
| D-02 | Resolve durable workflow semantics/scope | DONE | pi | ADR 0003: included in MVP as Phase 11; durable DAG, version-pinned instances, at-least-once steps, retries, cancellation/compensation, per-step auth |
| D-03 | Approve cross-app event delivery protocol | DONE | pi | ADR 0004: direct delivery baseline through a transport seam; durable gateway relay is optional P7-04 |
| D-04 | Set supported Node/PostgreSQL/SQLite versions | DONE | pi | ADR 0002: Node 22/24, PostgreSQL 16+, SQLite 3.45+ JSON1 |
| D-05 | Select first-party licensing model | DONE | pi | Source-available dual licensing inspired by n8n: Sustainable Use community terms plus paid commercial terms and separate trademark policy; not OSI open source |

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
| P4-02 | Auto-CRUD lifecycle and manifests | DONE | pi | P4-01 | Generated create/get/list/update/delete actions execute in org-bound transactions, run lifecycle hooks, and atomically enqueue standard events. SQLite and PostgreSQL CRUD integrations passed; `pnpm verify` passed. |
| P4-03 | Transactional bulk entity operations | DONE | pi | P4-02 | Typed ordered getMany/updateMany; complete prevalidation, duplicate/empty update rejection, lifecycle/event parity, SQLite rollback via Kanban and real PostgreSQL rollback coverage. |
| P5-01 | Execution engine and authorization | DONE | pi | P4-02 | Transport-neutral execution options, scope authorization, request context, cancellation/progress/audit; `pnpm lint && pnpm api-report`, `pnpm test`, `pnpm typecheck`, and `pnpm build` passed. |
| P5-02 | Remote HTTP host and verifier plugins | DONE | pi | P5-01 | Fastify execute/health host, capacity/body/timeout controls, gateway-JWT verifier and production local-dev rejection; host/auth injection and JWT-negative tests pass. |
| P5-03 | Registration/heartbeat client | DONE | pi | P5-02 | Deterministic SHA-256 manifest generation, authenticated registration, 30-second heartbeat, 404 re-registration, bounded jittered retry, injectable timers, and stop cleanup covered by host tests. |
| P6-01 | Transactional outbox publishing | DONE | pi | P2-03,P5-01 | Transactional publishing validates names/JSON/256 KiB and persists injected IDs, timestamps, producer, and correlation metadata; rollback integration passes. |
| P6-02 | Worker retries, concurrency, and shutdown | DONE | pi | P6-01 | Deterministic workers, bounded concurrency, configurable attempts (default 1), exact exponential retry, dead letters, shutdown, and lease recovery; two PostgreSQL workers claim 1,000 rows without duplicates. |
| P6-03 | Local and direct cross-app event delivery | DONE | pi | D-03,P6-02 | Migration-backed destination snapshots, independent delivery worker, HMAC/audience/org receiver checks, inbox idempotency, no-subscriber audit, and SQLite restart/offline recovery tests pass. |
| P6-04 | SSE/progress transport | DONE | pi | P5-02 | Authenticated `/execute/stream` emits ordered JSON progress and one terminal result/error, validates monotonic progress, bounds backpressure buffering, cancels disconnects, and closes keepalives. |
| P7-01 | Gateway registry and health watcher | DONE | pi | P5-03 | Copy-on-write registry, credentialed generations, TTL health and endpoint policy. |
| P7-02 | Gateway auth, token exchange, RBAC, audit, limits | DONE | pi | P5-02,P7-01 | API key/OIDC chain, short-lived audience JWT, scopes, memory limits/audit. |
| P7-03 | Dispatch proxy | DONE | pi | P7-02 | Catalog-gated, authenticated canonical `/execute` dispatch with cancellation. |
| P7-04 | Optional durable gateway event relay | DONE | pi | P6-03,P7-03 | Opt-in registry-backed EventTransport for existing durable workers. |
| P8-01 | MCP tool catalog and transports | DONE | pi | P7-03 | Official SDK Streamable HTTP sessions, global/scoped catalogs, identity pinning, mapping/collision checks, calls, cancellation, and safe errors |
| P8-02 | Hierarchical CLI and discovery | DONE | pi | P7-03 | Spawned binary test covers live discovery, schema coercion, execution, progress separation, and JSON output; profiles, protected config, ETag cache, help, CRUD/action hierarchy, and stable exits implemented |
| P8-03 | End-to-end progress forwarding | DONE | pi | P6-04,P8-01,P8-02 | Bounded remote SSE parsing/proxying, awaited MCP progress notifications, CLI stderr progress, terminal-result isolation, and cancellation propagation |
| P9-01 | Testing harness | DONE | pi | P5-01,P6-02 | Isolated SQLite real-kernel harness with principal views, explicit service overrides, deterministic outbox tick, progress/audit/outbox inspection, cleanup, and benchmark methodology; 100-sample warm median 5.72 ms/p95 7.32 ms (Node 24 x86_64); `pnpm verify` passed. |
| P9-02 | `embody dev` and inspector | DONE | pi | P8-01,P9-01 | Loopback SQLite dev host, config reload/recovery, and development-only JSON manifest/execute/redacted-outbox endpoints; no framework UI by approved scope change. `pnpm verify` passed. |
| P9-03 | App scaffolder | DONE | pi | P9-01,P9-02 | Safe `create-embody-app` binary/API generates public-import starter layout, tests, Docker healthcheck, env/git files, and deterministic `--no-install`; traversal/nonempty-directory tests pass. |
| P9-04 | Typed testing harness clients | DONE | pi | P9-01,P4-02 | Schema-inferred action/entity clients, dynamic escape hatch, cancellation, immutable agent/human views, and structured veto/progress/event queries; compile-time and runtime parity tests pass. |
| P10-01 | Kanban reference app | DONE | pi | P9-03 | Public-package Kanban workspace app: card schema/index metadata, atomic bulkMove, agent PR guardrail, review event, conventional SQLite/PostgreSQL app host, dev seed, README, and domain/host contract tests. Typed plugin builder and conventional `defineApp`/`createAppHost` runtime included; workspace lint, typecheck, tests, build, API report, and format checks passed. |
| P10-02 | Email reference app | DONE | pi | P10-01 | Cancellable validated sendBatch with exact progress and >500 guardrail; explicit Mailer abstraction, recording/idempotent adapter, Kanban event subscription, failure/dead-letter coverage, host config and docs. |
| P10-03 | Distributed reference E2E suite | DONE | pi | P10-02,P7-03,P8-03 | Compose topology and release-blocking CLI/MCP/HTTP journey implemented with generated secrets, PostgreSQL isolation, three crash points, TTL recovery, and tenant/scope/audience checks. Production-mode distributed PostgreSQL smoke, affected tests, typechecks, and builds passed. |
| P11-01 | Approve durable workflow contract | DONE | pi | D-02,P10-03 | Versioned DAG contract/compiler, typed definition helper, validation, deterministic manifest/control actions |
| P11-02 | Workflow persistence and engine | IN_PROGRESS | pi | P11-01 | SQLite/PostgreSQL v4 schema, idempotent start, leases, retries, cancellation/compensation, redaction limits, worker and RLS/concurrency test added; full crash-point/active-cancellation matrix and the cross-tenant claim-role design remain release gates |
| P11-03 | Workflow surfaces and tooling | IN_PROGRESS | pi | P11-02 | Standard generated actions flow through gateway/CLI/MCP; deterministic harness ticks, redacted inspector timeline, guide/scaffolder note; official CLI/MCP workflow journey remains gated on P11-02 crash matrix |
| P12-01 | Security, resilience, and performance hardening | IN_PROGRESS | pi | P10-03,P11-03 | Threat model/runbooks, production secret/HTTPS checks, security headers, and local audit/SBOM tooling added; performance CI/budgets explicitly deferred by owner, while fuzz, soak, outage/restore drills still require later operational evidence |
| P12-02 | Packaging, compatibility, and release docs | IN_PROGRESS | pi | P12-01 | Typed tarball inspection passes; package readmes/changelogs, compatibility/upgrade policy, non-root E2E image and release checklist added; signed images, clean tarball E2E/quickstart and Phase 13 terms remain gated |
| P13-01 | Ownership and legal foundation | IN_PROGRESS | pi | P12-02,D-05 | Nimrod Feldman identified as personal rightsholder; chain of title, exact identity details, CLA, trademark, and counsel review remain publication blockers. See `docs/commercial/`. |
| P13-02 | Community and commercial terms | NOT_STARTED | — | P13-01 | Business intent recorded without generating legal terms; counsel-approved license, commercial agreement, trademark policy, definitions, examples, and FAQ remain required. |
| P13-03 | Repository, artifacts, and entitlements | NOT_STARTED | — | P13-02 | Preparatory safeguards added: first-party packages and generated apps are explicitly `UNLICENSED`; generated apps inherit no license. Exact approved terms and entitlements remain pending. |
| P13-04 | Third-party and distribution compliance | NOT_STARTED | — | P13-03 | Pre-license CI metadata/claims gate added; artifact SBOM, attribution audit, compatibility policy, and legal review remain required. |
| P13-05 | Commercial launch readiness | NOT_STARTED | — | P13-04 | Hosting and official support reserved; independent customer-specific consulting allowed. ICP, pricing, operations, contracts, and rehearsal remain pending. |

## Current verification snapshot

| Check | Command | Last result | Date/owner |
|---|---|---|---|
| Install | `pnpm install --frozen-lockfile --offline` | Passed | 2026-09-06/pi |
| Lint | `pnpm lint` | Passed | 2026-09-06/pi (P4/P9/P10) |
| Type check | `pnpm typecheck` | Passed | 2026-09-06/pi (P4/P9/P10) |
| Unit/integration | `pnpm test` | Passed: 105 tests; 7 PostgreSQL tests skipped unless separately enabled | 2026-09-06/pi (P10-03) |
| PostgreSQL integration | `set -a && source .env && set +a && pnpm --filter @embody/storage test:postgres` | Passed: 6 PostgreSQL 16 tests, including bulk lifecycle/event rollback and two-worker claims | 2026-09-06/pi (P4-03) |
| End-to-end | `pnpm test:e2e` | Compose suite implemented; local run blocked pulling Node base image, while equivalent production-mode PostgreSQL process smoke passed | 2026-09-06/pi (P10-03) |
| Build | `pnpm build` | Passed for all packages, apps, and examples | 2026-09-06/pi (P10-03) |

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
- 2026-09-02 `pi`: completed P4-02 generated CRUD lifecycle. Five generated actions run via org-bound kernel transactions with hooks and atomic outbox events; SQLite/PostgreSQL integrations and `pnpm verify` passed.
- 2026-09-02 `pi`: completed P5-01 execution pipeline: explicit verified-principal options, segment-aware scopes, request/cancellation/progress context, and redacted audit metadata. `pnpm lint && pnpm api-report`, `pnpm test`, `pnpm typecheck`, and `pnpm build` passed.
- 2026-09-02 `pi`: completed P5-02/P5-03: gateway JWT/local development verifiers, Fastify execute/health host, and registration/heartbeat client with deterministic manifest hash, bounded retry, re-registration, and timer cleanup. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm api-report` passed.
- 2026-09-03 `pi`: completed P6-01 through P6-04: transactional event validation/metadata, durable destination snapshots, independent direct-delivery worker with configurable attempts (default one), authenticated/idempotent receiver, and bounded SSE streaming. Workspace checks and real PostgreSQL 16 concurrency tests passed.
- 2026-09-03 `pi`: completed P7-01 through P7-04: copy-on-write gateway registry and liveness catalog, API key/OIDC authentication chain, scoped audited rate-limited dispatch, short-lived app-audience JWT exchange, and opt-in registry-backed durable event transport.
- 2026-09-03 `pi`: completed P8-01 through P8-03: official SDK stateful Streamable HTTP MCP with dynamic authorized global/scoped catalogs, hierarchical spawned CLI with profiles/config/ETag discovery and schema coercion, and ordered cancellable progress forwarding to MCP notifications and CLI stderr. `pnpm verify` passed with 78 tests plus 6 separately enabled PostgreSQL tests.
- 2026-09-03 `pi`: completed P9-01 `@embody/testing`: isolated real SQLite/kernel harness with scoped principals, explicit service overrides, deterministic outbox ticks, captured progress/audit inspection, cleanup, and benchmark methodology (100-sample median 5.72 ms/p95 7.32 ms). `pnpm verify` passed.
- 2026-09-03 `pi`: completed P9-02 `embody dev` with loopback SQLite host, reload/recovery, and development-only JSON inspector endpoints. The spec was revised to deliberately omit a framework web UI; `pnpm verify` passed.
- 2026-09-03 `pi`: completed P9-03 `create-embody-app`: safe deterministic scaffold API/binary with starter config/plugin/harness test, Docker healthcheck, and no-install mode. `pnpm verify` passed.
- 2026-09-03 `pi`: completed P10-01 Kanban reference app with public Embody package imports, atomic bulk move, agent completion guardrail, review event, validated host configuration, development seed helper, deployment README, and seven SQLite harness/manifest tests. Package tests/typecheck plus workspace lint and format checks passed.
- 2026-09-03 `pi`: improved app DX: added typed two-stage plugin definitions, conventional `defineApp`/`createAppHost` runtime assembly, a working Kanban `embody dev` configuration, corrected CLI examples/start scripts, and updated scaffolder output. Added P4-03 bulk store operations and P9-04 typed harness clients as explicit follow-ups. Workspace lint, typecheck, tests, build, API report, and format checks passed.
- 2026-09-06 `pi`: added Phase 13 as the final public-release gate and selected Apache-2.0 for all first-party repository material. Planned license/notice metadata, generated-app ownership boundaries, shipped-artifact SBOM/attribution auditing, and CI compliance gates.
- 2026-09-06 `pi`: superseded the Apache-2.0 decision after monetization review. Phase 13 now specifies an n8n-inspired source-available dual-license model, commercial-use boundaries, chain-of-title/CLA and trademark work, artifact compliance, entitlements, pricing validation, contracting, billing, privacy, support, and commercial launch gates.
- 2026-09-06 `pi`: completed P4-03, P9-04, and P10-02. Added transactional ordered bulk stores with SQLite/PostgreSQL rollback proof, typed harness clients and structured actor/observation helpers, and the Email reference app with cancellable guarded batches, progress, idempotent event mail, explicit adapter failure, and dead-letter tests. Fixed PostgreSQL timestamp precision preservation uncovered by optimistic bulk updates. `pnpm verify` and six real PostgreSQL tests passed.
- 2026-09-06 `pi`: completed P10-03: deployable gateway, built-artifact Compose topology, conventional host event workers, durable test mail adapter, generated test credentials/ports, and a nine-step CLI/MCP/HTTP journey with pre-commit publisher termination, post-fan-out publisher restart, post-side-effect receiver crash, TTL recovery, and isolation checks. Fixed gateway forwarding to include the required protocol version. A production-mode multi-process PostgreSQL smoke and affected tests/typechecks/builds passed.
- 2026-09-06 `pi`: implemented the Phase 11 workflow contract, v4 SQLite/PostgreSQL persistence, worker/control surfaces, deterministic harness and inspector support. Added Phase 12 production hardening, SBOM/tarball automation, compatibility/security/runbook documentation, and evidence checklist; retained IN_PROGRESS states for gates requiring crash/fuzz/soak/restore/performance/release evidence.
- 2026-09-06 `pi`: began non-binding Phase 13 preparation. Recorded Nimrod Feldman as personal rightsholder and reserved managed Embody hosting and official support while allowing customer-specific consulting. Removed false MIT/open-source claims, marked first-party and generated packages `UNLICENSED` pending counsel-approved terms, added generated-app ownership coverage, and added a CI readiness gate plus legal/commercial evidence checklist.
