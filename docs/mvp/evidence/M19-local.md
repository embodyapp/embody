# M19 workflow engine gates: evidence (DONE)

Branch `feat/mvp-m19-workflow-gates` ([#42](https://github.com/embodyapp/embody/pull/42)), based on `7cf7fcd` (scope change, PR #41). Contract:
[WORKFLOWS](../WORKFLOWS.md). Closes framework P11-02 and P11-03 once accepted. Accepted
candidate **`d2d74764c1e3f2be5aff7170c13595b1a1817c31`**; exact-candidate
[CI 38568267378](https://github.com/embodyapp/embody/actions/runs/38568267378) all 9 checks green.
Reviews and CI artifacts: [`M19-d2d7476/`](./M19-d2d7476/).

## Defects found and fixed

| Defect | Effect before M19 | Fix |
|---|---|---|
| Worker claimed in a `system` org transaction | Under the real runtime role RLS hid every step, so **no workflow ever ran** on PostgreSQL (reproduced: instance stayed `pending`) | `SECURITY DEFINER` claim function returning claim identity only; each step processed in its tenant transaction |
| No claim fencing | A worker whose lease expired could still complete or fail a step another worker had taken over | Lock the step and require matching worker and attempt before running or recording it |
| Concurrent join release | Two branches finishing together each saw the other still running; the join stayed `blocked` forever (reproduced intermittently with concurrent workers) | Claims re-check blocked steps whose dependencies completed |
| Fence lock used `SKIP LOCKED` | A competing claim scan's transient row lock made a worker abandon its own valid claim until lease expiry (reproduced) | Wait for the lock; the ownership check decides |
| Cancel after claim | A claimed step still ran after cancellation committed | Release without running when the instance is cancelled |
| Early terminal status | Cancelling with a step running marked the instance `cancelled` while it was still settling | Status derived from steps once they settle |
| Compensation order | Earlier steps could be compensated before a later running step settled | A compensation waits for every later step; compensating claims respect leases |
| Orphan after cancel | A step left `running` by a dead worker in a cancelled instance never settled | Claim settles it after its lease (compensate if compensatable) |
| Late writes after timeout or cancel | The worker could commit while the handler kept writing through the released connection | Signal the handler and wait for it to settle before recording |
| Failed compensation retry | Retry reset cancellation and resumed forward steps | Retry re-runs the compensation |
| Cancel racing step recording (review B1) | The worker read `cancel_requested` without a lock; a cancel committing in between left the instance non-terminal and uncompensated forever | Lock the instance before deciding, in every recording, cancel, retry and release path |
| Writes of a failed attempt (review B2) | A timed-out or given-up attempt committed its database writes with the failure record, then the retry wrote them again | Each attempt runs under a savepoint that rolls back on failure |
| Cancel/claim deadlock (review N1) | Claims locked steps then instances, cancel the reverse: `40P01` under load | One order everywhere (instance, then steps); claims lock step rows only with `SKIP LOCKED`; reference-mode tick errors are caught |
| Orphan sweep blocking (review N2) | A step processed past its lease blocked every claim for every tenant | Sweep skips locked instances and steps |
| Trusted worker clock (review N3) | Caller-supplied claim times were not bounded | Rejected beyond ten minutes from the database clock; `search_path = pg_catalog, pg_temp` |
| CLI action resolution | `embody <app> <workflow> start` was rejected; `embody <app> start` picked an arbitrary workflow | Two-word resolution first, positional ID for status/cancel/retry |

The [initial independent review](./M19-d2d7476/initial-review-e5f809b.md) rejected candidate
`e5f809b` on B1 and B2. Six regression tests (both B1 variants, both B2 variants, the deadlock
stress and the non-blocking claim) **fail on `e5f809b`** in a separate checkout and database and
pass on the fix.

## Acceptance mapping

| Case | Evidence (`pnpm test:m19`) |
|---|---|
| M19.a | Crash matrix kills a real worker process after the claim commits, before the effect, after the external effect, after recording completion and during compensation; recovery after the lease yields one logical effect each (re-execution visible as 2 attempts where expected). Cancellation before claim, between claim and processing, during a cooperative step, and with a step that finishes anyway; no step starts after cancellation; reverse-order compensation verified by attempt order. |
| M19.b | Runtime role `rolbypassrls=false`; claim function result type is exactly `(step_id, step_org_id, step_attempt)`; another role has no `EXECUTE`; cross-tenant status/cancel and direct repository reads return not found. |
| M19.c | Limits reject step timeout > 30 s, delay > 30 days and retry backoff > 30 days with actionable messages. Active versions equal the owner-role ground truth after concurrent starts and ticks. |
| M19.d | Built CLI binary and official MCP client through a real gateway to a real host on PostgreSQL: start (idempotent), status, cancel, retry; unauthorized and cross-workspace control denied. |

## Exact-candidate CI (`d2d7476`, run 38568267378)

All 9 checks green ([metadata](./M19-d2d7476/ci-run.json), [artifacts](./M19-d2d7476/ci/)). Node
22.23.3 and 24.21.0 each: `test:m19` **51 / 0 / 0**, `test:m08` 148 / 0 / 0, `test:mvp` 320 / 0 / 0,
gateway-store 43 / 0 / 0, app PostgreSQL 16 / 0 / 0, packed and distributed baselines, quality.
The [independent final review](./M19-d2d7476/independent-final-review.md) accepts M19.a–d.

## Local results

Disposable `postgres:16-alpine` fixture (`docker-compose.postgres-test.yml`, project
`embody-m19-verification`), image `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`.

- `pnpm test:m19`: **51 passed / 0 failed / 0 skipped** on Node **22.23.3** and **24.21.0**;
  repeated runs stable after the fixes above (the concurrent-join test runs three workers on 20
  diamonds).
- Node 24: `pnpm test:m08` 122/0/0 plus packed request-only scaffold; `pnpm test:postgres` 16/0/0;
  `pnpm test` 392 passed / 41 optional DB skips; `pnpm test:verification` 38/0;
  lint, typecheck, API report and format pass.

## Residuals

From the final review (non-blocking): F1 a non-compensatable step finishing after cancellation is
recorded `cancelled` while its writes stay (documented in WORKFLOWS); F2 a sibling completing after
an instance failed clears its `error` text; F3 instance stays `pending` until its first step is
recorded; F4 PostgreSQL workers with clocks skewed over ten minutes are refused; F5 the
crash-worker fixture runs without savepoints (harmless for the tested points). Packed CLI tarball
coverage stays with `test:baseline`/M14.


- Cancellation and timeouts are cooperative: a handler that ignores `context.signal` holds its
  step (and its transaction) until it settles. Under the hosted 30 s idle-transaction limit the
  session is then terminated and the step re-runs after its lease.
- One claim function serves the whole app database, so every worker sharing a database must load
  the same workflow definitions (true in production; tests run these suites sequentially).
- M20 still has to call `assertHostedWorkflowLimits` at preflight, set `stepDeadlineMs`, and wake
  workers from the queue instead of polling.
- The automated MCP journey uses the official SDK client; a real Claude Code transcript for
  workflows is not part of M19.
