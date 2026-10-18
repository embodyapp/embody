# M09 independent review: candidate `308edf8` (live run `027dddff` on `3ef5f28`)

**Candidate:** `308edf8cfb05a42786b169910287900ef6f5e89d` (PR #47, stacked on #43) · **Diff:** `fb9a211..308edf8` · **Live code:** `3ef5f28` (`3ef5f28..308edf8` changes docs and evidence only, so the report's `dirty=true` does not affect code) · **Reviewer:** claude, a separate read-only review session that did not write this work · **Date:** 2026-10-18

## Verdict: **ACCEPTED** (DONE is conditional on C1 and C2)

I found no blocker. Every M09.a–e case is backed by live evidence. I checked the parts that matter in Cloud Logging and the provider inventory, and no evaluator I traced passed on a false green in this run. Two things must happen before DONE:

- **C1:** M09.d says "baseline cost worksheet reviewed by owner". The evidence says that review is pending, and a reviewer cannot stand in for the owner. Record the owner's review of the [worksheet](../../M09-QUALIFICATION.md#cost-worksheet) in STATUS, together with N1's point that the worksheet assumes 5 apps but `db-f1-micro` guarantees full pools for 3.
- **C2:** Correct two claims in the docs and record the step 3 and step 5 gaps as open items (N2, N3, N4). This is docs only: no code change and no live rerun.

## What I checked

- I read IMPLEMENTATION M09, VERIFICATION, STATUS, M09-QUALIFICATION, the live README and `mvp-cloud.json`, Phase 1, and the whole code diff: `qualify.mjs`, `gcp.mjs`, `queue-probe.mjs`, `wake-target.mjs`, `sql.mjs`, `sql-suite.mjs`, `costs.mjs`, `main.tf`, `provider/cloud-tasks.mjs`, the scripts and the tests.
- Local runs on Node 24.21.0: `pnpm install --frozen-lockfile` passed. `pnpm test:verification` ran 82 tests: 82 passed, 0 failed, 0 skipped. `pnpm verify` completed through build, unit tests, api-extractor and `prettier --check` with no failure. Its storage and host Postgres-gated tests skip as usual; CI covers them.
- Exact-candidate CI for `308edf8`: [run 39119235616](https://github.com/embodyapp/embody/actions/runs/39119235616), all 9 checks green (quality, postgres-matrix and e2e-artifacts-matrix on Node 22 and 24, terraform).
- Read-only checks against `embody-cloud`, 2026-10-18:
  - Inventory: no `embody-test-m09` SQL instances, Cloud Run services or jobs, queues, service accounts, secrets or repositories.
  - The project IAM policy has no `m09` or `sqlt` member or condition.
  - Only the retained M05 foundation remains: 4 service accounts, 2 secrets, the image repository and the `embody-test-m05-deployments` queue.
- I re-derived three live results from Cloud Logging:
  - **Emergency stop:** `PauseQueue` at 09:13:31.9 and `ResumeQueue` at 09:16:36.0. The `pause-check` wake arrived at 09:16:53.8, after the resume.
  - **Delayed wake:** the task was due at 09:52:38.743. The first request log is at 09:52:38.787, `Starting new instance` at 09:52:38.832, and the wake at 09:52:39.882. The own service logged no request and no instance start from 09:20 until the due time.
  - **Cost worksheet:** `monthlyWorksheet()` returns $16.49, and $34.37 with `db-g1-small`, matching the docs.
- `main.tf` and its lock file have not changed since `ffe2115`, so the 2026-10-15 apply used the candidate's IaC.
- **Not verified by me:** the fixture image digest and its build from `3ef5f28` (the repository has been destroyed), the before/after project IAM comparison, the Terraform destroy plan, the invoice, and any behaviour of the destroyed SQL instance. I spent nothing, created nothing, and did not touch the shared `embody-local-*` services.

## Per-case verdicts

| Case | Verdict | Basis |
|---|---|---|
| M09.a | ACCEPT | **Apply:** a fresh apply on 2026-10-15 of unchanged IaC (21 resources), and `preflight` checks the live instance and repository settings. **Teardown:** names are derived from the run ID, and adapters check ownership through descriptions and labels. The inventory covers services, jobs, queues (except DISABLED), runtime, migrator, invoker and SQL-job identities, secrets, and the conditional project binding. Teardown runs on every path, with one retry, and the inventory was empty. My provider listing agrees. The baseline served several runs and was not re-applied for `027dddff` (N9). |
| M09.b | ACCEPT | **Probe identity:** the probe ran as app A's runtime identity using metadata credentials, and `own-now`=200 is a positive control, so the 403s are not caused by a broken token. **Identity negatives:** six 403s, plus other-queue and other-invoker. **SQL:** CONNECT to B's and the platform database fails with `42501` after the bootstrap fix. **Cross-app:** B received 16 IAM 403s, with no wake and no instance start. **Builder:** its only binding is `artifactregistry.writer`, across the project, repository, secret, queue and service policies. The literal "metadata probes" wording is only partly covered (N2), and the builder check has limits (N5). |
| M09.c | ACCEPT | **Conformance:** `test:postgres` 16/16 and `test:gateway-store` 43/43 on Cloud SQL, run in-region with zero skips. **Storm:** exactly 5 connections succeeded and 5 were refused with `53300`, the platform role still connected, and the slots were released. **Restore:** checksum equal and marker gone (924 s, in place, see N8). **Latency:** p50 35 ms and p95 43 ms for a new connection. Pooling semantics are only implied (N3). |
| M09.d | ACCEPT technically; **owner review outstanding (C1)** | **Scaling:** the service and serving revision show min 0, max 1, `cpuIdle`, concurrency 4, internal ingress and IAM. **Zero:** explicit zeros from 09:32:40 to 09:38:40, then silence. Logs back the silence (no request or start until the due time) and a cold start at the due time corroborates it. |
| M09.e | ACCEPT | **Delayed wake:** delivered 1.1 s after due, never early, from zero, with a cold start (confirmed in logs). **Duplicates:** 409 before and after execution, and the real M20 adapter returned `created` then `duplicate`. **Horizon:** 30 days − 10 min accepted, 30 days + 1 h rejected with 400. **Retries:** five 503s then 200, with non-shrinking backoff and a 72 h window. **OIDC:** 10 tokens, all passed the real verifier, with `email` and `email_verified` set and audience, issuer and lifetime checked. **Callers without the invoker identity:** blocked by ingress (external 404) and by IAM (cross-app 403). Queue cost and quota are in the worksheet. |

## Evaluator review

- **`evaluateDelayedWake` zero-gap rule.** Silence counts as zero only when an explicit zero preceded it and the platform logged no instance start and no request before the due time. That is sound, because with max 1 instance any new instance logs a start. The rule rests on Cloud Run request and system logs being complete, and those logs are not sampled. A `coldStart` at the due time corroborates it, and this run's logs confirm it. If the start or request queries returned `[]` because of a broken filter, `zeroBeforeDue` would pass, but `coldStart` uses the same start query, so a broken filter would fail the case. I accept the rule. M17 must reuse it, as the docs say.
- **`zeroIntervals`** is correct for ALIGN_MAX one-minute points. NaN is not treated as zero, and only contiguous points merge.
- **`evaluateIsolation`** counts only `status < 400` as allowed (N6). Wakes and starts would catch a container reached with a 5xx, so this run is not affected.
- **`evaluateQueueProbe`** fails on any missing case, any non-matching status, or `report.pass !== true`. It judges by status only (N7).
- **`evaluateBuilder`** is exact over the policies it inventories (N5).
- **`evaluateStorm`**, **`evaluateRestore`** and **`evaluateConnectDenials`** are strict: exact counts, only `53300` or `42501` accepted, and both restore conditions required. A missing job report fails the storage and latency cases.
- **Emergency stop** (in `runM09Suite`, not a pure evaluator). `deliveredAfterResume` does not compare the delivery time with the resume time. With log-ingestion lag, a wake delivered during the pause could show up only after the 120 s read and still pass (N6). The live logs show the delivery came after the resume.
- **`safeError`** keeps our own `Provider … failed (n)` messages and short letter-only text without `token`, `password`, `secret` or `postgres:`. Everything else is reduced to the error class. Fixture passwords are 32 base64url characters and pg authentication errors contain "password", so neither can pass the filter. Acceptable.
- **Teardown:** `tearDown` runs in `finally`, takes the run ID even when `setUp` threw, retries once, and the inventory includes the conditional binding's roles. `removeSqlJob` also runs inside `qualifySql`'s own `finally`.

## Security review

- **Secrets in the repository and evidence:** none. The report holds statuses, counts, timings and public resource names, and I read every field of `mvp-cloud.json`. The wake target logs claim facts, never tokens. The probe logs statuses only.
- **SQL job secrets:** the job gets its DSNs through a `secretKeyRef` on a run-scoped secret, readable only by the run-scoped identity. The child test runners redact any environment value whose key matches `POSTGRES.*URL` or `PLATFORM.*URL`, which covers all five keys. Fixture passwords are random, kept in a mode-0600 private file that teardown deletes, and belong to an instance that has since been destroyed.
- **Run-scoped SQL job identity:** it has a description marker and is deleted only when the marker matches.
- **Conditional `cloudsql.client` binding:** the condition is `resource.name.endsWith('/instances/<prefix>-postgres')`, titled per run. It is added and removed by read-modify-write with the policy etag, so a concurrent change fails instead of being overwritten. Removal filters by title only. The inventory checks for it, and I confirmed it is gone.
- **`cloud-tasks.mjs` grants:**
  - The runtime gets `cloudtasks.enqueuer` (tasks.create only) on its own queue.
  - The runtime and the Cloud Tasks agent get `iam.serviceAccountUser` on the app's own invoker.
  - The invoker gets `run.invoker` on the app's own service.
  - Existing foreign bindings or conditions make it refuse, rather than overwrite. I found no over-grant.
  - One implication: through its own queue, the app can make Cloud Tasks deliver an invoker-signed OIDC token for any audience to any URL. Today that token is worth nothing beyond the app's own service and drain, both of which the app already controls (N10).
- **Possible leak through server logs (hygiene):** `CREATE ROLE … PASSWORD '<literal>'` would reach Cloud SQL's `postgres.log` if the statement errored, because `log_min_error_statement` defaults to `error`. `dropFixture` runs first, so this is unlikely, and the passwords were fixture-only. The M13 controller should set passwords in a way that keeps them out of statement logs, or confirm the logging flags.

## Blockers

None.

## Non-blocking notes

- **N1. Connection budget vs worksheet (C1).** `db-f1-micro` with about 20 usable slots guarantees the gateway plus 3 apps at full pool, but the monthly worksheet prices 5 apps. Apps beyond the slots fail closed with `53300`/`UNAVAILABLE`, which is safe, and `db-g1-small` (+$17.89, total $34.37) fits under the ceiling. Acceptable for M09 if the owner reviews the worksheet with this trade-off in front of them. M13 must set each role's limit to pool × max instances, as documented.
- **N2. PUBLIC/default-privileges review is incomplete, and one claim is wrong (C2).**
  - The docs say "PUBLIC revoked on every database and schema". The bootstrap revokes it only on the three fixture databases.
  - `postgres` and `template1` keep PostgreSQL's default PUBLIC `CONNECT`/`TEMP`, so app A's runtime can connect to `postgres`.
  - Through the cluster-wide catalogs (`pg_database`, `pg_roles`, `pg_stat_activity` rows), any app role can see other apps' database and role names and session existence. Query text and data stay hidden.
  - `ALTER DEFAULT PRIVILEGES` and PUBLIC `EXECUTE` on functions are not discussed.
  - Not tested live; this reasoning is from PostgreSQL defaults.
  - Fix in the docs: correct the claim, record the catalog visibility as an accepted shared-instance residual (names must not carry customer data), and require M13 to revoke PUBLIC `CONNECT` on `postgres` and `template1`.
- **N3. Pooling semantics are not named (C2).** Step 3 asks for the selected pooling to be tested. The evidence implies application-side `pg` pools (5 per instance, 1 s idle close) through the connector or Auth Proxy, with no server-side transaction pooler, so session semantics (`SET ROLE`, GUCs, RLS context) are full PostgreSQL sessions. That is exercised by the conformance suites on Cloud SQL and the storm. Say this explicitly in M09-QUALIFICATION. `statement_timeout` and `idle_in_transaction_session_timeout` are set but not tested live, and migrator limits are never applied live. Both are minor.
- **N4. Step 5 lifecycle bounds and alerts (C2: record as open).**
  - **Alerts:** none exist. The budget alert needs a billing account the owner did not supply, and there is no Monitoring alert policy.
  - **Emergency stop:** per-app queue pause only. There is no "pause all", and the deployment admission stop belongs to M10/M12.
  - **Logs:** no exclusion, retention or volume bound, while `log_connections=on` and the fixture's task log sampling is 1.
  - **Images:** the Artifact Registry policy does not keep "five recent versions" as a bound. KEEP 5 plus DELETE untagged older than 1 day means tagged versions beyond five are never deleted (KEEP only protects).
  - **Secrets:** no secret-version lifecycle.
  - **Builds and source storage:** not present yet (M10/M11).
  - None of this is an M09.a–e acceptance case, and the docs disclose the budget alert. Carry the rest as explicit open items before real tenants (M16/M18).
- **N5. Builder check scope.** `iamInventory` covers the project, repository, platform secrets, and the fixture's queues, services and app secrets. It does not cover service-account-level policies (who can act as or impersonate the builder) or the state bucket. Also, `artifactregistry.writer` on the single shared repository lets a build overwrite any tag, including the gateway's. Deploys pin digests and MD09 blocks user builds today, but M11 needs per-app repositories or immutable tags plus a negative test.
- **N6. Evaluator hardening (no false green in this run).**
  - Emergency stop: require the `pause-check` `receivedAt` to be at or after the resume time.
  - Isolation: count any status other than 403 as allowed.
  - Record `receivedAt` in the report.
- **N7. Status-only identity negatives.** A 403 can also mean `SERVICE_DISABLED`. All the APIs used are enabled by the baseline, so this run is fine. Recording the error `reason` (not the body) would make the negatives unambiguous.
- **N8. Restore is in place.** Cloud SQL restores the whole shared instance, so in production a restore would roll back every app and the platform, and it took about 15 minutes of downtime here. Per-app recovery needs restore-to-new-instance plus a per-database copy. M16 must qualify that. A "preliminary restore" is satisfied.
- **N9. Baseline reuse.** Run `027dddff` used the 3-day-old baseline that runs 2–5 had also used. The `postgres` password had been reset, fixtures had been created and dropped, and restores had been done. The IaC is unchanged and preflight re-checks the settings, so M09.a holds. A future release run should apply fresh before running the suite.
- **N10. Invoker identities are single-purpose.** Because each app can mint its own invoker's OIDC tokens through Cloud Tasks, no other component (gateway, other apps, platform drains) may ever trust a wake-invoker token.
- **N11. Residuals I accept for M09:**
  - `cloud-run.mjs` `deploy()` refuses the wake invoker. M13 must fix it, and today it fails closed.
  - MD09 is deferred: the "no user source deployment" rule holds because no deployment path exists yet. M10/M11 must enforce it with a hard gate.
  - Per-project Cloud Tasks quotas are shared by all workspaces. Per-app queues bound dispatch only, and the 1,000-queue limit is documented. M12 owns this.
  - The dedup window was observed only minutes after execution. M20 does not depend on it.
  - `dirty=true` comes from a docs-only change.
  - The invoice check is still open.
  - The gateway-store report has no `postgresVersion` (cosmetic).

## Disclosure

I made no cloud changes. My provider checks were read-only `gcloud … list`, `get-iam-policy` and `logging read` calls against `embody-cloud`. I ran out-of-tree evaluator checks with `node -e` against the candidate modules (zero-gap and isolation inputs); none were saved. No tracked file changed except this review.
