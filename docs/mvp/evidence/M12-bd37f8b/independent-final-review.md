# M12 durable deployment controller: independent re-review of the B1 fix, candidate `bd37f8b`

**Candidate:** `bd37f8b` (draft PR [#53](https://github.com/embodyapp/embody/pull/53), branch `feat/mvp-m12-deployment-controller`). **Diff:** `e0266ee..bd37f8b`, three commits:
- `1c01312`: the [`e0266ee` review](../M12-e0266ee/independent-review.md), docs only (1 file);
- `fbf3e9c`: the fix (`deployment.ts`, `store.ts`, a comment in `deployment-routes.ts`, the deployment store conformance, the fixture and the PostgreSQL controller test, plus DEPLOYMENTS, SOURCES, STATUS, TESTING and [fixes.md](../M12-e0266ee/fixes.md));
- `bd37f8b`: the verification counts in fixes.md, docs only (1 file).

`git diff --stat e0266ee..bd37f8b` lists 12 files (+472/−98), exactly those above. No other product file changed.

**Scope:** B1 of the `e0266ee` review and any new defect the diff introduces. Everything else was confirmed on `e0266ee` and is unchanged.

**Reviewer:** a separate read-only session. It wrote neither the M12 code, nor the fix, nor the `e0266ee` review.
- Runs used Node 24.21.0 and pnpm 11.25.0 on a clean detached checkout of the exact candidate.
- The disposable M03 fixture used Compose project `embody-m12-rereview-bd37f8b` on loopback port 55731. It was removed with `down --volumes --remove-orphans`.
- `embody-m12-verification` and the `embody-local-*` services were not touched.
- No cloud resources were created, no money was spent and the live suite was not run.
- No product code was changed. The temporary restore in "Regressions are real" was reverted, and the tree was checked clean. This file is the only tracked change.
- The scratch probe (`repin-and-column.mjs`) and all logs are in the session notes folder.

## Verdict: **ACCEPTED**

B1 is fixed in both stores, and no new defect was found. The regressions fail on `e0266ee`'s code and pass on the candidate. Every local gate reproduces the counts in fixes.md with zero skips. Exact-candidate CI on `bd37f8b` passed all 9 checks.

Under the tracker rules, M12 can be marked DONE. The non-blocking notes below should go to M13 and M16.

## B1: fixed

**Submission retains the source without pinning it.**
- `decideSubmit` no longer sets `pinnedBy`. It returns `{...source, retainUntil: max(source.retainUntil, now + 90 d)}`.
- The existing guards still run first: a tombstone (`purging`), a foreign workspace or app, an unverified source, a digest or size mismatch, or an expired unpinned source gives `INVALID_INPUT`.
- **Memory store:** the write runs inside the store's serial transaction, after the wake hook. A hook failure therefore writes nothing.
- **PostgreSQL store:** the source row is locked `FOR UPDATE` under the workspace lock. It is then updated with `SET retain_until, revision, document … WHERE revision=$3 AND NOT purging`, with `rowCount ≠ 1 → INVALID_INPUT`. The `pinned` column is no longer touched.
- `...source` carries an existing `pinnedBy` through, so a source already pinned by a release keeps its pin when it is redeployed. The PostgreSQL column stays `true`, because it is not written.

**The quota and the sweep release the source after the retention.**
- No quota or sweep query changed. Memory counts `retainUntil > now || pinnedBy`, and PostgreSQL counts `retain_until > $now OR pinned`. `expiredSources` and `deleteSource` exclude pinned rows in both stores.
- Submission no longer sets either flag. A deployed source that was never promoted therefore leaves the quota at `retainUntil`, the sweep fences it and deletes it, and this holds whatever the deployment's outcome was.

**Promotion pins the source to the release atomically.**
- **Memory store:** the source is pinned (`pinnedBy = releaseId`, revision + 1) in the same serial transaction as the release, the catalog CAS and the artifact pin.
- **PostgreSQL store:** the source row is locked `FOR UPDATE` after the workspace, deployment and artifact locks. `releaseSourceUsable` checks that the source:
  - exists and is not `purging`;
  - has the deployment's workspace, app and upload ID;
  - is `verified`;
  - has the submitted digest and bytes.

  The source is then updated with `SET pinned=true, revision, document(pinnedBy=releaseId) WHERE revision=$5 AND NOT purging` (`rowCount ≠ 1 → ConflictError`). This runs in the transaction that inserts the release, CASes the catalog, pins the artifact and writes the deployment. A conflict rolls all of it back.

**Fail-closed.**
- If the source is missing or is a tombstone, the outcome becomes `fail DEPENDENCY_UNAVAILABLE / SOURCE_MISSING`. The decision then goes through the normal `decideComplete` path, so no release is written and the catalog does not move.
- The artifact stays unpinned, so M11's sweep reclaims it.
- In practice this cannot happen to an honest deployment. The source's `retainUntil` is at least submission + 90 days, the deployment deadline is 2 hours, and the sweep only fences expired, unpinned records. The check is a guard, not a reachable failure mode.

**Lock order.** Every PostgreSQL transaction that takes more than one of these locks takes the workspace lock first:
- submission: workspace, source;
- promotion: workspace, deployment, artifact, source;
- source admission: workspace, then the source upsert;
- catalog writes and quota admission: workspace.

Claims and non-promoting completions lock only the deployment row. `purgeExpiredSources`, `updateSource` and `deleteSource` are single-row autocommit statements: they wait on a held row lock but never hold one while acquiring another. There is no cycle, so no deadlock is possible between promotion, submission, source admission and the sweep.

A sweep that listed a source before promotion loses its CAS: the revision moved and the row is now pinned. It reports `skipped`. A sweep that fenced first makes promotion fail closed, as above.

**No new liveness or retention defect.**
- The fix adds no new state and no new record kind.
- `SOURCE_MISSING` is a terminal failure on the existing cleanup path, like `ARTIFACT_MISSING`.
- A failed or cancelled deployment's source is reclaimed after 90 days.
- A promoted source is pinned only as MD15 says (an active release keeps its source indefinitely).
- No path leaves a record that nothing reclaims, unless a release still pins it. That case is note N1.

**What else the fix could break, checked:**
- **The validating stage.** `verifySubmissionSource` accepts the source, because the record is unexpired (retention extended), verified and not a tombstone. The `test:m12` controller paths pass.
- **The M11 build read URL** (`build-admission.ts` `ensureSubmitted`). It caps expiry at `source.retainUntil` for an unpinned source. That value is now at least submission + 90 days, so the cap never binds before the read lifetime. The behaviour is the same as on `e0266ee`, which also extended `retainUntil`. The M11 hardening cases in `test:m12` pass.
- **The PostgreSQL `pinned` column against the document's `pinnedBy`.** Submission writes neither and preserves both. Promotion writes both together. The generic `updateSource` derives the column from the document. The probe below confirms the two agree after every step.
- **The PostgreSQL rolled-back submission cases** (early task, SIGKILL after enqueue). These now assert that the source's revision and `retainUntil` are unchanged. That is the meaningful check now that `pinnedBy` is always absent after a submission.

## Probe (session notes, `repin-and-column.mjs`, run against the built `dist`)

The probe runs on both the memory store and real PostgreSQL 16 (the disposable fixture):
1. Promote deployment 1, which pins the source to release A.
2. Redeploy the same source 200 days later, then cancel.
3. Sweep at +800 days.
4. Redeploy and promote again.
5. Run a separate deployment that fails.

```text
== postgres
ok   after submit 1: PG pinned column == Boolean(document.pinnedBy) {"pinned":false,"by":null}
ok   source pinned by relA rel_repina00001
ok   after promote 1: PG pinned column == Boolean(document.pinnedBy) {"pinned":true,"by":"rel_repina00001"}
ok   redeploy keeps relA pin rel_repina00001
ok   after submit 2: PG pinned column == Boolean(document.pinnedBy) {"pinned":true,"by":"rel_repina00001"}
ok   release-pinned source survives +800 d sweep
ok   re-promotion pins to newest release rel_repinb00001
ok   old release still references the shared source (M13 must check before unpinning)
ok   failed deployment leaves source unpinned failed undefined
ok   after failed deployment: PG pinned column == Boolean(document.pinnedBy) {"pinned":false,"by":null}
ALL OK
```

The memory leg passes the same checks.

## Regressions are real

Procedure:
1. Restore `e0266ee`'s `packages/gateway/src/deployment.ts` and `store.ts`.
2. Rebuild the gateway.
3. Run `pnpm exec vitest run packages/gateway/test/deployment.test.ts`.

Result: **4 failed, 27 passed (31)**.

| Case | Failure on `e0266ee` code |
|---|---|
| M02.b (submission retains, does not pin) | `pinnedBy` is `dep_…`, expected `undefined` |
| promotion CAS (winner's release pins the shared source) | `pinnedBy` is `dep_…`, expected `rel_releasea0001` |
| review B1: deployed source leaves the quota after retention | source still present after the sweep (never purged) |
| promotion pins the release's source, fails closed when gone | deployment promoted instead of `failed SOURCE_MISSING` |

After restoring with `git checkout -- packages/gateway/src` and rebuilding: 31/31 pass, and the tree is clean. The same cases run on PostgreSQL in `test:gateway-store` (68 below).

## Reproduction (exact candidate, clean tree, Node 24.21.0)

| Command | Result |
|---|---|
| `pnpm test:verification` | passed **101**, 0 skipped |
| `pnpm test:postgres` | passed **16**, 0 skipped |
| `pnpm test:gateway-store` | passed **68**, 0 skipped |
| `pnpm test:mvp` | passed **602**, 0 skipped: postgres 16, gateway-store 68, cloud-contracts 106, auth 6, host 113, MCP 18, gateway 259, CLI 16 |
| `pnpm test:m12` | passed **127**, 0 skipped (5 files) |

All counts match fixes.md. Every evidence JSON (`postgres`, `gateway-store`, `mvp`, `m12`) records commit `bd37f8b2ff3b581076ba6cfdc74572a619a0c547`, `dirty: false`, failed 0 and skipped 0.

**Exact-candidate CI:** run [39417337107](https://github.com/embodyapp/embody/actions/runs/39417337107) on `bd37f8b` completed with `success`. All 9 checks passed:
- `quality` (22) and (24);
- `postgres-matrix` (22) and (24), which run `test:m12`;
- `postgres`;
- `e2e-artifacts-matrix` (22) and (24);
- `e2e-artifacts`;
- `terraform`.

## Non-blocking notes

- **N1. Superseded releases keep their source pinned until M13, and IMPLEMENTATION does not say so.**
  - A promoted source stays pinned (`pinnedBy` = newest release) and keeps counting toward the 100 MiB quota until something unpins it. This is correct for an active release under MD15. MD15 bounds an *inactive* release at 30 days, though, and only DEPLOYMENTS' "later tasks" list assigns that unpinning to M13.
  - IMPLEMENTATION M13's steps say "retain rollback images/config references", not "release them".
  - So a workspace that promotes more than 100 MiB of distinct source would again be locked out of uploads until M13 lands. No customer path reaches this before M13, because the CLI deploy (M14) depends on M13.
  - The class is the one that rejected `e0266ee`, so it should not rely on DEPLOYMENTS alone. **Fix:** add to IMPLEMENTATION M13 (step 4 or 5, plus an acceptance check) that M13 unpins the artifact and source of releases past their inactive retention. A shared source may be unpinned only when no retained release references it; the probe shows `pinnedBy` names only the newest release.
- **N2. A memory-store read/write gap, unreachable.**
  - `MemoryGatewayStore.completeDeployment` reads the source before `await wake(...)` and writes the pinned copy after it. Source writes (`updateSource`, `admitSource`, the sweep) do not go through the memory store's serial `transaction`.
  - A sweep fence that interleaved there would be overwritten. The fence requires an expired source, and that cannot happen within the 2-hour deployment deadline, so the gap is unreachable.
  - The memory store is not the production store, and the same pattern already existed for the artifact pin and for submission.
  - **Optional fix:** re-read the source after the hook.
- **N3. Rows from `e0266ee` are not migrated.** Rows submitted under `e0266ee` keep `pinned=true` with `pinnedBy=dep_…`, and nothing migrates them. The live run's environment was torn down, so no persistent database holds such rows. Confirm this before any shared environment is reused.
- **N4. The conformance suite lacks two of the probe's checks.** It does not cover a redeploy of a release-pinned source, or the agreement between the PostgreSQL `pinned` column and `pinnedBy`. Both are cheap to add from the probe above.
- **N5. The live suite's rolled-back case still checks `pinnedBy`.** fixes.md already records this: compare `retainUntil` when the live suite next changes.
- **N6. The quota policy note in fixes.md is correct.** Deployment-retained source counts for 90 days, which is about 0.34 MiB per average source at the cost model's 100 deployments a month. This is an owner policy question, not a defect.
- Findings 1–7 of the `e0266ee` review are unchanged and remain open as recorded there. Finding 7 is partly addressed in DEPLOYMENTS.
