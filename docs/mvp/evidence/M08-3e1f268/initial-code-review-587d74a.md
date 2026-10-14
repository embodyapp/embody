# M08 independent acceptance review — initial candidate `587d74a`

**Candidate:** `587d74a` (`feat/mvp-m08-request-only`) · **Diff reviewed:** `c4e13fb..587d74a`
**Reviewer:** separate read-only automated reviewer (no edits/commits/branch changes)

## Verdict: **REJECTED** — one blocking runtime defect (B1)

The request-only profile was found well-engineered: hosted workers/registration disabled,
boot is a read-only ledger check, unsupported plugins fail preflight, the zero-retention
outbox policy is explicit, and the gate is wired into CI. One new hosted setting
(`idle_in_transaction_session_timeout`) introduced a deterministic whole-process crash
reachable from a single slow request, reproduced empirically.

Method: read IMPLEMENTATION (M08), RUNTIME, local evidence, the full diff, host/kernel/storage
paths, new tests, `scripts/test-m08.mjs`, `test-packed-consumer.mjs` and CI wiring. One
out-of-tree reproduction against a disposable `postgres:16-alpine` container (removed) using
the built `@embody/storage` dist. Test counts were not re-run by the reviewer.

## Acceptance assessment

| Case | Verdict | Notes |
|---|---|---|
| M08.a | ACCEPT | 20 concurrent hosted `createAppHost` boot/start/health/stop with a `globalThis.setInterval` spy that would catch worker regressions; drain hooks reject; 20 verify-mode boots under a role shown to fail CREATE/ALTER; fake-timer test proves rejected `init` never runs. |
| M08.b | ACCEPT | CRUD survives kernel/pool replacement twice; SIGKILL mid-transaction leaves only the committed row. Caveat: the SIGKILL child uses raw `PostgresStorage` (never writes outbox), so its outbox assertion is vacuous; the kernel-path assertion is meaningful. |
| M08.c | ACCEPT | Plugin preflight covers workflows/events/subscriptions/schedules/background/capabilities/init/services with message checks; env rejections assert only `toThrow()`. 100 generated creates → zero outbox rows; after-hook veto and cancellation roll back; custom publish rejects. |
| M08.d | ACCEPT | Runtime role CREATE TABLE → permission denied, ALTER → must be owner. `test:m08` runs all of core/host tests including reference-mode suites. |

Steps 1–4 and 6 implemented as specified. Step 5 implemented (deadlines/cancellation tested
on JSON and SSE, held slot → 429) but **blocked by B1**; pool bounds untested (N1); scratch is
documentation-only (N4). Gate wiring: no false greens found.

## Blocking

### B1 — Hosted idle-in-transaction timeout crashes the whole process on a slow handler

`packages/host/src/index.ts` sets `idle_in_transaction_session_timeout: 30_000`;
`PostgresStorage.transaction` and pool construction registered no `error` listener. When
PostgreSQL terminates an idle-in-transaction session, pg 8.23 emits `'error'` on the
checked-out client; pg-pool 3.14 removes its idle listener during checkout, so the event is
unhandled and Node exits.

Scenario: a handler that ignores `ctx.signal` awaits non-DB work > 30 s (explicitly allowed
by RUNTIME.md) → host answers 503 at 30 s → PostgreSQL kills the session → instance exits,
dropping every other in-flight request.

Reproduced with a 1 s timeout and a 2.5 s callback: `Unhandled 'error' event` /
`terminating connection due to idle-in-transaction timeout`, exit code 1.

Required: per-checkout client error handling with discard on release (also migrate path),
`pool.on('error')` for idle clients, and a PostgreSQL regression test asserting survival.

## Non-blocking notes

- **N1** Hosted pool bounds (`max`, statement/idle-transaction timeouts, idle expiry) were untested.
- **N2** No `connectionTimeoutMillis`: requests queued behind 5 stuck handlers wait unbounded; host still answers 503 at deadline, but admission slot is held; shutdown waits too.
- **N3** Reference mode changed slightly: `/execute/stream` now counts toward concurrency (can 429); reference `/execute` aborts on client close. Likely improvements, undocumented.
- **N4** Ephemeral scratch is documented, not enforced; deferred to M09/M11/M13.
- **N5** Abort after handler return but before COMMIT may commit while host answers 503 — the documented ambiguous `UNAVAILABLE` unknown-outcome (M07).
- **N6** Coverage gaps: auth-deadline race, `createHost` request-only guards, injected SQLite rejection in hosted `createAppHost`, scaffold test exercises only `ping` under reference harness.
- **N7** Evidence/STATUS described an uncommitted tree on the M07 branch; rebind to the frozen SHA/branch.
- **N8** `setInterval` spy cannot see Node-internal unref'd timers or library intervals; claim is "no business/heartbeat timers", not "no timers whatsoever".

## Resolution

B1 and N1 fixed in `3e1f268` (see [final review](./independent-final-review.md)).
