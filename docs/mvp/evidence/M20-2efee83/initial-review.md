# M20 independent acceptance review: candidate `2efee83`

**Candidate:** `2efee83da769c7ffcf370b3dd97f975e0a618335` (PR #43, stacked on #42) · **Diff:** `67ee8f3..2efee83` · **Reviewer:** separate read-only reviewer. Out-of-tree experiments ran on a disposable M03 fixture (Compose project `embody-m20-review-2efee83`, port 55743, removed afterwards) against the candidate's built packages under `embody_runtime`, using its in-memory wake queue and real PostgreSQL. The candidate's `durable.test.ts` + `durable.postgres.test.ts` pass on that fixture (44/44). The packed scaffold and `test:m20` were not rerun.

## Verdict: **REJECTED** (B1, B2, B3 reproduced on real PostgreSQL)

Accepted parts:
- Wake-before-commit: an enqueue failure rolls back the write.
- Txid-named tasks and the `txid_status` gate (see R1 below).
- Rolled-back and early tasks.
- Delayed steps and retry backoff as task schedule times.
- The platform-invoker verifier (issuer, signature, exact audience, verified email, lifetime) and the app check.
- Gateway tokens are never accepted on the drain, and a drain token never authorizes `/execute`.
- The request-only profile is unchanged: `retainsGeneratedEvent` keeps request-only at zero retention, and `recover` is a no-op without `durable`.
- The cleanup chain.
- CI wiring.

M20.a and M20.c are accepted. M20.b is rejected. M20.d is accepted pending exact-candidate CI.

## Blocking

All three blockers break "no lost work". In each one, an item ends up with no task that will ever wake it. MD12 recovery rescues the item only if that tenant later sends an authenticated request. An idle tenant on a scale-to-zero app waits forever.

- **B1. A drain that claims an item other than its own task's item and then dies leaves no lease follow-up.**
  - Lease follow-ups exist only when a drain inspects its own task's item (`DurableDrain.run`, `durable.ts:417-421`).
  - Step claims are global and event claims cover the whole tenant batch. So any drain can claim items whose own tasks were already answered. Examples: an event drain, a sweep, a batch-full or skip-locked own task that fell back to a sweep, or a sibling in the batch.
  - When that drain dies, the queue retries its task. The retry finds its own item completed, or has no item at all (a sweep), so it schedules nothing.
  - Reproduced:
    1. Tenant C has two earlier due steps. Tenant A's `reserve` wake drains them, leaving `reserve` for a sweep.
    2. Tenant B's event drain claims A's `reserve` and dies.
    3. The queue then delivers every remaining task, including the sweep and B's retried task. All of them answer `processed`, 0 follow-ups.
    4. At +5 min, `reserve` is `running` with an expired lease and no task is due.
  - The crash matrix only kills drains processing their own task's item.
  - Required: every claim must guarantee a successor. For example, enqueue a lease-expiry wake (item + attempt name) for each claimed event, step and compensation inside the claim transaction, before it commits. Add regression tests for a non-own batch item and for a dying sweep.
- **B2. A dead compensation never gets a lease follow-up, even from its own task.**
  - A claimed compensation keeps status `compensating` with `claimed_at` set.
  - `stepState` (`durable.ts:522-528`) treats only `running` as leased. A claimed compensation is reported as `scheduled`/`claimable: false`, so no follow-up is scheduled.
  - Reproduced:
    1. `fulfil` completes `reserve`, then is cancelled.
    2. The compensation's own task is claimed by a drain that dies.
    3. The retried task and the later `ship` wake answer `processed`, 0 follow-ups.
    4. At +5 min, `reserve` is `compensating` and claimed, with nothing due.
  - Required: treat `claimedAt !== undefined` as leased for compensations too. The fix for B1 covers this as well. Add a crash-matrix row for a mid-compensation kill.
- **B3. A step whose own recording transaction cannot enqueue its wakes loops forever; its failure is never recorded.**
  - `WakeTracker.flush` throws after the callback. That rolls back `completeStep`/`failStep` together with the step's writes, and the error escapes `WorkflowWorker.process`. The step stays `running`, is re-claimed after its lease with `attempt + 1`, and reruns its handler. `maxAttempts` is never applied.
  - Durable preflight accepts the triggering definition. A root step with 101 dependents passes `assertDurablePlugins`, because there is no step-count or fan-out limit.
  - Reproduced with that definition (`root` has `maxAttempts: 1`): every drain answers `RateLimitedError` (429); after 4 lease cycles `root` is `running`, attempt 4, and the external ledger shows 4 attempts.
  - The same root cause applies to other cases, found by inspection:
    - Cancelling an instance with more than 100 completed compensatable steps fails `RATE_LIMITED`, so the instance can never be cancelled.
    - When a compensation completes it re-wakes every remaining compensation. That is O(N²) tasks, and it fails once more than 100 remain.
    - A delay of exactly 30 days leaves no margin against Cloud Tasks' 30-day limit (cleanup uses −60 s). A rejection there turns into `UNAVAILABLE` and the same loop.
  - Required:
    - Make fan-out never exceed the quota inside a worker transaction. For example, when a worker transaction would create more than the quota (or more than a small threshold), collapse the step wakes into one sweep wake, since sweeps claim globally and chain while batches are full. Either that, or reject such definitions in preflight.
    - Record a failure, or at least a bounded attempt count, when the record transaction fails deterministically.
    - Keep a margin below 30 days for delays and backoff.
    - Add a PostgreSQL test with more than 100 dependents and with a large cancellation.

## Non-blocking

- **R1 (checked, not a bug)** Concern: a task is delivered while its COMMIT is durable but not yet visible. I widened that window with `synchronous_standby_names` set to a missing standby. `txid_status` checks the procarray first, so the drain answered `uncommitted` (503). After visibility, the redelivery processed the event once. The gate is sound.
- **N1** `recover()` runs before each `/execute` response and before an SSE stream's terminal flush. It costs one extra tenant transaction and adds up to 2 s of latency per request. Consider running it after the response is sent, with Cloud Run CPU throttling in mind, or rate-limiting it in memory per tenant before it queries.
- **N2** `WorkflowWorker.tick`'s `Promise.all` rejects on the first failed step, so the drain answers while a sibling step is still running. On Cloud Run that sibling then runs throttled after the response and can outlive its lease.
- **N3** `overdue()` counts a compensation that is legitimately waiting for a later running step. Recovery then enqueues a sweep every minute per active tenant during long compensation chains. This is harmless but noisy.
- **N4** Inbox purge is app-wide, so any tenant's cleanup deletes other tenants' completed inbox rows. Dead letters are kept, but their completed-handler inbox rows are purged after 30 days. A future dead-letter replay would rerun handlers that already completed. Document this now, or scope the purge.
- **N5** IMPLEMENTATION step 5 is only partly done. Per-app queue quotas and M07 quota/audit integration are deferred in DURABLE "Not yet proven"; the 256 KiB envelope limit predates M20. Record the deferral explicitly in STATUS so it is not lost.
- **N6** Migration 6 runs a non-concurrent `CREATE INDEX` and updates every completed outbox row. On a large outbox this blocks writes during migration. Document it in the migration guidance.
- **N7** The drain checks readiness and capacity before authentication, so an unauthenticated caller can see `503`/`429` instead of `401`. Minor.
- **N8** Coverage gaps behind B1 and B2: the crash matrix never kills a drain while it holds a non-own item, a sweep or a compensation. Add these with the fixes.
- **N9** Carried to M09: whether Cloud Tasks OIDC tokens carry `email`/`email_verified` for the invoker, retry ceilings for `503` answers (`uncommitted`, `early`), and the dedup window. If max attempts are exhausted on early or uncommitted retries, the work is lost.
- **N10** Reviewer disclosure: during R1 I ran `ALTER SYSTEM SET synchronous_standby_names` on the disposable fixture's server, then reset it. The fixture was removed. No tracked file changed except this review. The repro suite (`m20-review-repro.postgres.test.ts`) is kept outside the repo in the session notes folder, not committed.

## Per-case verdicts

| Case | Verdict |
|---|---|
| M20.a | ACCEPT. No intervals, and 20 cold boots start no work; ran under the candidate suites. |
| M20.b | **REJECT** (B1, B2; B3 is a related loop) |
| M20.c | ACCEPT. Outage rollback, early tasks and drain identity are correct; R1 confirms the uncommitted retry. |
| M20.d | ACCEPT pending exact-candidate CI. The packed durable scaffold was not rerun by the reviewer. |
