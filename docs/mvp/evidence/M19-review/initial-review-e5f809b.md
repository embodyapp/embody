# M19 independent acceptance review: candidate `e5f809b`

**Candidate:** `e5f809bcd3c84a954f01cbd1af7377cb25a18002` · **Diff:** `7cf7fcd..e5f809b` · **Reviewer:** separate read-only reviewer; out-of-tree experiments on a disposable PostgreSQL container (removed).

## Verdict: **REJECTED** (B1, B2 reproduced on real PostgreSQL)

Accepted parts: claim function returns claim identity only; `lockClaim` fencing; concurrent-join fix; reverse-order compensation; compensation retry; orphan settlement; crash matrix uses real SIGKILLed processes with failing attempt counts; CI wiring. M19.b, step 3, M19.c accepted; M19.d accepted with gaps.

## Blocking

- **B1. Cancel committing during `completeStep`/`failStep` leaves the instance stuck forever.** Both read `cancel_requested` with a plain SELECT and then act on the stale value; cancel does not touch the running step. Reproduced: completion variant ended `running, cancelRequested: true`, `start` completed but never compensated, version pinned in `activeVersions`; failure variant ended `waiting` and was never claimable. Required: lock the instance (`FOR UPDATE`) before deciding; regression test cancelling inside that window.
- **B2. A timed-out (or abort-then-throw) step commits its in-transaction writes with the failure record and is then retried.** Reproduced: `timeoutMs: 300`, two attempts, two notes for one logical step; a cooperative handler that writes then throws on cancel leaves its write. Required: run the handler under a savepoint and roll back before `failStep`; PostgreSQL test with an in-transaction write plus timeout.

## Non-blocking

- **N1** Deadlock between cancel and claim (reproduced `40P01`): inconsistent lock order (claim: steps then instance; cancel: instance then steps). Reference-mode `setInterval(() => void this.tick())` leaves tick rejections unhandled.
- **N2** The orphan sweep is not `SKIP LOCKED`: a step processed past its lease blocks every claim for every tenant (another tenant's tick took 3.5 s).
- **N3** Caller-supplied `p_now`/`p_expired` are trusted; `search_path` safer as `pg_catalog, pg_temp`.
- **N4** The claim function also mutates (orphan settlement); wording understates it.
- **N5** A cancel can commit between snapshot read and handler start; converges once B1 is fixed.
- **N6** `stepDeadlineMs` and `assertHostedWorkflowLimits` not wired (deferred to M20); `stop()` does not abort in-flight steps; `bounded` waits indefinitely for a handler ignoring its signal (documented).
- **N7** Built CLI binary rather than packed tarball; no positive owner cancel via CLI or retry via MCP; denial checks would pass if CLI cancel resolution broke; no CLI unit tests for the new resolution.
- **N8** Crash matrix covers the linear `start` step only.
- **N9** Orphan settlement compensates steps whose in-transaction effect rolled back (documented conservative choice).
- **N10** Reviewer disclosure: overwrote the gitignored `.artifacts/verification/postgres-prepare.json` with a refused Node 26 run; no tracked file changed.
