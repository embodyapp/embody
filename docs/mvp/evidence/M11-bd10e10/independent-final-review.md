# M11 isolated build and artifact admission: independent final review of candidate `bd10e10`

**Candidate:** `bd10e10` (draft PR [#50](https://github.com/embodyapp/embody/pull/50), branch `feat/mvp-m11-build-admission`). **Diff since the rejected candidate:** `410c418..bd10e10`, 20 files, +779/−106. It contains three fix commits (`5f812ce`, `1c84dbc`, `2f37b5e`), the earlier review cherry-picked as `80f8ab7`, and a docs-only commit, `bd10e10`. **Scope:** the fixes for B1, B2 and findings 1–11 of the [review of `410c418`](../M11-410c418/independent-review.md), as listed in the [fix record](../M11-410c418/fixes.md), plus any new defect the fixes introduce.

**Reviewer:** the same read-only session that wrote the first review, not the author. Local runs used Node 24.21.0 and pnpm 11.25.0 on a clean checkout of the exact candidate. There were two disposable M03 fixtures, both removed with `down --volumes`:
- Compose project `embody-m11-review-bd10e10` on port 55612, for the suites;
- `embody-m11-review-freeze` on port 55613, for one PostgreSQL repro.

No `embody-local-*` service was touched. No cloud calls were made and no money was spent. No product code was changed; this file is the only tracked change.

The repro scripts and their outputs are in the session notes folder:
- `m11-review-410c418-stuck-building.mjs`, re-run unchanged;
- `m11-final-bd10e10-starve.mjs`;
- `m11-final-bd10e10-pg-freeze.mjs`.

## Verdict: **REJECTED** (one new blocker, small)

B1 and B2 are fixed, and the non-blocking findings are fixed or written down as later-task obligations. The fix for finding 8 adds a new defect to the PostgreSQL artifact store. It refuses a legitimate pin of an admitted artifact when the caller passes the record that `settle` returned. The memory store accepts the same write, so every unit test passes while production would fail.

This is **B3** below. The fix is one function plus one conformance case. Everything else in this candidate is accepted. After B3 is fixed, a re-review only needs to cover that diff, with green exact-candidate CI.

## Reproduction (exact candidate, clean tree, Node 24.21.0)

| Command | Result |
|---|---|
| `pnpm test:verification` | passed **93**, 0 skipped |
| `pnpm test:m11` (Docker) | passed **10/10 cases, 15 builds in 280 s**, including the new `oversized-manifest` adversary (`MANIFEST_INVALID`) |
| `pnpm test:postgres` | passed **16**, 0 skipped |
| `pnpm test:gateway-store` | passed **55**, 0 skipped |
| `pnpm test:mvp` | passed **549**, 0 skipped: postgres 16, gateway-store 55, cloud-contracts 106, auth 6, host 109, MCP 18, gateway 223, CLI 16 |

All results match the fix record. The evidence JSON records commit `bd10e10` with `dirty: false`.

**Exact-candidate CI:** checks for `bd10e10` were queued with no conclusions when this review was written.

## B1 (oversized manifest): fixed

The 410c418 repro, re-run unchanged against the new build, now gives:

```text
+0h settle -> rejected MANIFEST_INVALID
+2h settle -> rejected MANIFEST_INVALID
+9600h settle -> rejected MANIFEST_INVALID
purge at +400d: { deleted: 1, reclaimed: 0, failed: 0, skipped: 0 }
orphan cleanup at +400d: { deleted: 0, kept: 0 }
```

The fix closes all three paths:
- The assemble step now refuses a manifest larger than 256 KiB itself and reports `MANIFEST_INVALID` through its trusted step output.
- `BuildOutputTooLargeError` is a separate subclass that `decideAdmission` maps to a rejection. A manifest over the limit becomes `MANIFEST_INVALID` and an SBOM over the limit becomes `MANIFEST_MISMATCH`. Other provider errors still propagate, so a transient outage is retried and not rejected.
- `settle` now rejects an overdue build it still cannot decide as `DEPENDENCY_UNAVAILABLE` (retryable). It still rethrows `ConflictError`, so a stale settle cannot overwrite a decision.

## B2 (purge liveness): fixed, with a bound to note

The fix has three parts:
- **Reclaiming building records.** An expired `building` record is cancelled, rejected `BUILD_TIMEOUT` by CAS and purged by a later sweep. A concurrent `settle` that wins the CAS makes the reclaim `skipped`. Cancelling the build first is harmless, because an expired record is at least 90 days old.
- **A stable sweep order.** The sweep pages by a `(retainUntil, workspaceId, artifactId)` cursor. The memory store and PostgreSQL (`COLLATE "C"` row comparison) use the same order, and the new conformance case runs on both with a `retainUntil` tie.
- **No more stuck head of the queue.** Rows that are skipped or fail no longer stay at the front of the expired set within a sweep.

**Bound.** Each sweep starts at the head again and examines at most `10 × limit` rows. Rows whose provider deletes keep failing therefore still starve later rows once there are at least `10 × limit` of them (1,000 at the default limit). My repro used `limit: 2`, so 20 rows are examined per sweep:

```text
bad=19 limit=2 (scan 20) … good purged after 3 sweeps: true
bad=20 limit=2 (scan 20) … good purged after 3 sweeps: false
```

The remaining rows that never make progress are tombstones whose image or object deletes fail every time; a customer cannot create them through any normal path. This is acceptable for M11.

However, the BUILDS sentence that such rows "cannot starve the rest" is too strong. It should say "up to `10 × limit` such rows". M16 should alert on a non-zero `failed` count, or persist the cursor between sweeps. This is non-blocking finding N1.

## Findings from the first review

| # | Status |
|---|---|
| 1 | Fixed. Orphan cleanup keeps any image whose tag is a recorded artifact ID. Using the tag only to *keep* an image is safe. The repro now reports `deleted: 0`. |
| 2, 3, 9, 11 | Written down accurately in BUILDS: the provenance field coverage, the M12 per-attempt lease, log confidentiality under a container escape, the logs-bucket backstop, repository-wide orphan listing for M16, and manifest `appId`/catalog handling for M13. |
| 4 | Fixed. Both suites now fail on any expected case that was not recorded. |
| 5 | Fixed. A real `timeout` exit (124, or 137 once 420 s have elapsed) is reported as `BUILD_TIMEOUT`, and an OOM kill stays `BUILD_FAILED`. The memory-hog adversary checks the OOM case. The timeout itself is still unit-tested only, as recorded. |
| 6 | Fixed. A 400, 403 or 5xx from the source fetch is retryable, and only a 404 is `SOURCE_INVALID`. Read access is capped at an unpinned source's `retainUntil`. A build with less than a minute of source retention left throws `SOURCE_INVALID` from `start`/`settle`; such a record is then reclaimed by the B2 path when it expires. |
| 7 | Fixed. All three providers truncate logs instead of refusing them, and known values are redacted before truncation. |
| 8 | Fixed in the memory store, but **B3** in PostgreSQL (below). |
| 10 | Fixed. `devEngines` is rejected, and prepare passes `--config.manage-package-manager-versions=false`. |

## Blocker

### B3. The PostgreSQL store refuses legitimate retention updates of an admitted artifact

**Cause.** `artifactTransitionAllowed` (in `build-admission.ts`) freezes a settled decision by comparing `JSON.stringify(next.manifest)` with `JSON.stringify(prior.manifest)`, and does the same for `provenance`. In `PostgresGatewayStore.updateArtifact`:
- `prior` comes from the `document` **jsonb** column, and jsonb reorders object keys (shorter keys first, then by byte order);
- `next` is whatever the caller passes, usually the JavaScript-ordered object that `updateArtifact` returned when `settle` admitted the artifact.

The two strings differ even though the values are equal. So the store throws `BadRequestError("Artifact identity and decision are immutable")` on a write that only changes `pinnedBy`.

**Repro** (`m11-final-bd10e10-pg-freeze.mjs`, real PostgreSQL 16, disposable fixture). It runs build, admit with a manifest and provenance, then pins:

```text
pin of returned record: BadRequestError Artifact identity and decision are immutable
pin of re-read record: ok rel_aaaaaaaa
```

**Impact:**
- The documented contract ("only retention fields may change") is broken on the production store only. The memory store accepts the same write, and so do the unit test (`finding 8`, memory) and the shared conformance case (whose admitted record has no `manifest` or `provenance`, so both sides stringify to `undefined`). All of them pass.
- M13 pins an artifact when a release references it. The natural call is `updateArtifact({ ...admitted, pinnedBy }, admitted.revision)` with the record `settle` returned, and on PostgreSQL that refuses the pin.
- It fails closed: no decision can be rewritten. But it would block promotion, or push M13 into re-read workarounds.
- No M11 path is affected today, because `purgeArtifacts` updates records it has just read back from the store.

**Fix:**
- Compare `manifest` and `provenance` with the gateway's existing order-independent `canonical()` (or a deep-equal), not `JSON.stringify`.
- Extend the shared artifact-store conformance case so the admitted record carries a `manifest` and `provenance`, and pin it **using the object `updateArtifact` returned**. That case fails on `bd10e10` with PostgreSQL.

## Non-blocking findings

- **N1.** Reword the BUILDS claim that rows the sweep skips or fails on "cannot starve the rest", as described under B2. M16 should alert on `failed`, or persist the cursor between sweeps.
- **N2.** `settle` rejects any build it cannot decide once 20 minutes have passed since the record was created, so a single transient provider or storage error at the first late `settle` rejects the attempt. The code is retryable, so M12 starts another attempt and pays for another build. That is acceptable. M12 should still settle promptly and treat `DEPENDENCY_UNAVAILABLE` here as a new attempt, not a user error.
- **N3.** `artifactTransitionAllowed` does not freeze `finishedAt`, and it allows any field to change while a record is `building` (identity apart). Both are harmless today.

## Required for acceptance

1. Fix B3 and add the conformance regression on both stores.
2. Re-run `pnpm test:gateway-store` and `pnpm test:mvp`. `test:m11` and a live run are not needed, because the fix touches only the store comparison.
3. Green exact-candidate CI on Node 22 and 24, then a focused re-review of the B3 diff.
