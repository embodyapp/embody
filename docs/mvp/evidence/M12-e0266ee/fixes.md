# M12 fixes for the independent review of `e0266ee`

Review: [independent-review.md](./independent-review.md) (REJECTED: B1). Fix branch `fix/m12-source-retention`, based on `e0266ee`.

The fix was written by the reviewing session at the owner's request. A focused re-review by a **different** session is still required: the reviewer of this fix must not be its author.

## Blocker

| Item | Fix | Regression |
|---|---|---|
| **B1** deployment source pins never expire and fill the workspace's 100 MiB source quota permanently | **Submission** no longer pins. `decideSubmit` only extends the source's `retainUntil` to the deployment's retention (90 days, MD15), under the same revision CAS that refuses purge tombstones. The PostgreSQL submission no longer sets `pinned=true`. The source sweep and the quota (`retain_until > now OR pinned`) therefore release the source when the retention ends, whatever the deployment's outcome. **Promotion** pins the source to the release (`pinnedBy = releaseId`, `pinned=true`) in the same transaction as the release row, the catalog CAS and the artifact pin. The lock order is workspace, deployment, artifact, then source. If the source is gone or is a purge tombstone, the deployment fails `DEPENDENCY_UNAVAILABLE` (`SOURCE_MISSING`) instead of promoting. Both stores share one rule, `releaseSourceUsable` in `deployment.ts`. | Store conformance, run on memory (`deployment.test.ts`) and **PostgreSQL** (`test:gateway-store`). "review B1: deployed source leaves the quota when its deployments' retention ends": 10 × 10 MiB deployments, all cancelled. A 1-byte upload is refused at +1 day, inside the retention. After the retention ends, the sweep deletes all 10 sources and the upload succeeds. "promotion pins the release's source, and fails closed when that source is gone". The promotion-race case now also checks that the winner's release pins the shared source and that a sweep at +400 days keeps it. "M02.b" now checks that submission retains the source without pinning it. The PostgreSQL rolled-back cases (early task and SIGKILL after enqueue) now also check the source's revision and `retainUntil` are unchanged, since `pinnedBy` alone is no longer a meaningful check. All four conformance cases fail on `e0266ee`'s `deployment.ts`/`store.ts` and pass with the fix. |

**Policy note for the owner (no change made).** The quota still counts deployment-retained source for 90 days, as MD15 decides. A workspace that deploys more than 100 MiB of distinct source within 90 days is refused new uploads until older deployments' retention ends. It is no longer locked out permanently. At the cost model's 100 deployments a month, that limit is about 0.34 MiB per average source. If real sources are larger, raise the quota or shorten the retention of source referenced only by failed or cancelled deployments. Either is a contract change for the owner.

## Non-blocking findings

| # | Disposition |
|---|---|
| 1–6 | Not changed by this fix; still open as listed in the review. |
| 7 | Partly addressed: DEPLOYMENTS now lists deleting deployment and release rows past retention under M16, and no longer lists source unpinning there (nothing needs unpinning). M13's line now says a source shared by several releases is pinned by the newest, so unpinning must check that no retained release references it. |

## Docs

- DEPLOYMENTS: submission step 3 (retention, not a pin), promotion (the release pins its source; `SOURCE_MISSING`), the local crash table, and the M13 and M16 lines.
- SOURCES: the MD15 paragraph's implementation pointer (the decision itself is unchanged), and the bucket lifecycle backstop note.

## Verification (clean tree at `fbf3e9c`, `dirty: false` in every evidence JSON, Node 24.21.0, fresh disposable Compose project `embody-m12-review-e0266ee`)

| Command | Result |
|---|---|
| `pnpm verify` | passed (lint, license, typecheck, tests, build, API report, format). Run without DB variables, so the optional DB tests skip by design; the mandatory DB gates below run them |
| `pnpm test:verification` | 101 passed, 0 skipped |
| `pnpm test:postgres` | 16 passed, 0 skipped |
| `pnpm test:gateway-store` | **68** passed, 0 skipped (+2 review-B1 cases on PostgreSQL) |
| `pnpm test:mvp` | **602** passed, 0 skipped: postgres 16, gateway-store 68, cloud-contracts 106, auth 6, host 113, MCP 18, gateway 259, CLI 16 |
| `pnpm test:m12` | **127** passed, 0 skipped (+2 review-B1 cases on the memory store) |

No live run: the fix stays inside `decideSubmit`, the promotion transaction and the store queries, and no live case exercises source retention. The live suite's rolled-back case still checks `pinnedBy`, which is now always absent after a submission. Its primary check (no deployment row) is unaffected, but its source check becomes weak. Change it to compare `retainUntil` when the live suite next changes.
