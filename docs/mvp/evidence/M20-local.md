# M20 local evidence (2026-10-15)

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
