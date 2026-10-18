# M10 independent final review: candidate `de847c4`

**Candidate:** `de847c4` (draft PR #48, branch `feat/mvp-m10-source-admission`) · **Diff:** `19cd93e..de847c4` (9 files, +395/−99); the [initial review](../M10-19cd93e/independent-review.md) stands for everything else.

**Reviewer:** a separate read-only reviewer, independent of both the author and the initial reviewer, who implemented this fix. Local runs used Node 24.21.0 on a clean tree and a disposable M03 fixture (Compose project `embody-m10-final-de847c4`, port 55847, removed afterwards). No `embody-local-*` service was touched, no cloud calls were made and no money was spent. The repro scripts are kept outside the repo in the session notes folder (`m10-final-de847c4-probe{1..7}.mjs`): probes 1–5 are the initial review's probes adapted to forward `delete`'s `options`, and probes 6–7 are new. The only tracked file this review changes is this one.

## Verdict: **ACCEPTED**

B1 is fixed on both paths (retention sweep vs. renew-in-place, and stale rejecting completion), and N1 is fixed. I re-verified both with the initial review's repros, on MemoryGatewayStore and real PostgreSQL. All 7 new regressions fail on `19cd93e` and pass on `de847c4`. Exact-candidate CI is green on Node 22 and 24 with zero skips.

I found one new defect, F1: a PostgreSQL-only lost update in which `admitSource`'s upsert overwrites a row the sweep has just fenced. Under a further interruption, this leaves a tombstone that no later sweep can purge. It is non-blocking for M10 for three reasons:
- it never makes a live record point at a missing object;
- the CLI re-run still recovers;
- nothing schedules `purgeExpiredSources` until M16.

It must be fixed before M16 schedules the sweep.

## Reproduction of local suites (exact candidate, clean tree, Node 24.21.0)

| Command | Result |
|---|---|
| `pnpm test:postgres` (run first, as TESTING.md requires) | passed 16, 0 skipped |
| `pnpm test:gateway-store` | passed **50**, 0 skipped (49 plus the new tombstone conformance case on PostgreSQL) |
| `pnpm test:mvp` | passed **484**, 0 skipped (476 at `19cd93e` plus 8: 6 gateway source-admission tests, 1 GCS adapter test, 1 PG conformance test), and the 86 runner tests |
| `pnpm test:verification` | passed 86, 0 skipped. It now builds `@embody/gateway...` first. |
| Package suites: gateway `source-admission` + `source-storage`, cli `source.test.ts`, cloud-contracts `source.test.ts` | 33 / 3 / 57 passed |

**Exact-candidate CI:** run `39130168048` on `de847c4` succeeded on all 9 jobs (quality, postgres-matrix and e2e-artifacts-matrix on Node 22 and 24, plus postgres, e2e-artifacts and terraform). Both postgres-matrix jobs report the same per-suite counts as my run (16 / 50 / 95 / 6 / 109 / 18 / 174 / 16) with no skips. The CI failure on `19cd93e` (the mocked M10 cloud suite imported `dist` before any build) is fixed: `test:verification` now builds the gateway closure first.

**Fail-on-old check:** I checked out `de847c4`'s three gateway test files onto `19cd93e` in a temporary worktree, built, ran and removed it. Results:
- All 7 new tests failed: the tombstone conformance test, the two B1 sweep tests, the interrupted-sweep test, the stale-reject test, N1, and the GCS conditional delete test.
- So did the pre-existing purge test, which only gained the new `skipped` field.
- The other 57 tests passed.

## Re-verification

| Finding | Result on `de847c4` |
|---|---|
| B1 scenario 1: the re-run lands after the sweep listed S but before the fence (probe 6, PG) | Fixed. The re-run renews S in place: same ID, PUT `412`, complete `verified`. The fence CAS loses, so purge returns `{deleted: 0, failed: 0, skipped: 1}`. The record is verified, the object is present, and `verifySubmissionSource` accepts. On `19cd93e` the object was deleted under the verified record. |
| B1 scenario 1: the re-run lands after the fence, while the sweep's object delete is in flight (probes 4 memory and 5 PG) | Fixed. The re-run gets a fresh upload ID and object key: PUT `200`, then `verified`. The sweep deletes only the old object and the tombstone (`deleted: 1`). The old ID returns `NOT_FOUND`, and a further CLI re-run replays the fresh verified identity. One object remains, and it is the fresh one. |
| B1 scenario 2: stale rejecting completion (probes 2 and 3) | Fixed. The delayed B deletes with `ifGenerationMatch` set to the generation it inspected. The re-armed upload's generation differs, so it survives. B's CAS loses, and B reports the authoritative `verified`. The record is verified, the object is present, and `verifySubmissionSource` accepts. |
| Interrupted sweep | The tombstone stays listed (`expiredSources` has no `purging` filter), is invisible to status and complete (`404`), and the next sweep deletes the object and then the tombstone. This holds except in the F1 interleaving. |
| GCS conditional delete | `?ifGenerationMatch=<digits>` (validated `^\d{1,24}$`, so no query injection). `404` and the conditional `412` count as success; an unconditional `412` and any other status fail opaquely. This matches the JSON API: a DELETE with `ifGenerationMatch` gets `412` on a generation mismatch and `404` when the object is missing. The memory fake mirrors it. It is not live-proven, which the initial review allowed. |
| N1 | Fixed. A persisted rejection, or a replay of one, is audited as `failure` with the mapped code (probe 3: `source.complete:failure:VALIDATION_ERROR` for `DIGEST_MISMATCH`). A completion that lost the CAS to a verifying completion is still a success. |
| PG schema | The column `purging boolean NOT NULL DEFAULT false` and the partial unique index `(workspace_id, app_id, idempotency_key) WHERE NOT purging` replace the table-level `UNIQUE`. The insert's `ON CONFLICT` targets the primary key `(workspace_id, upload_id)`, not the partial index, so no index-inference predicate is needed. A fresh identity under a tombstoned key is a new PK and does not conflict. Concurrent fresh admissions of one key are serialized by the per-workspace `FOR UPDATE`, and the partial index backs that up (`23505` → `ConflictError`). |
| Quotas | Tombstones are excluded from the pending and byte usage in both stores. While its object is still being deleted, a tombstone's bytes are briefly uncounted (at most one sweep's lag, and only the workspace's own data). This is acceptable. |
| Pinning (M12) | `updateSource` refuses a tombstone in both stores (`AND NOT purging` / `prior.purging`), so a pin either wins the CAS before the fence (and the sweep skips the record) or gets `ConflictError`. `verifySubmissionSource` refuses tombstones and expired unpinned records. A pin attempted after `retainUntil` therefore loses safely to the sweep. M12 must map that `ConflictError` to a not-found or retry result, not to a 500. |

## New finding (non-blocking)

### F1. PostgreSQL `admitSource` upsert is not revision-checked, so it can overwrite a fenced row and strand it

`PostgresGatewayStore.admitSource` reads the existing row in its transaction, but locks only the workspace row. It then writes with `INSERT … ON CONFLICT (workspace_id, upload_id) DO UPDATE SET …`, which has no `WHERE`: no revision check and no `NOT purging` check. The sweep's fence is a plain CAS `UPDATE` that does not take the workspace lock. The memory store is atomic, so it cannot interleave like this, and the shared conformance suite does not catch it.

**Reproduced on real PostgreSQL (probe 7):**
1. Verified source S expires at revision 2.
2. The user re-runs `create`. `admitSource` selects S (rev 2, expired, not purging) and decides to renew it in place.
3. Between that `SELECT` and the `INSERT`, the sweep fences S, setting `purging=true` and rev 3.
4. The upsert lands on the fenced row and replaces the document with a renewed `pending` one (no `purging` field, `retain_until` +7 days, rev 3). The `purging` column stays `true`. The user receives `pending` with an upload URL for the old key, and `complete` then returns `404`.
5. If the sweep finishes, the row and object are still cleaned up: `deleteSource` matches rev 3, because both writers computed 2 + 1. But suppose the sweep is interrupted between the fence and the tombstone delete (provider blip, crash, deadline). Then:
   - from +8 days, every later sweep lists the row;
   - it reads `document.purging` as false, so it tries to fence again;
   - the CAS fails on `AND NOT purging`, and the row counts as `skipped`.

   Observed: `{deleted: 0, failed: 0, skipped: 1}` at +8 days and again at +15 days. The row and its object (the user's earlier upload) are never purged.

**Impact:**
- **Safety holds.** The row is invisible and never becomes a live record without its object.
- **Recovery holds.** The next CLI re-run gets a fresh identity.
- **Retention fails.** Customer source is kept past the 7-day MD15 retention for as long as the row exists. The bucket lifecycle rule is only a recommended backstop.
- **The sweep can stall.** Stuck rows stay at the head of `ORDER BY retain_until LIMIT n`, so enough of them would stop it from making progress.
- **Likelihood is very low.** It needs a re-run inside a millisecond-wide window during that record's sweep, plus a sweep interruption.

**Same root cause, pre-existing since `19cd93e`, by inspection only:** a completion's CAS that lands inside the same window is overwritten too. A `verified` record can go back to `pending` (its object is still present, so the next complete re-verifies it). A concurrent `rejected` can be replaced by `pending` without the `attempt + 1`.

**Suggested fix:**
- Make the upsert a CAS: `DO UPDATE … WHERE embody_platform_sources.revision = <existing revision> AND NOT embody_platform_sources.purging` (or `SELECT … FOR UPDATE` the existing row), and treat zero rows as a conflict and retry the admission.
- Optionally, make the sweep trust the column, not the document. For example, `expiredSources` could return `purging` from the column, or `purgeExpiredSources` could proceed to delete when the fence CAS fails only because the row is already purging.
- Add a PG-only interleaving test (probe 7 is a template: wrap one client's `INSERT` to run the fence first).

## Non-blocking notes

- **F2. Signed URLs outlive a pending record's retention (pre-existing).** Renewing access on a pending record, or re-arming after a mismatch, refreshes `accessExpiresAt` but not `retainUntil`. Access renewed within 10 minutes of `retainUntil` can therefore outlive the record. A PUT that lands after the sweep deleted the object leaves an orphan object with no record. Complete then returns `404`, the re-run gets a fresh identity, and the orphan is customer bytes held beyond retention until a lifecycle rule (not yet mandated) removes it. Possible fixes: cap the access expiry at `retainUntil`, or have the sweep skip records whose access is still live.
- **F3. No upgrade path for an existing platform schema.** `migrate()` is `CREATE … IF NOT EXISTS` only. On a database migrated at `19cd93e`, the table keeps its table-level `UNIQUE` and has no `purging` column. `CREATE UNIQUE INDEX … WHERE NOT purging` then fails and the migration transaction rolls back. That fails loudly and closed, and no durable platform database runs M10 yet, so this is acceptable pre-release. The platform store will need versioned migrations (as `@embody/storage` has) before the first hosted deploy (M14).
- **F4. The sweep's own object delete is unconditional.** This is correct because the key is fenced first, but it relies on F2 for any URL that is still live. Recording the generation at `verified` would let the sweep pin its delete too.
- **F5. Docs.** SOURCES.md says nothing can update a tombstone. That holds for `updateSource` but not for the F1 upsert, so update the wording together with F1.
- **F6. Disclosure.** My probes ran their sweeps globally on the disposable fixture, only after `test:mvp` had finished. Probe 7 wraps the store's private `pool.connect` to force the interleaving.
- **Carried from the initial review:**
  - N2 (source GET bypasses admission and audit) is unchanged.
  - N3 (quota accounting for rejected and never-uploaded records) is unchanged.
  - N4 (no route deadline on the completion CAS) is unchanged.
  - N5 (`Content-Encoding` differential) is unchanged and still needs a cents-level live probe.
  - N6–N10 are unchanged. Probe 1 still shows the N7 leniencies (one zero end block, trailing zeros, bidi and `CON` names).

## Per-step and per-case verdicts

`19cd93e..de847c4` touches only admission, store and storage code (plus `package.json` and docs). Packaging, the tar reader, extraction and the CLI are unchanged, so the initial review's analysis stands for them, and their suites pass on this candidate.

| Item | Verdict | Notes |
|---|---|---|
| Step 1: packaging and exclusions | ACCEPT | Unchanged. CLI 3/3 and contracts 57/57; probe 1 gives the same results. |
| Step 2: authorize and quota before capacity | ACCEPT | Unchanged order. Tombstones are excluded from the quotas. |
| Step 3: verify and safe extraction; no evaluation | ACCEPT | Unchanged. Reject deletes are now pinned to the inspected generation. |
| Step 4: identity, retention, retries | ACCEPT | B1 is fixed: a renewal before the fence wins the CAS, and a renewal after it gets a fresh identity. Retries reuse one upload ID; identity stays immutable. F1 (a PG lost update that can strand a tombstone) and F2 (orphan objects) are retention-liveness follow-ups that must be fixed before M16 schedules the sweep. |
| M10.a | ACCEPT | Unchanged adversarial coverage, all passing. |
| M10.b | ACCEPT | Unchanged. Audits now record failure codes, never content. |
| M10.c | ACCEPT | The re-run that races the sweep now ends verified with its object present, or with a fresh verified identity. A stale completion can no longer delete a re-armed upload. In the F1 interleaving, a re-run sees `404` once and recovers on the next re-run. There is no build or deployment path, and cross-workspace and other-app access is still refused. |

## Required follow-ups (not blocking M10 DONE)

1. Fix F1 (and ideally F2) with a PG interleaving regression before M16 schedules `purgeExpiredSources`.
2. M12: map a pin `ConflictError` on a tombstone to not found or retry.
3. Add versioned platform migrations (F3) before the first hosted deploy.
