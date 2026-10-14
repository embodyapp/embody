# M08 local implementation evidence — IN_REVIEW

Candidate: uncommitted working tree based on `c4e13fb`, branch
`feat/mvp-m07-safe-dispatch`. No frozen candidate SHA, PR, remote CI or independent
acceptance is claimed. M08 remains **IN_REVIEW**, not DONE. Contract:
[request-only runtime](../RUNTIME.md).

## Implementation

- Hosted factory selects request-only kernel/HTTP hosting, with no registration,
  heartbeat or workflow/outbox/delivery workers. Tick/drain methods fail closed.
- Shared preflight rejects background declarations and startup callbacks before
  adapter allocation, with the same check at kernel boot. Reference mode remains.
- Runtime PostgreSQL uses read-only exact migration-ledger verification, five
  connections, 30-second statement/idle-transaction timeouts and one-second idle
  connection expiry. Runtime adapter/auth overrides and local database settings fail.
- Generated CRUD notifications have explicit zero retention and no delivery promise;
  synchronous hooks/entity mutations still commit/rollback together. Custom publishing
  fails. Legacy outbox settlement is a documented prerequisite, not automatic deletion.
- Host action/auth deadlines share a 60-second host budget; cancellation includes
  disconnect after body receipt. Non-cooperative timed-out handlers retain admission
  slots until they settle. Kernel cancellation prevents normal transaction commit.
  Request-owned SSE remains supported for gateway/MCP actions without recurring
  keepalive intervals; both JSON and SSE deadline paths are tested.
- `--request-only` packed scaffold includes guarded hosted startup and a CRUD card
  entity. It does not silently select reference mode or a production local verifier.
- Mandatory `pnpm test:m08` added to both Node 22/24 PostgreSQL CI matrix jobs. Those
  remote jobs have not been executed for this uncommitted candidate.

## Executed local gates

Supported runtimes: **Node 22.23.3** and **Node 24.21.0**. Each final local run:

```sh
# PATH selects the supported Node binary. Disposable public fixture only.
EMBODY_POSTGRES_URL=postgresql://embody_runtime:fixture-only-runtime@127.0.0.1:55432/embody_test
EMBODY_POSTGRES_MIGRATION_URL=postgresql://embody_migrator:fixture-only-migrator@127.0.0.1:55432/embody_test
EMBODY_POSTGRES_OTHER_URL=postgresql://embody_other:fixture-only-other@127.0.0.1:55432/embody_other
EMBODY_POSTGRES_TEST_CONTAINER=embody-m08-verification-postgres-1
pnpm test:m08
```

Results on **both majors**: **19 suites / 120 passed / 0 failures / 0 skips**, then
packed external-consumer scaffold **typecheck, 1 test, build and hosted PostgreSQL
startup/health passed**. Packages were built before each mandatory run. Sanitized
runner output is `.artifacts/verification/m08.json` (local generated artifact;
not a frozen remote acceptance artifact). Raw terminal logs were in `/tmp`, not
committed as durable evidence.

Disposable database image: `postgres:16-alpine`, local image identity
`sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`.
Maintenance migration and DML grants ran separately from runtime-role tests.

Acceptance mapping:

| Case | Local evidence |
|---|---|
| M08.a | Fake timers: 20 cold kernel/host boots leave no timers; rejected init callback never executes. Real DB: 20 concurrent hosted factory boot/start/health/stop operations call no `setInterval`; worker drains reject. Schema boot succeeds using a runtime role unable to migrate. |
| M08.b | Real PostgreSQL CRUD survives kernel/pool replacement between create/get/update/get. Separate subprocess commits one row, opens another write transaction, then receives SIGKILL. Its scratch directory is deleted; replacement sees exactly the committed row and no partial write/outbox record. |
| M08.c | Workflow/event/subscription/schedule/background/capability/init/service declarations and SQLite/registration/event settings fail with actionable errors. 100 generated CRUD writes retain zero notifications. Failed after-hook and cancellation roll back; custom publishing rejects. |
| M08.d | Runtime role CREATE TABLE and ALTER existing storage table fail. Core/reference host/event/workflow suites pass in the mandatory run. |

Additional final local gates:

- `pnpm typecheck`: all workspace packages/apps/examples passed.
- `pnpm lint`: eslint, package boundaries and six skill-file checks passed.
- `pnpm api-report`: report up to date; `pnpm format:check`: passed.
- Node 22/24 `pnpm test:verification`: **37 passed / 0 skipped**, including missing-DB refusal for the M08 runner.
- Node 24 `pnpm test`: **379 passed / 15 optional DB skips**, plus the **37** runner
  regression tests. Those optional skips are not counted as mandatory DB evidence;
  the M08 mandatory real-DB runs above have zero skips.

The shell default Node 26 was rejected by verification prerequisites during an
initial attempt; it is not qualifying evidence. Tests/gates were rerun on the
supported majors after fixing implementation/test issues.

## Cleanup and limits

The dedicated `embody-m08-verification` Compose container/network were removed with
`docker compose -p embody-m08-verification -f docker-compose.postgres-test.yml down -v`.
No named data volume was retained. Existing `embody-local-*` containers were left
untouched. Test subprocesses, scratch directories and packed-consumer temporary
applications were removed. No cloud resources were created or changed.

Pending: independent code/acceptance review, candidate freeze/PR and exact-candidate
Node22/24 CI. No measured provider cold-path latency, actual cloud-zero interval,
three-instance deployment cap, source sandbox, reliable background delivery or
production/release qualification is inferred. Arbitrary customer timers, module
state, external effects and filesystem writes remain outside static preflight.
