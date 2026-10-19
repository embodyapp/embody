# M12 local evidence (phase 1, no cloud spend)

Task / acceptance cases: M12.a–d, local layer. The live layer (`test:mvp:cloud` suite `m12`) has not run yet: it waits for owner budget approval.
Owner / reviewer: claude / independent review pending.
Date: 2026-10-19. Branch `feat/mvp-m12-deployment-controller`, draft [#53](https://github.com/embodyapp/embody/pull/53), stacked on #50.
Commit: `ab6d935` (clean tree; `dirty: false` in the evidence JSON). Lockfile SHA-256 `a49024b0d7e69ea3ff966010cf4a7c8d51a6fb50d1bf148691de8ffc8ddcfaf4`. Platform schema source SHA-256 `ead5261b0c3d869d3454049db1b7982cbd583af96e7eebf4e13c91cd185db458`.
Runtime: Node 24.21.0, pnpm 11.25.0, PostgreSQL 16 (`postgres:16-alpine`, image `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`), Docker fixture Compose project `embody-m12-verification` on a loopback port. No shared `embody-local-*` services were touched.
Environment: local only, with no provider calls. The queue, build provider and candidates are in-memory or PostgreSQL-table fakes.

## Commands (variable names only)

```sh
set -a; . <fixture env with EMBODY_POSTGRES_* and EMBODY_PLATFORM_* names>; set +a
pnpm verify
pnpm test:verification
pnpm test:postgres
pnpm test:gateway-store
pnpm test:mvp
pnpm test:m12
```

## Results

| Gate | Result |
|---|---|
| `pnpm verify` | passed (lint, license, typecheck, tests, build, API report, format) on `afb4441` + docs; the code was unchanged until `ab6d935` apart from the live suite files, which lint, format and `test:verification` cover |
| `pnpm test:verification` | 101 passed (M12 adds 7 mocked live-suite cases and the `test-m12.mjs` missing-configuration negative) |
| `pnpm test:mvp` | **598 passed, 0 skipped**: postgres 16, gateway-store 66 (+10 deployment-store conformance on PostgreSQL), cloud-contracts 106, auth 6, host 113, MCP 18, gateway 257, CLI 16 |
| `pnpm test:m12` | **125 passed, 0 skipped**: controller suite (memory), real-PostgreSQL controller file (12), M11 admission + hardening (52), shared queue/ingress (4), M20 durable host |

## Acceptance mapping (local)

- **M12.a**: SIGKILL crash matrix on real PostgreSQL with a table-backed queue, build provider and candidates that survive the kill. The kill points are after enqueue and before commit; after commit and before the response; a lost task; after the claim; after the build was created and before its ID was recorded (adopted by tag); after the candidate was created and before its receipt (adopted); after a stage committed and before the ACK; after promotion and before the ACK. Each case ends with one active deployment, one build, one candidate, generation + 1 and no pending tasks ([table](../DEPLOYMENTS.md#verification)).
- **M12.b**: covered by
  - nine concurrent deliveries across three pools, and five concurrent deliveries in memory;
  - two deployments of one app racing to promote (one active, one `STALE_GENERATION`);
  - cancellation racing promotion on separate connections (never both);
  - cancellation during a build (provider build cancelled, artifact `CANCELLED`);
  - cancellation racing a running check (only the owned candidate removed);
  - cross-workspace and cross-app task bodies (`missing`) and lookups.
- **M12.c**: the gateway is closed after the `202` and the worker alone reaches `active`. A queue outage fails the submission and persists nothing, and mid-flight it recovers on redelivery. A worker lost after its claim is reclaimed by the lease wake at lease + 1 s. A stage that never finishes fails visibly within its documented bound (`WORKER_LOST`). Lost tasks are recovered after a task or request.
- **M12.d**: worker ingress rejects all of the following:
  - no token;
  - a gateway token;
  - Basic auth;
  - a foreign signer;
  - the wrong audience;
  - the wrong email;
  - `email_verified` false;
  - an expired token;
  - a token with a 3 h lifetime;
  - a token over 4 KiB;
  - Cloud Tasks headers alone.

  Authentication runs before body parsing. Malformed, URL- or header-carrying, path-traversal and SQL-shaped bodies are `400`, and no claim or build happens.

Mutation checks were run by hand and are not committed. Each mutation was reverted after its run:

| Mutation | Result |
|---|---|
| Removing the epoch fence | fails |
| Removing the promotion CAS | fails 2 |
| Removing the lease | fails 4 |
| Removing build adoption by tag | fails the crash case |
| Ignoring uncommitted transactions | fails the early-task case |
| Dropping the newest early task's re-arm | fails the re-arm case |

## Known gaps

- Real Cloud Tasks delivery, OIDC tokens, Cloud Run worker replacement, Cloud SQL and Cloud Build in the controller loop are not covered yet. They are the live suite's cases, still to run.
- Real provisioning and checks are M13's.

Cleanup: the local fixture is disposable (`docker compose --project-name embody-m12-verification … down --volumes`). No cloud resources exist.
