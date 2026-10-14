# M08 request-only runtime evidence — DONE

Frozen candidate: `3e1f2686d0f2600d6c33b10898f97039e3f9b015` on
`feat/mvp-m08-request-only` ([#40](https://github.com/embodyapp/embody/pull/40), stacked on
accepted/unmerged [#39](https://github.com/embodyapp/embody/pull/39), base `c4e13fb`).
Contract: [request-only runtime](../RUNTIME.md). Reviews and CI artifacts:
[`M08-3e1f268/`](./M08-3e1f268/).

## Candidate history

| Commit | Change | CI |
|---|---|---|
| `587d74a` | Initial M08 implementation (the local gates below were first run on this tree) | [38532322030](https://github.com/embodyapp/embody/actions/runs/38532322030) **failed**: 120 tests passed, but the packed request-only scaffold `npm install` crashed under npm 10 (`edgesOut`); Node 24 cancelled by fail-fast. Not counted. |
| `157d90b` | CI: `postgres-matrix` installs npm@11 before `test:m08`, matching the packed baseline job | [38532984276](https://github.com/embodyapp/embody/actions/runs/38532984276) all9 green |
| `3e1f268` | Fix independent-review B1 (PostgreSQL session termination crashed the process) and N1 (hosted pool bounds untested) | [38535915385](https://github.com/embodyapp/embody/actions/runs/38535915385) **all9 green — accepted candidate** |

[Initial independent review](./M08-3e1f268/initial-code-review-587d74a.md) rejected `587d74a`
on B1, reproduced empirically. [Independent final review](./M08-3e1f268/independent-final-review.md)
accepts M08.a–d on `3e1f268`; the B1 reproduction was re-run independently (old: unhandled
`error`, exit 1; new: transaction rejects, process survives, exit 0).

## Exact-candidate CI (`3e1f268`, run 38535915385)

All 9 checks green ([run metadata](./M08-3e1f268/ci-run.json), sanitized
[artifacts](./M08-3e1f268/ci/)). Node 22.23.3 and 24.21.0 each:

- `test:m08`: **122 passed / 0 failed / 0 skipped**, then packed request-only scaffold proof.
- `test:mvp`: **295 / 0 / 0**; gateway-store **43 / 0 / 0**; app PostgreSQL **16 / 0 / 0**.
- Packed consumer and distributed baselines: 1 + 1 journeys, 0 failed / 0 skipped.
- Quality (lint, licenses, typecheck, test, build, api-report, format) passed.

## Local gates on `3e1f268`

Node 24.21.0 and 22.23.3 `pnpm test:m08` against a disposable `postgres:16-alpine`
fixture: **122 passed / 0 skips** plus packed scaffold, both majors. The new B1 regression
was first shown to fail on the `587d74a` storage code (`Unhandled 'error' event`). Node 24:
`pnpm lint`, `typecheck`, `api-report`, `format:check`, `test:verification` passed; plain
`pnpm test` **380 passed / 16 optional DB skips** (optional skips are not mandatory evidence).

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
- Mandatory `pnpm test:m08` added to both Node 22/24 PostgreSQL CI matrix jobs (see
  exact-candidate CI above).
- Hosted PostgreSQL clients keep an error listener for their whole checkout and broken
  clients are discarded, so a server-side session termination (for example the 30 s
  idle-in-transaction timeout while a handler awaits non-database work) fails that request
  instead of crashing the instance (`3e1f268`).

## Initial local gates (`587d74a` tree, before freeze)

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

After both the initial and the `3e1f268` local runs, the dedicated
`embody-m08-verification` Compose container/network were removed with
`docker compose -p embody-m08-verification -f docker-compose.postgres-test.yml down -v`.
No named data volume was retained. Existing `embody-local-*` containers were left
untouched (verified healthy after teardown). Both independent-review reproductions used
their own disposable containers, removed afterwards. Test subprocesses, scratch directories and packed-consumer temporary
applications were removed. No cloud resources were created or changed.

Accepted residuals (non-blocking per the [final review](./M08-3e1f268/independent-final-review.md)):

- **N2** No pool-acquire timeout; requests queued behind five stuck handlers still get 503 at
  the deadline but hold admission slots. Budget-bound acquire is later hardening.
- **N3** Reference mode: `/execute/stream` now counts toward concurrency (can 429) and
  reference `/execute` aborts on client close. Intended changes.
- **N4** Ephemeral scratch is a documented contract, not enforced (no read-only filesystem or
  tmpfs control); owned by M09/M11/M13.
- **N5** Abort after handler return but before `COMMIT` can commit while the host answers 503;
  the documented ambiguous outcome the M07 gateway reports as unknown.
- **N6** Follow-up coverage: auth-deadline race, `createHost` request-only guards, injected
  SQLite rejection in hosted `createAppHost`, scaffold CRUD under hosted mode.
- **N8** The `setInterval` spy proves no business/heartbeat timers, not "no timers whatsoever"
  (Node-internal unref'd and library timers are not observed).
- **N9** Terminated-session errors are dropped without sanitized logging/metrics; M09/M13
  operations hardening.

No measured provider cold-path latency, actual cloud-zero interval, three-instance deployment
cap, source sandbox, reliable background delivery or production/release qualification is
inferred (M09/M11/M13/M17). Arbitrary customer timers, module state, external effects and
filesystem writes remain outside static preflight.
