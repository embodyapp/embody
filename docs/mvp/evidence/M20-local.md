# M20 local evidence (2026-10-15)

> **Update after review.** The [independent initial review](./M20-2efee83/initial-review.md)
> rejected `2efee83` (B1 non-own claims and B2 compensations left no lease successor; B3
> fan-out and unrecordable steps looped). The fixes and their evidence are in
> [Review fixes](#review-fixes-after-2efee83) below; the tables that follow describe the
> original candidate.

Branch `feat/mvp-m20-durable-runtime`, stacked on #42 (`67ee8f3`). Local development evidence on
a dirty tree before commit; acceptance requires an independent review and exact-candidate CI.

Environment: macOS, Node 24.21.0, pnpm 11.25.0, npm 11.19.0, disposable M03 fixture
(`postgres:16-alpine`, Compose project `embody-m20-verification`, port 55520). Shared
`embody-local-*` services were not touched.

| Command | Result |
|---|---|
| `pnpm test:m20` | passed: 73 tests, zero skips (durable unit 26, durable PostgreSQL 18, request-only regression, scaffold) + packed durable scaffold (typecheck, test, build, hosted durable start, health, unauthenticated drain `401`) |
| `pnpm test:m19` | passed: 51, zero skips (M19 suite now holds the claiming-suites advisory lock) |
| `pnpm test:m08` | passed: 193, zero skips (includes the new host suites) + packed request-only scaffold |
| `pnpm test:mvp` | passed |
| `pnpm test:verification` | passed: 39 (adds the M20 missing-configuration negative) |
| `pnpm verify` | passed (lint, license, typecheck, test, build, API report, format) |

The durable PostgreSQL suite and the M19 suite were also run together with file parallelism:
39 passed, serialized by the advisory lock.

## Acceptance mapping

| Case | Evidence |
|---|---|
| M20.a | `durable.test.ts`: 20 cold `createHost` boots under fake timers leave zero timers, no tasks, no drain or recovery calls. `durable.postgres.test.ts`: 20 hosted `createAppHost` boots on real PostgreSQL call `setInterval` zero times, enqueue nothing and change no effect; work ran only when a test delivered a task. |
| M20.b | Crash matrix with `SIGKILL`ed child processes: before enqueue, after enqueue before commit, after commit before drain, mid-batch, after effect before commit, after commit before acknowledgement, mid-step. Each ends with no lost work and one logical effect per key in the external ledger. |
| M20.c | Queue outage rolls back publishing and workflow start (`UNAVAILABLE`, no rows). A delayed step delivered early answers `early` and runs nothing; it runs once when due. Drain requests for another app (`403`), malformed bodies, missing/attacker/wrong-audience/wrong-email/unverified/expired tokens and gateway principal tokens are rejected; a drain token never authorizes `/execute`. |
| M20.d | Request-only suites and `test:m08` pass unchanged; the packed durable scaffold builds and runs. |

## Residuals

See [DURABLE](../DURABLE.md#not-yet-proven): live Cloud Tasks qualification and IAM (M09),
drain audit and quotas outside the M07 gateway ledger, no separate event-handler deadline, and
durable deployment admission (M11/M13). The packed proof initially failed on a scaffold typing
error (`definePlugin` single-argument actions infer `never` input); fixed with `define.action`
before the recorded pass.

## Review fixes after `2efee83`

| Finding | Fix | Regression |
|---|---|---|
| B1 | Every claim (outbox `claimBatch`, workflow `claimDue`) enqueues a lease wake at the claim's lease expiry before the claim commits, for every claimed item | `B1: a drain that dies holding another task's step leaves a lease wake` (killed child) |
| B2 | Claimed compensations count as leased; covered by the claim-time lease wake | `B2: a drain that dies in a compensation leaves a lease wake` (killed child) |
| B3 | More than four step wakes collapse into sweeps per tenant and due time; compensation changes wake one sweep; sweeps chain while claimable work is due; 50-step preflight cap; a step whose transaction cannot commit records its failure in a new transaction (terminal for deterministic scheduling failures); due times beyond 30 days are clamped to the horizon and early tasks reschedule themselves | 40-leaf fan-out completes; cancelling 40 completions creates one task and compensates each once; a step publishing 101 events fails once with one attempt |
| N1 | Recovery checks a tenant at most once a minute per instance | MD12 test |
| N2 | Worker batches wait for every item before answering | existing suites |
| N3 | `overdue()` mirrors the claim: excludes compensations waiting for later steps and cancelled instances' steps | sweep chaining tests |
| N4, N6, N9 | Documented in [DURABLE](../DURABLE.md) | — |
| N5 | Recorded in STATUS: per-app queue quotas and M07 quota/audit integration deferred to M09/M12 | — |
| N7 | Drain authenticates before readiness and capacity checks | drain authentication test |

The five B1–B3 regressions fail on `2efee83` (run in a temporary worktree with the new tests and
fixture) and pass on the fix. Three further tests differ on `2efee83` by design: early tasks now
reschedule instead of answering `503`, recovery is rate-limited, and the mid-batch redelivery
relies on the claim's lease wake.

Gates rerun on the fix (Node 24, same fixture): `test:m20` 80 passed with zero skips plus the
packed durable scaffold; `test:m19` 51; `test:m08` 200 plus the packed request-only scaffold;
`test:mvp` passed; `pnpm verify` passed.
