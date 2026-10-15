# M20 independent final review: candidate `4af12c3`

**Candidate:** `4af12c3` (PR #43) · **Diff:** `2efee83..4af12c3` ([initial review](../M20-2efee83/initial-review.md) stands for the rest) · **Reviewer:** same separate read-only reviewer. Out-of-tree experiments ran on a disposable M03 fixture (Compose project `embody-m20-review-4af12c3`, port 55744, removed afterwards) against the candidate's built packages under `embody_runtime`. The candidate's `durable.test.ts` + `durable.postgres.test.ts` pass there (51/51). `test:m20`, `test:m19`, `test:m08` and the packed scaffold were not rerun by the reviewer.

## Verdict: **ACCEPTED**

B1–B3 are fixed and re-verified with the reviewer's own repros. No remaining note blocks DONE. DONE is conditional on green exact-candidate CI for `4af12c3` with zero skips in `test:m20` and `test:m19`.

## Re-verification

| Finding | Result on `4af12c3` |
|---|---|
| B1: a drain that dies holding a non-own item | Fixed. The death was simulated faithfully by terminating the dead worker's connection. Lease wakes from the claim transaction were due after the lease. Five drains later, `reserve` and `ship` were `completed`; on `2efee83`, `reserve` stayed `running` with nothing due. |
| B2: a dead compensation | Fixed. The lease wake fired, and `reserve` ended `compensated`; on `2efee83` it stayed `compensating` and claimed. |
| B3: fan-out loop | The 101-step definition is now rejected by preflight (50-step cap). At the cap, a root step with 49 leaves completes all 50 steps with `root` at attempt 1. Cost: 76 tasks and 27 drains, plus 50 lease-wake drains. A step whose results cannot be scheduled fails once (candidate test). |
| R1: commit durable but not visible | Still sound: `uncommitted`, then processed once. |
| N1, N2, N3, N7 | Fixed in code: recovery is checked at most once per tenant a minute; batches use `settleAll`; `overdue()` mirrors the claim; the drain authenticates before readiness and capacity checks. |
| N4, N5, N6, N9 | Documented in DURABLE and STATUS. |

Collapse logic (by reading the code):
- Forward step wakes stay per step up to 4. Above that, they collapse into one sweep per tenant and due time; sweeps carry the txid, so a rolled-back fan-out is a no-op.
- Compensation changes emit a single sweep at the earliest compensating due time.
- Each sweep claims globally and chains while its batch is full or `overdue(org)` is true, so collapsed steps keep a successor.
- `overdue()` now matches `embody_claim_workflow_steps` in every reachable state I traced:
  - `blocked` steps are not counted, since dependencies are unblocked in the same transaction;
  - pending steps of cancelled instances are excluded;
  - a compensation is counted only when no later step is compensating or running;
  - expired running claims are counted, including orphans, which the claim settles.

## Non-blocking notes

- **F1. Immediate sweep chain while a worker holds an expired claim's row lock.**
  - Reproduced: a step handler that ignores its abort signal keeps its transaction, and with it the `lockClaim` row lock, open past the lease. The claim `SKIP LOCKED`s the step, but `overdue()` still reports the expired claim. Every drain then enqueues another immediate sweep: 60 back-to-back drains with no progress before the reviewer stopped.
  - In the hosted configuration this is bounded. `idle_in_transaction_session_timeout` is 30 s, below the 60 s lease, so a handler that stops querying loses its lock before the lease expires. Only a handler that keeps issuing statements past 60 s triggers the loop, and only for as long as it keeps going. I reasoned this through but did not run it with the hosted timeouts.
  - Follow-up: when a drain claimed nothing, schedule the overdue-driven sweep with a delay or backoff (for example 5–30 s) instead of immediately.
- **F2. Cost.** Every claimed item now costs a lease-wake drain about 61 s later. One event takes 2 tasks (plus the day's cleanup) and 2 drains, where it took 1; a 2-step workflow takes 4 tasks and 4 drains; a 50-step fan-out takes 76 tasks and about 77 drains. That is acceptable for correctness, but M09/M17 cost qualification should count it. Under a backlog, every own-task drain that finds overdue work starts its own sweep chain. Chains run in parallel and end only when the backlog is empty, so concurrency follows the backlog. Per-app queue dispatch limits (M09/M12) are the cap.
- **F3. Lease-wake name reuse after a rolled-back claim.**
  - Lease names hash the item and attempt. If a claim transaction rolls back after its lease task was created (a partial queue failure), the next claim reuses that attempt number, and its enqueue reports `duplicate` against the old task.
  - If the old task has already executed, a different drain's later claim has no lease successor. If the claimer is that old task itself, the queue's retry of it covers the claim.
  - Very narrow. Including the claim time in the name would remove it.
- **F4. Compensation recorded terminal after a transient outage.** `recordUncommitted` treats any compensation failure as terminal, as M19 does. If a compensation's own transaction fails on a transient queue outage and the queue recovers before the recording transaction runs, the compensation is recorded `compensation_failed` instead of retried. This is narrow, because the recording transaction also needs the queue.
- **F5. Profile-wide change.** `WorkflowWorker.process` now records failures of uncommitted step transactions in every profile, including reference/M19. This is benign (non-terminal unless `RateLimited`/`Validation`), but it is a change to M19 behaviour; the author reports `test:m19` 51 passing, which CI must confirm.
- **F6. Disclosure.** As in the initial review, I briefly set `synchronous_standby_names` on the disposable fixture's server for R1 and reset it. For R2/R4 I terminated the simulated dead worker's backend. Both fixtures are removed. The repro suite is kept outside the repo (`m20-review-repro-4af12c3.postgres.test.ts` in the session notes folder). No tracked file changed except this review.
- Carried: N4, N6, N9 and the DURABLE "Not yet proven" list (real Cloud Tasks, IAM, OIDC claims, retry ceilings, M07 audit and quotas).

## Per-case verdicts

| Case | Verdict |
|---|---|
| M20.a | ACCEPT. No intervals, and 20 cold boots start no work; the candidate suites pass. |
| M20.b | ACCEPT. Non-own, compensation and sweep crashes now have lease successors (B1/B2 repros pass); the crash matrix now includes the B1/B2 killed-child rows. |
| M20.c | ACCEPT. Early tasks reschedule rather than run (claims still honour `scheduled_at`); outage rollback; drain identity checked before anything else. |
| M20.d | ACCEPT pending exact-candidate CI (the packed durable scaffold and request-only suites were not rerun by the reviewer). |
