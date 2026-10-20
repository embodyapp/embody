# M12 durable deployment controller: independent review of candidate `e0266ee`

**Candidate:** `e0266ee` (draft PR [#53](https://github.com/embodyapp/embody/pull/53), branch `feat/mvp-m12-deployment-controller`, stacked on #50 at `148df4f`). The live run `f45104` used `5c65312`. `5c65312..e0266ee` changes only `STATUS.md`, `TESTING.md` and the live evidence folder, so the live evidence applies to the candidate's code. **Diff:** `148df4f..e0266ee` (44 files, +7,713/−162). **Scope:** M12 steps 1–6 and acceptance cases M12.a–d in [IMPLEMENTATION](../../IMPLEMENTATION.md#m12--durable-deployment-controller), checked against [VERIFICATION](../../VERIFICATION.md), the [STATUS](../../STATUS.md) tracker rules, the [DEPLOYMENTS](../../DEPLOYMENTS.md) contract and MD15 ([SOURCES](../../SOURCES.md#source-retention)).

**Reviewer:** a separate read-only session, not the author.
- Local runs used Node 24.21.0 and pnpm 11.25.0 on a clean detached checkout of the exact candidate.
- The disposable M03 fixture used Compose project `embody-m12-review-e0266ee` on loopback port 55721 and was removed afterwards with `down --volumes`. Another session's `embody-m12-verification` fixture and the `embody-local-*` services were not touched.
- No cloud resources were created, no money was spent and the live suite was not re-run.
- No product code was changed; this file is the only tracked change.
- The repro script (`b1-pinned-source-quota.mjs`) and its output are in the session notes folder. It runs against the candidate's built `dist` with the memory store.

## Verdict: **REJECTED**

The controller design is sound and the evidence holds up:
- The deployment row is the job.
- Every write enqueues its wake before COMMIT.
- Claims are leased and epoch-fenced.
- Completions re-check the claim and the app.
- Promotion is a CAS under the workspace lock.
- Cancellation advances the epoch, and stale workers clean up after themselves.
- Recovery is bounded and needs no gateway timer.
- Ingress authenticates before it parses the body.

I found no stuck state, unreclaimed lease or recovery starvation in the controller itself. Every local suite reproduces with zero skips, and the exact-candidate CI is green.

One blocker remains. It is the same retention-liveness class that sent M10 and M11 back:

1. **B1:** M12 pins every deployed source forever. Pinned sources count toward the workspace's 100 MiB source quota, so ordinary use permanently locks a workspace out of source uploads. This also contradicts MD15's 90-day retention for deployment-referenced source.

## Reproduction (exact candidate, clean tree, Node 24.21.0)

| Command | Result |
|---|---|
| `pnpm test:verification` | passed **101**, 0 skipped |
| `pnpm test:postgres` | passed **16**, 0 skipped |
| `pnpm test:gateway-store` | passed **66**, 0 skipped (includes 10 deployment-store conformance cases on PostgreSQL) |
| `pnpm test:mvp` | passed **598**, 0 skipped: postgres 16, gateway-store 66, cloud-contracts 106, auth 6, host 113, MCP 18, gateway 257, CLI 16. Matches [TESTING](../../TESTING.md) and [M12-local](../M12-local.md). |
| `pnpm test:m12` | passed **125**, 0 skipped (5 files: controller, real-PostgreSQL controller and SIGKILL matrix, M11 admission and hardening, shared tasks, M20 durable host) |

The evidence JSON for each gate records commit `e0266ee`, `dirty: false`.

**Exact-candidate CI:** run [39381036803](https://github.com/embodyapp/embody/actions/runs/39381036803) on `e0266ee` passed all 9 checks: `quality` 22/24, `postgres-matrix` 22/24, `postgres`, `e2e-artifacts-matrix` 22/24, `e2e-artifacts` and `terraform`. `test:m12` runs in both `postgres-matrix` legs.

## Blocker

### B1. Deployment source pins never expire and fill the workspace source quota permanently

**What the code does:**
- `decideSubmit` pins the source: `pinnedBy ??= deploymentId`, and `retainUntil = max(source, now + 90 d)` ([deployment.ts](../../../../packages/gateway/src/deployment.ts) `decideSubmit`).
- The PostgreSQL store writes `pinned=true` in the submission transaction.
- Nothing in M12, or in any later task's plan, ever clears the pin. That includes failed and cancelled deployments.

**Why this blocks uploads:**
- The retained-source quota counts **every pinned record, whatever its `retainUntil`**:
  - memory: `Date.parse(r.retainUntil) > now || r.pinnedBy` ([store.ts](../../../../packages/gateway/src/store.ts) in `admitSource`);
  - PostgreSQL: `sum(bytes) FILTER (WHERE retain_until>$4 OR pinned)`.
- The source sweep skips pinned records (`WHERE … AND NOT pinned`), so the bytes are never freed.
- Before M12, a verified source left the quota after 7 days (MD15). With M12, every source that is ever submitted stays in the 100 MiB quota permanently.

**Repro** (memory store; 10 deployments of maximum-size 10 MiB sources, each cancelled at once so the 3-per-app active limit never applies; then the clock jumps 400 days):

```text
purge at +400 d: {"deleted":0,"failed":0,"skipped":0}
new 1-byte source after +400 d: SourceAdmissionError LIMIT_EXCEEDED
```

The workspace can never upload source again, so it can never deploy again. There is no API to release the pin, and the runbook forbids editing rows by hand.

**Reachable in normal use.** No adversary is needed. The cost model in [DEPLOYMENTS](../../DEPLOYMENTS.md#cost) assumes 5 apps × 20 deployments a month per workspace. At that rate:
- 1 MiB sources fill the quota in about a month;
- 200 KiB sources fill it in about five months.

Failed and cancelled deployments count too, so a run of failing builds fills the quota faster.

**Contract mismatch.** MD15 (owner approved) says deployment-referenced source is "kept as long as that deployment (90 days)", and released source as long as the release. M12 implements "forever". DEPLOYMENTS defers "unpin sources no deployment or release references" to M16. But M16's steps in IMPLEMENTATION do not include it, and M16 depends on M13 and M15. Until then, every M13/M14 development journey accumulates permanent pins.

**Fix (any equivalent is fine):**
- Make a deployment pin time-bounded. For example, extend `retainUntil` to the deployment's `retainUntil`, and have the quota and the sweep honor it. Keep the boolean `pinned` (indefinite) only for release pins. Alternatively, store `pinnedUntil` and treat an expired deployment pin as unpinned in both the quota query and the sweep, in both stores.
- Because promotion is M12's transaction, pin the source to the **release** there, next to the artifact pin. Otherwise, the fix above would delete an active release's source after 90 days, which contradicts MD15.
- Add regressions in the store conformance (memory and PostgreSQL):
  - a failed or cancelled deployment's source leaves the quota and is purged after the deployment's retention;
  - a promoted deployment's source stays pinned;
  - a workspace that has deployed more than 100 MiB of source over time can still upload.

## Non-blocking findings

Each finding is numbered so a fix can cite it.

1. **A timed-out handler skips stale cleanup.** `run()` returns `timed-out` on `DeadlineError` without calling `abandonIfEnded`. Suppose a deployment is cancelled while its stage is still running past the 45 s deadline (a slow `start` or, in M13, a slow `provision`). The cleanup wake may then run before the stage creates its build or candidate, and nobody removes that resource afterwards. Builds are bounded by the provider timeout and M11's reclamation of `building` records. Candidates depend on an M13 orphan sweep. **Fix:** after the background stage settles, run `abandonIfEnded`. Or have M13 record this as an obligation of its orphan sweep.
2. **Follow-up task names can collide with themselves.** `followUpTaskName` hashes `(…, reason, txid, target)` without the epoch or a hop count. Take a follow-up task that arrives early (worker clock behind the queue's) and re-arms for the same target. Its second-generation re-arm hashes to its own name. Cloud Tasks returns `409`, the adapter maps it to `duplicate`, and the wake is silently dropped. Only MD12 recovery, run on a later task or request, heals it. This is unlikely because it needs repeated early dispatch, but it is cheap to fix: add a hop counter or the delivery time to the name.
3. **Recovery does not run on a refused submission.** `recover(workspace)` runs only after a successful submit or status read. A workspace whose deployments lost their tasks sits at the active limit (3 per app, 10 per workspace) with stuck nonterminal rows. Its submissions then get `429` without healing anything, and only a status read of a specific deployment recovers it. **Fix:** run `recover` in a `finally` on submit as well.
4. **The live bound checks are loose.** `evaluateDeployment.withinBound` compares against the 40-minute `deploymentWaitMs`, not the documented recovery bounds:
   - lease + 1 s plus delivery after a worker death;
   - at most 300 s after a queue resume.

   The recorded facts are consistent with those bounds: 404 s for a chain with two lease-wake recoveries, and 20 s from resume to active. The local suite asserts lease + 1 s with a controlled clock. M12.c is therefore met, but the live suite does not enforce it. **Fix:** assert the per-recovery bounds the next time the live suite changes.
5. **Generation is conservative.** Every catalog write advances `generation`, and every completion fails an in-flight deployment `STALE_GENERATION` when it moves. Today only operator fixtures write the catalog, so this has no effect yet. M13 and M15 must not move runtime state (`idle`/`ready`/`unavailable`) through a generation-bumping write. Otherwise no deployment of an app in use could finish. Record this in WORKSPACES or DEPLOYMENTS as an M13 obligation.
6. **The worker's grants are broader than the documented table.** The DEPLOYMENTS identity table says "delete on the builds repository and outputs bucket, read on outputs and logs". The live worker holds `artifactregistry.repoAdmin` on the builds repository and `storage.objectAdmin` on both the outputs and the logs bucket. That allows writing and deleting every tenant's build logs. The live IAM check pins these roles exactly, so this is a least-privilege and documentation gap, not a test gap. **Fix:** narrow the roles to what the table states (for example, `objectViewer` on logs), or name the roles in the table.
7. **Unbounded retention of rows.** Deployment and release rows are never deleted, even though deployments carry `retainUntil` (90 d). DEPLOYMENTS hands this to M16. This is acceptable because the rows are small and nothing counts them toward a quota, but it belongs in M16's plan together with B1's unpinning, not only in DEPLOYMENTS.

## What was checked and holds

**Step 1 (submission):**
- One transaction under the workspace lock, in this order: idempotency replay or conflict by fingerprint (before any app or source check), then app existence, enabled state and generation, then the source re-checked under `FOR UPDATE` and pinned by a revision CAS that refuses tombstones, then the row insert, then the wake enqueued before COMMIT.
- A queue failure rolls everything back (`503`, nothing persisted).
- Retried transactions get new task names through `txid_current()`.
- The gateway answers `202` and waits for no build.

**Step 2 (delivery, leases, fencing):**
- A claim locks the row, checks due and lease, advances the epoch, writes a 180 s lease and a lease wake at lease + 1 s, all in one transaction.
- A completion is rejected unless the epoch, the lease token and a nonterminal state all match.
- Early tasks (`txid_status` in progress) answer `503`; rolled-back tasks are no-ops.
- Leased or early tasks re-arm only when they are the newest wake for that epoch; older ones are dropped as `superseded`, so tasks do not fan out.
- The worker holds no timer: the handler deadline only abandons the request, and the lease covers the stage.
- Provider calls are individually bounded (Cloud Build 15 s, queue 5 s, DB 5 s), which supports the lease margin.

**Liveness:** I traced every path a recovered row can take and found no stuck state:
- a row is overdue only when its due time passed more than 60 s ago and it has no live lease;
- a claim on such a row always advances it, settles it or leases it, and a lease expires in 180 s;
- cleanups are bounded at 10 attempts;
- consecutive lost claims become `WORKER_LOST` after 3, and attempts fail visibly after 3;
- the 2-hour deadline fails any later claim.

So recovery's oldest-first batch of 10 cannot be pinned by unprogressable rows, the starvation shape of M11 B2.

**Step 3 (authorization at transitions):**
- Task bodies are strict, at most 1 KiB, and carry no URLs, headers or resource names.
- Lookups are keyed by `(workspace, deployment)` plus the app.
- Every completion re-reads the catalog app (status, lifecycle fence, generation).
- Promotion re-validates the artifact under lock (admitted, not purging, same deployment and app) and evaluates `canPromote`.
- The routes require exact grants and never reveal foreign apps or deployments.

**Step 4 (idempotent provisioning, promotion, cancellation):**
- After a crash, the build is adopted by its unguessable tag.
- Candidates are named from platform records and removed only when their ownership labels match.
- Promotion serializes on the workspace lock, then the deployment and artifact rows: one release, generation + 1, artifact pinned.
- Cancellation is fenced, advances the epoch, clears the lease and is idempotent.
- A stale worker that lost to cancellation abandons its build and candidate (except finding 1).

**Step 5 (limits):** `DEPLOYMENT_LIMITS` is executable and matches DEPLOYMENTS. The 28-minute bound for a stage whose worker keeps dying checks out arithmetically.

**Step 6 (shared ingress):**
- `cloudTasksQueue` fixes the target, audience and invoker at construction.
- `authenticateTask` takes one bearer token of at most 4 KiB, verified for Google's issuer and keys, the exact audience, the exact verified email and a lifetime of at most an hour.
- It runs in `onRequest`, before body parsing.
- M20's drain now uses the same path, and the M20 suite passes inside `test:m12`.

**Acceptance cases:**
- **M12.a:** the eight SIGKILL points in `deployment.postgres.test.ts` match the evidence table, each case asserting one active deployment, one build, one candidate, generation + 1 and no pending tasks. Live, all three planted faults fired and Cloud Tasks redelivered to new instances. The lost-task and rolled-back cases also passed live.
- **M12.b:**
  - nine deliveries across three pools;
  - five concurrent deliveries in memory;
  - two deployments racing to promote, locally and live on two instances;
  - cancellation racing promotion on separate connections;
  - live cancellation during a build: provider `CANCELLED`, artifact `CANCELLED`.
- **M12.c:**
  - the gateway is closed after the `202` and the worker alone reaches `active`;
  - lease-wake replacement is asserted locally;
  - a live queue pause held the deployment for 2 minutes, and it recovered 20 s after resume;
  - a create-side queue outage is local only, as documented.
- **M12.d:**
  - forged, foreign, expired, over-long and header-only requests are refused locally;
  - live, the worker refused anonymous, operator, wrong-audience and other-identity tokens;
  - malicious bodies get `400` and a foreign workspace finds nothing, with no state change.

**Live evidence and cost:**
- The JSON matches the README: 10/10 cases, `dirty: false`, 6 builds, 7.1 build-minutes, $0.53 conservative for this run.
- The case set is fixed, and cleanup and project IAM were checked.
- The five-run total of ≈ $2.49 conservative is within the approved $6. The invoice check is still open.
- The running delta of ≈ $0.17/month is plausible.

## Required for acceptance

1. Fix B1 with the regressions listed above, in both stores, including pinning the source to the release at promotion.
2. Re-run `pnpm test:mvp`, `pnpm test:gateway-store` and `pnpm test:m12`, with zero skips.
3. A new live run is **not** required if the fix stays inside `decideSubmit`, the promotion transaction and the store quota and sweep queries. The live cases do not exercise source retention.
4. Green exact-candidate CI on Node 22 and 24, then a focused re-review.

Findings 1–3 are cheap to fix alongside B1 and are recommended. Findings 4–7 can be tracked for M13 and M16.
