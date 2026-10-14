# M19 independent final review: candidate `d2d7476`

**Candidate:** `d2d74764c1e3f2be5aff7170c13595b1a1817c31` · **Diff:** `e5f809b..d2d7476` ([initial review](./initial-review-e5f809b.md) stands for the rest) · **Reviewer:** same separate read-only reviewer; out-of-tree experiments on a disposable PostgreSQL container (removed) using the candidate's built packages under `embody_runtime`.

## Verdict: **ACCEPTED**

No remaining note blocks DONE. DONE is conditional on green exact-candidate CI for `d2d7476` with zero skips in `test:m19`.

## Re-verification

| Finding | Result on `d2d7476` |
|---|---|
| B1 cancel racing `completeStep` | Fixed: cancel waits on the instance lock, then sees `start` completed; final `compensated`, `activeVersions` empty (was stuck `running`). |
| B1 cancel racing `failStep` | Fixed: final `cancelled`, all steps cancelled (was stuck `waiting`). |
| B2 timeout with in-transaction write | Fixed: one note, attempt 2 (was two). |
| N1 deadlock | Fixed: 3 runs × 300 instances, 4 claimers vs 8 cancellers, zero errors (was `40P01` every run); reference tick rejections caught. |
| N2 orphan sweep blocking | Fixed: other tenant's tick 109 ms behind a cancelled 5 s step (was 3498 ms). |
| N3 | `search_path = pg_catalog, pg_temp`; claim time within ±10 min of `now()`, `p_expired ≤ p_now`. |
| N4 | Documented. |
| N7 (CLI) | Resolution unit tests and positive owner CLI cancel added. |

Lock-order audit: worker own step → instance → other steps; cancel/retry/release instance → steps; claims step rows only with `SKIP LOCKED` and no instance writes; orphan sweep instance → step, both `SKIP LOCKED`. No remaining cycle; a cancel waits only for the short recording phase.

Randomized stress (reviewer's own): 60 diamonds, 3 tenants, 4 pools, 3 workers, 15 % transient failures with retries, in-transaction writes, compensations, half cancelled at random, 3 runs: zero errors, all terminal, no duplicated writes, no compensation or undo without a write.

## Per-case verdicts

| Case | Verdict |
|---|---|
| Step 1 / M19.a | ACCEPT |
| Step 2 / M19.b | ACCEPT |
| Step 3 | ACCEPT |
| Step 4 / M19.c | ACCEPT (runtime wiring is M20, N6) |
| Step 5 / M19.d | ACCEPT (built `bin.js`, not packed tarball: residual N7) |

## Non-blocking notes

- **F1** A non-compensatable step that finishes after cancellation is recorded `cancelled` while its writes commit; wording in WORKFLOWS.md overstated "only successful attempts commit". Follow-up: record as `completed` or roll back at record time; document.
- **F2** A sibling completing after an instance failed clears the instance `error` text (status stays `failed`).
- **F3** Instance stays `pending` until the first step is recorded.
- **F4** PostgreSQL workers with clocks skewed > 10 min get `Invalid claim time` (affects only a future PostgreSQL test harness).
- **F5** The crash-worker fixture's `{ ...tx }` drops `savepoint`; harmless for the tested crash points.
- Carried: N5, N6, N7 (packed tarball), N8, N9.
