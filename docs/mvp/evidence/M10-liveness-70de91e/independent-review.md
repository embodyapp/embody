# M10 retention-liveness fix: independent review of candidate `70de91e`

**Candidate:** `70de91e` (draft PR #49, branch `fix/mvp-m10-retention-liveness`, stacked on #48 at `2fc355a`) · **Diff:** `2fc355a..70de91e` (6 files, +250/−18) · **Scope:** findings F1 and F2 of the [M10 final review](../M10-de847c4/independent-final-review.md), plus any new defects in the diff.

**Reviewer:** a separate read-only session, not the author. Local runs used Node 24.21.0 on a clean tree and a disposable M03 fixture (Compose project `m10-liveness-review-70de91e`, port 55871, removed afterwards with `down --volumes`). No `embody-local-*` service was touched, no cloud calls were made and no money was spent. No product code was changed. The repro scripts live outside the repo:
- the final reviewer's `m10-final-de847c4-probe7.mjs`, run unchanged against the new `dist`;
- a new `m10-liveness-70de91e-probe8.mjs` and its output, in the session notes folder.

Both probes wrap the store's private `pool.connect` to force interleavings, and they filter sweeps to their own workspace. The only tracked file this review adds is this one.

## Verdict: **ACCEPTED**

- **F1 is fixed.** The admission upsert is now a CAS on the revision it read and on the row not being a tombstone. A lost race rolls back and re-reads. The sweep trusts the `purging` column.
- **F2 is fixed.** Renewed or re-armed upload access is capped at `retainUntil` all the way to the signed URL, and the sweep skips records whose access is still live.
- **Regressions:** all 3 new ones fail on `2fc355a` and pass on `70de91e`.
- **Local suites:** all mandatory ones pass with zero skips.
- **New defects:** none blocking. Two non-blocking notes for M16 are below.

## Reproduction of local suites (exact candidate, clean tree, Node 24.21.0)

| Command | Result |
|---|---|
| `pnpm test:postgres` (run first) | passed 16, 0 skipped |
| `pnpm test:gateway-store` | passed **51**, 0 skipped |
| `pnpm test:mvp` | passed **487**, 0 skipped (16 / 51 / 95 / 6 / 109 / 18 / 176 / 16), exit 0. This matches TESTING.md and the hand-over. |

**Fail-on-old check:** I checked out `2fc355a`'s `packages/gateway/src` over the candidate's tests, against the same migrated fixture, then restored the tree:
- `source-admission.test.ts -t F2`: 2 failed, the cap test and the live-access sweep-skip test;
- `postgres-store.test.ts -t F1`: 1 failed (`expected true to be false`, because `replay` was true: the renewal overwrote the fenced row).

All 3 new regressions fail on the old code.

**Exact-candidate CI:** green. See the CI section at the end.

## F1: admission upsert vs. sweep fence (fixed)

**Probe 7, the original repro, re-run unchanged on real PostgreSQL:**
- **Before:** the upsert landed on the fenced row. The tombstone stranded (`skipped: 1` at +8d and again at +15d).
- **Now:** the sweep fences revision 3 inside admission's window. The upsert writes 0 rows, admission re-reads and allocates a **fresh identity** (`same id false`, upload offered).
- **Rows after the race:** the tombstone is `{purging: true, doc_purging: "true", revision 3, verified}`, untouched. Next to it is a new `pending` row at revision 1.
- **Sweeps:**

  | Sweep | Result | Effect |
  |---|---|---|
  | +0d, with object delete failing | `{failed: 1}` | the tombstone stays listed |
  | +8d | `{deleted: 2}` | the tombstone, plus the re-run's own expired pending row |
  | +15d | `{deleted: 0}` | nothing left |

  No stranding.

**Further interleavings (probe 8, real PostgreSQL):**

| Case | Observed | Verdict |
|---|---|---|
| **A. Retry bound.** A concurrent revision bump lands inside each of three windows. | Three upserts with `expected` 1, 2 and 3 each wrote 0 rows. `admitSource` throws `ConflictError("Revision conflict")`, and the row stays consistent at rev 4. With two losses, the third attempt wins (rev 7, same ID, `replay: true`). | Bounded. Never a lost write. The route maps the non-`SourceAdmissionError` to 503 `DEPENDENCY_UNAVAILABLE` (read in `source-admission.ts`). |
| **B. Fence lands inside the retry's window.** Attempt 1 loses to a bump, attempt 2 loses to the sweep fence. | Attempt 3 re-reads and finds nothing (`AND NOT purging`). It inserts a fresh identity (`expected: 0`, 1 row). The tombstone keeps `purging` in both column and document. A failing sweep leaves it, and the next sweep deletes only the tombstone's own object key and row. The fresh record survives. | Correct. |
| **C. Fresh-insert PK collision.** A row with the generated `upload_id` but another idempotency key exists before the INSERT. | The upsert's `WHERE revision=0` cannot match: `revision` has `CHECK (revision > 0)`. So it writes 0 rows and rolls back. The retry draws a new random ID and inserts. The foreign row is never overwritten. | Correct. A concurrent colliding insert from another transaction cannot even happen mid-admission. The FK's `KEY SHARE` on the workspace row blocks behind admission's `FOR UPDATE`, and my first probe attempt hung on exactly that. The probe therefore planted the row inside the admission's own transaction to test the upsert semantics. |
| **Completion inside the window** (the candidate's PG test, case 2) | The renewal loses, re-reads `verified`, and replays without writing. | Correct. This also closes the pre-existing "verified goes back to pending" variant from the final review. |
| **Column says purging, document does not** (legacy rows stranded before this fix; the candidate's PG test, case 3) | `expiredSources` overlays `purging: true` from the column. The sweep skips the fence and deletes. | Correct. |

**Code review notes on the CAS:**
- When the predicate fails, `ON CONFLICT … DO UPDATE … WHERE` still locks the conflicting row. The new code rolls back before returning `null`, so that lock is released.
- Under READ COMMITTED, the `WHERE` is evaluated against the latest committed version after any concurrent writer commits. A fence that is still uncommitted when the upsert arrives is therefore waited on and seen.
- The retry loop opens a new connection and transaction each time, and re-runs quota and decision logic against fresh state.

## F2: upload access outliving retention (fixed)

**Cap path.** `decideSourceAdmission` caps renewals of a pending record, and re-arms after a retryable mismatch, at `min(now+10min, retainUntil)`. Fresh admissions and the expired-renewal branch already set access well inside their new 7-day retention. The route passes `record.accessExpiresAt` straight to the signer.

`GcsSourceObjectStore.canonical` computes `X-Goog-Expires` as `floor((expiresAt − now)/1000)` from a second-truncated `X-Goog-Date`. So the URL's actual expiry is always at or before `retainUntil`.

**Probe 8 D, real route + PostgreSQL + the real GCS V4 canonicalizer with a stubbed `signBlob` (no network):**

| Renewal at | Result |
|---|---|
| retainUntil − 5 min | 200, same ID, `upload.expiresAt == retainUntil`, `X-Goog-Expires=300` |
| retainUntil − 1.5 s | 200, `X-Goog-Expires=1` |
| retainUntil − 0.5 s | **503 `DEPENDENCY_UNAVAILABLE`**. The signer rejects an expiry under 1 s. The record's `accessExpiresAt` was still written (rev bump, value `retainUntil`), which is harmless. No URL is issued. |
| retainUntil exactly, and +1 s | 200, renewed in place under the same ID with a fresh 7-day retention and `X-Goog-Expires=600` |

The 1-second edge fails closed, and the next attempt succeeds. This is acceptable as documented in the hand-over.

**Sweep.**
- *Probe 8 E:* after a capped renewal, a sweep exactly at `retainUntil` fences and deletes (`accessExpiresAt == now` is not live).
- *Legacy record*, with access 5 min past `retainUntil`:

  | Sweep at | Result |
  |---|---|
  | retainUntil | `skipped: 1` |
  | +5 min − 1 ms | `skipped: 1` |
  | +5 min | `deleted: 1` |

- The skip applies only to non-purging rows, so tombstones are never held back.
- Skipped rows can occupy the head of `ORDER BY retain_until LIMIT n` only for the at most 10 minutes of a pre-cap URL, so they cannot stall the sweep.

## Non-blocking notes (for M16)

**N1. A boundary PUT can still land after the sweep.**

GCS validates a signed URL's expiry when the request arrives, not when the body finishes. So two cases can still produce an orphan object:
- a PUT that starts just before `accessExpiresAt` and is still streaming when the sweep runs at `retainUntil`;
- GCS's clock running slightly behind the gateway's.

In either case the sweep's object delete returns 404 and the tombstone is removed. The later-completing PUT then creates an orphan object.

The window is bounded by the maximum upload duration for the size cap, and the bucket lifecycle rule backstops it. Recommendation: when M16 schedules the sweep, give the live-access skip a grace margin, for example skipping while `accessExpiresAt > now − grace` with grace at least the maximum upload time plus skew. Alternatively, run the sweep with an equivalent lag. Mandating the lifecycle rule would also close it.

**N2. Lost-race exhaustion surfaces as 503.**

After three lost CAS rounds, `create` returns 503 `DEPENDENCY_UNAVAILABLE`. That needs three distinct concurrent writers inside sub-millisecond windows, so it is acceptable. The CLI already treats `DEPENDENCY_UNAVAILABLE` on `create` as retryable (`packages/cli/src/source.ts:197`).

**Unchanged.** F3 (versioned platform migrations), F4 (the sweep's object delete is unconditional), M12's pin-`ConflictError` mapping, and N2–N10 from the earlier reviews are untouched by this diff.

**Docs.** The SOURCES.md and TESTING.md wording matches the behavior I observed. The 51 / 487 counts match my runs.

## Exact-candidate CI

Run `39131573910` (`pull_request`, head `70de91ed7b3bea46f2435320a628da4eb00ed472`) concluded **success**.

- **Jobs:** all 9 succeeded: quality, postgres-matrix and e2e-artifacts-matrix on Node 22 and 24, plus postgres, e2e-artifacts and terraform.
- **Per-suite counts:** both postgres-matrix jobs report 16 / 51 / 95 / 6 / 109 / 18 / 176 / 16, identical to my local `test:mvp`.
- **Skips:** the mandatory DB step and the false-green regression step both report `skipped 0`.
