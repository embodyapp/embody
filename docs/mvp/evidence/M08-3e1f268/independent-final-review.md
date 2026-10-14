# M08 independent final review — candidate `3e1f268`

**Candidate:** `3e1f2686d0f2600d6c33b10898f97039e3f9b015` (`feat/mvp-m08-request-only`, [#40](https://github.com/embodyapp/embody/pull/40))
**Reviewed diff:** `587d74a..3e1f268` (commits `157d90b`, `3e1f268`); the [initial review](./initial-code-review-587d74a.md) of `c4e13fb..587d74a` remains in force for everything else.
**Reviewer:** same separate read-only automated reviewer; no edits, commits or branch changes.

## Decision: **ACCEPTED**

B1 fixed and independently verified; N1 covered by a regression-sensitive test; no new code blockers.

## Method

Read the full incremental diff (`PostgresStorage.withClient` and callers, new storage
regression, new host pool-config test, CI step). Re-ran the original out-of-tree B1
reproduction against the candidate's built `@embody/storage` dist in a disposable
`postgres:16-alpine` container (removed afterwards): 1 s idle-in-transaction timeout with a
transaction held open across non-DB work.

- `587d74a`: `Unhandled 'error' event`, exit 1.
- `3e1f268`: transaction rejected (`Client has encountered a connection error and is not queryable`), process printed `survived`, exit 0.

## B1 resolution

| Aspect | Assessment |
|---|---|
| Checkout-lifetime client listener | Resolved. `withClient` attaches `error` for the whole checkout and detaches in `finally` before `release`; pg-pool re-attaches its idle listener on release, so there is no unguarded window. |
| Broken client discarded | Resolved. `client.release(broken)` → pg-pool destroys it. The regression uses `max: 1`, so a successful follow-up transaction proves replacement. |
| Original error preserved | Resolved. A failed `ROLLBACK` is recorded as `broken` rather than masking the first error. |
| Idle-pool termination | Resolved. `pool.on("error")` prevents idle-client termination crashing the process. |
| Coverage of paths | `transaction()` and migrate path both use `withClient`; verify-mode boot uses `pool.query`, which pg-pool already guards. |
| Atomicity | A terminated session cannot commit; `COMMIT` rejects, server already rolled back; test asserts zero committed rows. |
| Regression strength | Subprocess test asserts exit 0, empty stderr, `rejected:` outcome, working follow-up transaction and 0 rows; each fails on the old code. Mandatory via `test:m08` (builds first, zero-skip enforcement). |

## N1 resolution

`packages/host/test/request-only-pool.test.ts` records the exact config hosted
`createAppHost` passes (`max` 5, `statement_timeout` 30000,
`idle_in_transaction_session_timeout` 30000, `idleTimeoutMillis` 1000, `schemaMode: "verify"`).
Deleting or altering any value fails the test; an unsupported Node major leaves `configs`
empty and also fails. Included in `test:m08`.

## CI change (`157d90b`)

`npm install --global npm@11` before `test:m08` in `postgres-matrix` matches the packed
baseline job; zero-skip enforcement is unchanged.

## Acceptance (final)

| Case | Verdict | Basis |
|---|---|---|
| M08.a | ACCEPT | 20 concurrent hosted real-DB boots: no `setInterval`; drains reject; verify-mode boot under a DDL-incapable role; rejected `init` never runs. |
| M08.b | ACCEPT | CRUD survives pool/kernel replacement; SIGKILL leaves only committed row; server-side session termination now rolls back and the process survives. |
| M08.c | ACCEPT | Preflight/env rejections; 100 generated writes → zero outbox rows; hook veto/cancellation roll back; custom publish rejects. |
| M08.d | ACCEPT | Runtime-role CREATE/ALTER fail; reference-mode core/host suites in the mandatory run. |

Steps 1–6 satisfied; step 5 pool bounds are now enforced and tested.

## Blocking findings

None.

## Non-blocking

- **N9 (new):** idle-pool and checked-out-client error handlers drop the error without
  sanitized logging/metric; server terminations surface only as failed requests. Belongs to
  M09/M13 operations hardening.

| Note | Blocks DONE? | Disposition |
|---|---|---|
| N2 pool-acquire timeout | No | Residual; budget-bound acquire later. |
| N3 reference-mode deltas | No | Record as intended change. |
| N4 scratch not enforced | No | Residual owned by M09/M11/M13. |
| N5 abort/COMMIT race | No | Documented; M07 gateway reports unknown outcome. |
| N6 coverage gaps | No | Follow-up tests. |
| N7 evidence binding | **Yes (bookkeeping)** | Rebind evidence/STATUS to `3e1f268` on `feat/mvp-m08-request-only` with CI URL before DONE. |
| N8 timer-spy scope | No | Claim scoped to "no business/heartbeat timers". |

## Conditions for DONE (evidence only, no code changes)

1. Clean CI on exactly `3e1f2686d0f2600d6c33b10898f97039e3f9b015`: Node 22/24 quality/build/package, `test:mvp` and `test:m08` zero skips including the packed request-only scaffold; run URL and sanitized artifacts retained and bound to the SHA.
2. N7 rebinding in the evidence commit; N2–N6, N8, N9 recorded as residuals.
3. No cloud-zero, three-instance cap, source sandbox or provider qualification claim (M09/M11/M13/M17).
