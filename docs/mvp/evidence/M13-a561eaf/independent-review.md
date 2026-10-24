# M13 provision, migrate, promote and roll back: independent review of candidate `a561eaf`

**Candidate:** `a561eaf` on `feat/mvp-m13-provision-promote` (draft PR [#54](https://github.com/embodyapp/embody/pull/54), stacked on #53). **Diff:** `33bcc62..a561eaf` (45 files, +7,435/−171). The branch tip `b5ce88b` adds only `docs/mvp/STATUS.md`, `docs/mvp/TESTING.md` and `docs/mvp/evidence/M13-local.md` on top of `a561eaf` (`git diff --stat a561eaf..origin/feat/mvp-m13-provision-promote`: 3 files, docs only), so the code is identical. **Scope:** M13 steps 1–6 and acceptance M13.a–e in [IMPLEMENTATION](../../IMPLEMENTATION.md#m13--provision-migrate-promote-and-roll-back), checked against [VERIFICATION](../../VERIFICATION.md) (V12, plus V19/V20 for durable apps), the [STATUS](../../STATUS.md) tracker rules, [TESTING](../../TESTING.md), the [RELEASES](../../RELEASES.md) contract, [DEPLOYMENTS](../../DEPLOYMENTS.md), [DURABLE](../../DURABLE.md) and MD15 ([SOURCES](../../SOURCES.md)).

**Reviewer:** a separate read-only session, not the author.
- Local runs used Node 24.21.0 and pnpm 11.25.0 (`pnpm install --frozen-lockfile`) on a clean detached checkout of `b5ce88b`, which has the same code as the candidate.
- The disposable fixture was Compose project `embody-m13-review` on loopback port 55761, from `docker-compose.postgres-test.yml` and `test/postgres/init.sql`. Its env was `fixture.env.example` with the port and container name changed, and every line exported, including `EMBODY_PROVISIONER_URL`. It was removed afterwards with `down --volumes --remove-orphans`. `embody-local*`, `embody-m12-verification` and `embody-m13-verification` were not touched.
- No cloud resources were created, nothing was spent, and `test:mvp:cloud` was not run.
- No product code, tests or docs were changed. The worktree was clean after every run (`git status` empty).
- Probes and mutations ran in a scratch copy (`git archive` of the tip into `/tmp/m13review/scratch`) outside the repository.

## Verdict: **REJECTED** (phase 1 code)

Live evidence (the `m13` cloud suite) is a separate requirement. It does not exist yet and is not judged here, except where the live tooling defines the grant posture (B3).

The promotion transaction is careful, and these parts hold up:
- the route/manifest/generation switch is one CAS row under the workspace lock;
- replaced releases' artifact and source pins are released to the ordinary sweeps with monotone 30-day retention;
- rollback is a fenced deployment with idempotency by target and generation;
- manifest re-read is bound to `manifestDigest`/`catalogDigest`, and the build's `appId` is checked against the platform name;
- contract migrations are refused before execution;
- the crash matrix converges.

Every local gate reproduces with zero skips, and exact-candidate CI is green.

Three blockers remain. Two are the same liveness/retention class that sent M10, M11 and M12 back:

1. **B1:** A durable app's wake tasks are addressed to the candidate that enqueued them. After a promotion the sweep deletes that candidate 10 minutes later, so every wake due after the drain hits a deleted service. This covers delayed steps, retry backoffs, lease wakes and the 30-day retention cleanup chain. For an idle app, nothing ever reclaims that work. M13.e and V20 do not hold for the hosted durable profile.
2. **B2:** The candidate sweep can be starved:
   - it reads only the first page (200) of all Cloud Run services in the region and ignores `nextPageToken`;
   - one persistently failing delete aborts every pass at the same position.

   Drained and orphaned candidates past that point are never removed and accumulate toward the regional Cloud Run service quota.
3. **B3:** The live worker grants are wider than the RELEASES identity table. The M13 custom role is bound project-wide without conditions. That includes `secretmanager.secrets.setIamPolicy` on every secret, which lets the worker grant itself access to any secret payload, including the gateway signing key. The table explicitly forbids exactly that ("reading secret payloads; app actions"). The live IAM evaluator would certify it.

## Reproduction (exact code, clean tree, Node 24.21.0)

| Command | Result |
|---|---|
| `pnpm verify` (no DB variables) | exit 0: lint, license, typecheck, tests (optional DB files skipped as designed: gateway 283 passed / 4 skipped, storage 14/15, host 68/45), build, API report, format |
| `pnpm test:verification` (standalone) | **108** passed, 0 skipped |
| `pnpm test:postgres` | **16** passed, 0 skipped |
| `pnpm test:gateway-store` | **68** passed, 0 skipped |
| `pnpm test:mvp` | **630** passed, 0 skipped: postgres 16, gateway-store 68, cloud-contracts 106, auth 6, host 113, MCP 18, gateway 287, CLI 16 |
| `pnpm test:m12` | **128** passed, 0 skipped (5 files) |
| `pnpm test:m13` | **87** passed, 0 skipped (6 files) |

All counts match the author's claims. Every evidence JSON under `.artifacts/verification/` (`postgres`, `gateway-store`, `mvp`, `m12`, `m13`) records `commit: b5ce88b61cc1…` (code-identical to `a561eaf`), `dirty: false`, `status: passed` and `counts.failed = counts.skipped = 0`.

**Exact-candidate CI:** run [39563242445](https://github.com/embodyapp/embody/actions/runs/39563242445) on `b5ce88b` (the tip) passed all 9 jobs: `quality` 22/24, `postgres-matrix` 22/24, `postgres`, `e2e-artifacts-matrix` 22/24, `e2e-artifacts` and `terraform`. `test:m13` now runs in both `postgres-matrix` legs (`.github/workflows/ci.yml`).

**The key regressions are real.** Each mutation below was applied in the scratch copy and then restored; the same files pass unmutated (35/35):

| Mutation | Result |
|---|---|
| `releasedPin` always returns `null` (no unpin of replaced releases) | 5 fail: PG "replaced pins are released", PG retention >100 MiB, PG SIGKILL "prior pins released once", memory rollback, memory source quota |
| `APP_NAME_MISMATCH` check removed (`release-stages.ts:300`) | 1 fails: "a build whose own app name differs… is refused" |
| `workflowRefusal` returns `null` | 3 fail: PG M13.e "dropping v1 is refused", memory rollback workflow refusal, memory "dropping or changing v1 is refused" |
| finding-1 `abandonIfEnded` after `DeadlineError` disabled (`deployment-controller.ts:296`) | 1 fails: "M12 review finding 1: … late candidate removed" |

## Blockers

### B1. Durable wake tasks target the candidate that enqueued them, which is deleted after the drain; scheduled work is stranded

**What the code does:**
- Each deployment gets its own Cloud Run service, `candidateName(prefix, record)`.
- For `durable-v1`, the candidate's `EMBODY_DRAIN_URL` and `EMBODY_DRAIN_AUDIENCE` are that candidate's own URL ([release-stages.ts](../../../../packages/gateway/src/release-stages.ts):486, 510–514).
- The host binds every wake task's HTTP target and OIDC audience to `EMBODY_DRAIN_URL` at enqueue time (`packages/host/src/index.ts:819–826`, `cloudTasksWakeQueue`). These tasks include:
  - step wakes at `step.scheduledAt` (delayed steps, retry backoff);
  - lease wakes;
  - the per-tenant outbox retention cleanup, scheduled about 30 days ahead (`packages/host/src/durable.ts:283–308`, `:302–308`, `:520–533`).
- After a promotion, `CandidateSweep` deletes the replaced candidate once `drainUntil` (+10 min) has passed (`release-stages.ts:671–673`, `:688`).

**Why it breaks:**
- Every wake enqueued by release A and due after A's drain is dispatched to a deleted service, which returns 404.
- The per-app queue retries for `maxRetryDuration: 259200s` (`cloud-release.ts:389–394`) and then drops the task.
- Even if the task were routed to B, B's drain accepts only its own audience.
- DURABLE's "recovery without a sweep" (DURABLE.md:112) runs only after an authenticated action on the app. An idle durable app therefore never runs the work: a delayed workflow step or backoff retry after a deploy, or its retention cleanup chain (records nothing reclaims).
- This defeats M13.e ("an instance started on v1 completes on v1 after v2 is promoted") and V20 ("delayed step, everything idle, step runs once when due") for the only hosted profile that runs workflows.
- The local M13.e proof (`release.postgres.test.ts:269`) drives the instance with the reference `WorkflowWorker`, not the hosted wake/drain path, so it cannot see this.
- RELEASES "Residual risks → Drain" (RELEASES.md:165) considers only gateway calls, not queued wakes.

**Repro** (scratch probe on the release harness, `review-probes.test.ts`). Deploy a durable workflow app (A), deploy again (B), advance past the drain and run the sweep:

```text
{"aDrain":"https://emb-cd8809d07256ac9106a17700f-123456789012.us-central1.run.app/_embody/drain",
 "bDrain":"https://emb-c6c420871141d5ee6e878c365-123456789012.us-central1.run.app/_embody/drain"}
{"aServiceExists":false,"bServiceExists":true}
```

Any wake A enqueued with a due time after the drain (`httpRequest.url = aDrain`) now targets a service that no longer exists.

**Fix (any equivalent is fine):**
- Give each durable app a **stable** drain URL and audience that follow the active release. For example:
  - one Cloud Run service per app with revisions per release and traffic switched in promotion; or
  - a platform drain forwarder that resolves the app's current route from the catalog.
- Or, when a durable release is promoted, have the new candidate re-home pending work:
  - enumerate every pending or waiting step, claimed lease and retained-outbox cleanup;
  - enqueue them at their due times to its own URL, with task names that include the release or candidate so Cloud Tasks deduplication against the stranded tasks does not swallow them;
  - keep the replaced candidate until that re-home has committed.
- Add a regression that runs the hosted durable drain path with a `MemoryWakeQueue` that records target URLs: a step scheduled on A beyond the drain must run after the promotion and sweep, and the cleanup chain must survive a promotion.

### B2. The candidate sweep can be starved: one provider page, no cursor, head-of-line failure

**What the code does:**
- `GoogleReleaseProvider.list` issues one `GET …/services?pageSize=200` and filters by label client-side. It never follows `nextPageToken` ([cloud-release.ts](../../../../packages/gateway/src/cloud-release.ts):229–244). The port even says "bounded by the provider page size" (`release-stages.ts:144`).
- `CandidateSweep.sweep` walks that list from the head on every pass (`release-stages.ts:681`) and awaits `remove` without catching (`:688`). One throwing delete therefore aborts the whole pass. The controller swallows the error (`deployment-controller.ts:212`), and the next pass starts at the same head.

**Why it breaks:**
- The page holds **all** services in the region (gateway, worker and the other platform services, plus one permanently `keep` candidate per active app and in-flight deployments). Once the region has about 200 services, any candidate not on the first page is never examined. That includes drained, failed, cancelled and orphaned candidates (including the finding-1 late candidate the sweep is the backstop for).
- Every deployment creates a new candidate, so the leaked set grows without bound until the regional Cloud Run service quota (1,000 by default) is exhausted. After that, every `create` fails and every deployment on the platform fails.
- The operator reconcile (`/_embody/tasks/reconcile`) runs the same sweep, so it cannot repair this either.
- Separately, one candidate whose delete keeps failing, ahead of others in list order, blocks every later removal on every pass.
- This is M11 B2's starvation shape: fixed-head scans with permanent rows in front. RELEASES' claim that "removal keeps pace with creation… and do not grow" (RELEASES.md:100) is false past one page.

**Repro** (scratch probes):

1. `GoogleReleaseProvider` with a stub fetch. Page 1 has 200 running candidates and `nextPageToken`; page 2 has one orphan whose deployment does not exist. Three sweeps:

   ```text
   {"results":[{"removed":0,"kept":200},{"removed":0,"kept":200},{"removed":0,"kept":200}],
    "listRequests":["GET …/services?pageSize=200", "GET …/services?pageSize=200", "GET …/services?pageSize=200"],
    "deletes":[]}
   ```

2. `MemoryCandidateProvider` with two removable orphans, where the first one's delete keeps returning an error. Five passes:

   ```text
   {"outcomes":["Release provider returned 409", … ×5],"remaining":["emb-c75dcf…","emb-cbac2a…"]}
   ```

**Fix:**
- Follow `nextPageToken` (bounded pages per pass with a persisted or rotating cursor), or drive the sweep from the platform database. Two indexed queries cover it:
  - releases with `drainUntil <= now` and no `candidateRemovedAt`;
  - terminal non-active deployments with a `candidate` not yet removed.

  The provider listing then serves only as a paged orphan scan.
- Catch per-candidate failures, count them and continue (as `purgeArtifacts` does since M11).
- Add regressions for a full first page and for a failing delete ahead of a removable one.

### B3. The worker's live grants exceed the RELEASES identity table and allow reading any secret payload

**What the code does:**
- The table (RELEASES.md:106) scopes the worker's Secret Manager permissions to "`secrets.create/get/setIamPolicy`, `versions.add/get` on `<prefix>-a…-db` secrets (no `versions.access`)" and its Cloud Tasks permissions to "`<prefix>-a` queues". Its "Never" column lists "reading secret payloads; app actions (no signing key)".
- The live tooling instead creates one custom role (`infra/mvp/m13/gcp.mjs:24–44`) holding:
  - `secretmanager.secrets.setIamPolicy/getIamPolicy`;
  - `run.services.delete/setIamPolicy`;
  - `cloudtasks.queues.setIamPolicy`.

  It binds that role to the worker **at project level with no condition** (`gcp.mjs:195–198`).
- The evaluator only checks that the binding is present (`qualify.mjs:112`, `workerHasM13Role`), and the mocked test accepts it (`test/verification/m13-cloud.test.mjs:97–124`). Its "no `versions.access`" assertion misses the escalation.

**Why it breaks:**
- With `secrets.setIamPolicy` on every secret, the worker can add itself as `roles/secretmanager.secretAccessor` on the gateway signing key (`n.gatewayKey`), the provisioner secret or the platform DB secret, and then read the payload.
- With the gateway key, it can mint principal tokens and call any app action in any workspace: exactly the two "Never" items.
- The unconditioned `run.services.setIamPolicy/delete` also lets it delete or re-expose the gateway and worker services.
- This is not M12 finding 6 (non-blocking roles broader than the table without a privilege-escalation path). This is a new M13 grant with a concrete escalation to secret payloads, and the live suite would pin and certify it as exact.

**Repro:** static. Read `gcp.mjs:195–198` (the binding has no `condition`), then `qualify.mjs:106–137` (`evaluateReleaseBindings(["worker|project:custom/m13-release", …])` passes, as the mocked test shows).

**Fix:**
- Split the custom role and bind each part with IAM conditions matching the table:
  - Secret Manager: `resource.name.startsWith("projects/<number>/secrets/<prefix>-a")`; `secrets.create` needs separate handling at the project level.
  - Cloud Run: `resource.name.startsWith("projects/<p>/locations/<r>/services/<prefix>-c")`; `run.services.list` stays unconditioned and read-only.
  - Cloud Tasks queues: `…/queues/<prefix>-a`.
- Make the evaluator require those conditions, and add mocked negatives for an unconditioned binding.
- `iam.serviceAccounts.setIamPolicy` on `<prefix>-w` invokers (in the table, required by `ensureWakeQueue`) is missing from the role. Durable provisioning would get a 403 live. Add it, conditioned on the `-w` prefix.

## Non-blocking findings

1. **Project IAM policy growth.** `ensureDatabaseClient` adds each app's runtime as a member of the project's unconditional `roles/cloudsql.client` binding (`cloud-release.ts:277–306`). Nothing removes it before M15 app delete, including for reserved apps whose first deploy failed. An allow policy holds at most 1,500 principals, so the platform has a hard ceiling on apps per project, after which every new app fails provisioning. Record the bound in RELEASES and M15. Also consider an instance-conditioned binding (`resource.name == "projects/<p>/instances/<i>"`): today the runtime can use the connector against any instance in the project and read instance metadata.
2. **The conditional IAM admin bounds the role, not the member.** `modifiedGrantsByRole hasOnly(['roles/cloudsql.client'])` (RELEASES.md:106) still lets the worker grant `cloudsql.client` to any principal, including external accounts unless an org domain restriction applies. Acceptable for trusted platform code, but say so in the table.
3. **Credential convergence and the serving release.**
   - The secret version is written before the role password (`release-stages.ts:417–425`). A Cloud Run instance cold-starting in that window resolves `latest` to a password the role does not have yet.
   - Two concurrent first deployments of one app can interleave `addSecretVersion`/`setCredential` so that the marker and `latest` disagree. The next step rotates again, and any instance started meanwhile holds a dead password until it is recycled.
   - Serialize the rotation, for example under a per-app advisory lock held across the add and the set. Consider setting the password as a SCRAM verifier: `ALTER ROLE … PASSWORD '<plaintext>'` (`app-database.ts:156`) can reach Cloud SQL logs if `log_statement` is raised.
4. **`recipeSchemaVersion` throws for an unknown recipe** (`deployment.ts:957`). It is called in provisioning and inside the promotion transaction (`store.ts` `promotedRelease`). Once a new recipe ID ships, a rollback to a retained release built with the previous recipe fails through crash/retry exhaustion with a generic code, not `ROLLBACK_INCOMPATIBLE`. Keep a table of known recipes and their schema versions.
5. **Rollback skips the app-name check.** `registration()` reuses the target's stored registration and only replaces `appId` with the current name (`release-stages.ts:586–591`). If the catalog name changed since the target was built, the rollback promotes a release whose host rejects every gateway token. Re-check `artifact.manifest.appId === status.name` for rollbacks too.
6. **The sweep runs inside the task handler before the response** (`deployment-controller.ts:212`). One list, up to 3 DB reads per listed candidate and up to 10 deletes of 15 s each can add minutes to a task's response. Bound the sweep by a time budget, or run it after replying.
7. **Provisioning chain versus the 45 s deadline.** One provisioning step can chain about 12 provider calls (15 s each) plus a migration (30 s statement, 5 s connect). The comment "no call chain approaches the handler deadline" holds only for typical latencies. Three consecutive timed-out handlers fail the deployment (`maxCrashes: 3`). Progress is idempotent, so this is not stuck, but the worst case should be documented, or the stage should check its remaining budget between sub-steps.
8. **`migrate()` repair under a rolling upgrade.** Releases replaced by an M12-version worker after the M13 gateway's `migrate()` ran keep their pins until the next `migrate()` (restart). Note this in the upgrade runbook.
9. **Docs nits.**
   - RELEASES "Cost" says about $1.05 per run, while `m13Projection()` asserts $0.99 and M13-local and STATUS say $0.99.
   - RELEASES says the runtime "holds no provider roles" (Provisioning section), but it holds project `roles/cloudsql.client`, as its own identity table states.
   - The IAM-condition resource-name format for service accounts (`projects/-/serviceAccounts/<prefix>-a…`, `gcp.mjs` actAs condition) is unverified until the live suite proves it.

## What was checked and holds

- **Obligation 1, unpin and quota.**
  - Promotion marks the replaced release inactive (`drainUntil` +10 min, `retainUntil` +30 d).
  - `releasedPin` unpins only pins held by that release, with `retainUntil = max(current, now + 30 d)`, monotone (`deployment.ts:1078`).
  - The new release re-pins what it shares in the same transaction, in both stores (memory `store.ts:748–800`, PostgreSQL `:1839–1925`, CAS writes keep the `pinned` column equal to `pinnedBy`).
  - A shared source referenced by a retained inactive release cannot expire before that release: every later unpin extends its retention, and rollback extends retention to the rollback deployment's 90 days.
  - The source and artifact sweeps honor `NOT pinned AND retain_until <= now` and CAS on revision, so a concurrent rollback submission (which bumps the revision under the row lock) defeats a racing purge.
  - The quota test pushes 90 MiB of promoted source and the workspace can still upload, in memory and on PostgreSQL. The `migrate()` backfill unpins records held by pre-M13 releases.
- **Obligation 2, conservative generation.** Only `promotedCatalog` moves the generation. Release lifecycle, `markCandidateRemoved`, pins and candidate removal write their own rows. The sweep test asserts the generation is unchanged.
- **Obligation 3, customer claims.**
  - The namespace is `status.name`.
  - `manifest.json` is re-read and must hash to `manifestDigest`, and its catalog to `catalogDigest`. The size cap maps to `MANIFEST_MISMATCH`.
  - `APP_NAME_MISMATCH` refuses a build under a different name.
  - The registration is re-validated in the store transaction (`registrationRefusal`: namespace, route equals this deployment's candidate, M04/M06 validation), and failures end the deployment instead of throwing.
- **Obligation 4, finding 1.** `DeadlineError` carries the running work, and `abandonIfEnded` runs when it settles. A mutation proves the test. The sweep backstop removes candidates of failed, cancelled and record-less deployments, subject to B2.
- **Obligation 5, workflow versions.** `workflowRefusal` refuses dropped in-use versions and changed graphs, for both deploy and rollback (mutation-proven). Subscriptions switch in the same catalog row. The pre-transaction race is documented and bounded.
- **Lock order.**
  - Promotion: workspace → deployment → artifact → source → replaced release → its artifact and source.
  - Rollback submission: workspace → source → artifact.
  - Submissions also take the workspace lock first, and sweeps touch single rows.

  I found no cycle. Concurrent promotions on two pools produce one generation step.
- **Crash safety.**
  - Identity, secret, queue and candidate are adopted by name. The candidate is adopted only after a label and annotation ownership check, and is refused on a digest or endpoint mismatch.
  - Migrations run one per step under an advisory lock in a bounded transaction.
  - The credential converges through the role-comment marker.
  - The SIGKILL matrix reproduces.
- **Ownership on every provider delete.** `abandon` and the sweep require the platform label, the role, an owner hash of the exact IDs, a name matching `candidateName` and well-formed IDs. Foreign and forged services are untouched (tested).
- **Rollback.**
  - Idempotent by `rollback-<release>-g<generation>`; customer keys with that prefix are refused.
  - Refused explicitly for an active, expired, pre-M13 or missing-artifact/source target. Schema floor and workflows are refused by the stages with the same public code.
  - A fresh candidate and full checks run, and a new release is promoted through the same CAS.
- **Migrations.** `contract` is refused before execution (ledger and checksum unchanged on PostgreSQL). A failing expand rolls back, and an older release boots after an expand (`hostedSchemaCompatible`). The provisioner is `CREATEDB`/`CREATEROLE` only, and the runtime has DML plus `EXECUTE` on the runtime functions only, with no `CONNECT` to other app databases or the platform database.
- **Public errors and redaction.**
  - The new public code is `ROLLBACK_INCOMPATIBLE` with a fixed message. Reasons stay operator-only.
  - Provider errors are opaque (`Release provider returned <status>`).
  - The controller never reads a secret payload (`versions/latest` metadata only).
  - `PROVISIONER.*URL` is redacted in verification output.
- **Bounds.** Provider calls 15 s, health 5 s, DB statements 30 s / locks 5 s, provisioning 15 min, checks 10 min, poll 5 s, and the 45 s/180 s handler/lease from M12.

## Required for acceptance

1. **B1:**
   - A stable per-app drain target, or a committed re-home of pending durable work on promotion, so scheduled steps, retries, leases and the retention cleanup survive the removal of the replaced candidate.
   - A regression on the hosted durable wake path that fails on `a561eaf`.
   - RELEASES "Residual risks" updated.
2. **B2:** A candidate sweep that cannot be starved (pagination with a cursor, or DB-driven removal plus a paged orphan scan) and that continues past failing deletes, with regressions for a full first page and a failing head.
3. **B3:** Worker grants conditioned to the documented resource prefixes (Secret Manager, Cloud Run, Cloud Tasks), the missing `-w` invoker `setIamPolicy` added, and the live IAM evaluator and its mocked test requiring the conditions and rejecting an unconditioned custom-role binding.
4. Exact-candidate CI on the fixed commit, with all local gates reproducing at zero skips.
5. Phase 2: the owner-approved live `m13` run on the fixed code, including the IAM case against the corrected table. Add a durable app to the live run, or record why B1's fix is proven sufficiently without one.
6. Non-blocking findings 1–9 should be fixed or tracked (RELEASES, M15 and M16 follow-ups).

---

Reviewer artifacts (outside the repository): probe file `/tmp/m13review/scratch/packages/gateway/test/review-probes.test.ts`, mutation runner `/tmp/m13review/mutate.sh`, logs `/tmp/m13review/*.log`. The fixture `embody-m13-review` has been removed. The worktree `/Users/nimrodfeldman/playground/embody/.claude/worktrees/agent-ae4fdb58b9a4adc19` is clean on detached `b5ce88b`, and nothing was committed or pushed.
