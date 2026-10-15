# M09 cloud, database and wake-queue qualification

Status: **phase 1 only.** The baseline, adapters, probes, suite and worksheet below exist and
have mocked fail-closed tests. **No cloud resource has been created and nothing has been spent.**
Mocked results are not provider evidence. The live run (phase 2) waits for the owner inputs at the
end of this page. Task definition: [IMPLEMENTATION M09](./IMPLEMENTATION.md#m09--qualify-the-clouddatabase-baseline-and-cost-limits).

## Proposed baseline

| Decision | Proposal | Source |
|---|---|---|
| Region / project | `us-central1`, one dedicated project | MD04 |
| Database | Cloud SQL for PostgreSQL 16, one shared `db-f1-micro` Enterprise zonal instance, 10 GiB HDD, one database and least-privilege roles per app; Neon is the fallback if Cloud SQL misses cost or latency | MD05 |
| DB connections | Cloud SQL connector/Auth Proxy with IAM; no authorized networks; `ENCRYPTED_ONLY`; per-role `CONNECTION LIMIT` (runtime 5, migrator 2), `statement_timeout` and `idle_in_transaction_session_timeout` 30 s; PUBLIC revoked on every database and schema | M03 roles, M08 hosted pool limits |
| Backups | Automated daily backup, one retained, no point-in-time recovery for the MVP; restore drill is part of the suite | MD05 (tier chosen here) |
| Runtime | Cloud Run services: request billing (`cpuIdle`), min 0, max 1, concurrency 4, 60 s timeout, internal ingress plus Cloud Run IAM | MD02, M08 |
| Wake queue | One Cloud Tasks queue and one invoker identity **per app** (below) | MD12, M20 |
| Images | One Artifact Registry repository; keep five recent versions, delete untagged after a day | step 5 |
| Budget | Alerts at 50/80/100% of $50/month when the operator can manage the billing account; not a cap | MD06 |
| Emergency stop | Pause every app's wake queue (`provider/cloud-tasks.mjs` `pause`); tasks are kept and dispatched on resume. Admission stop for deployments arrives with M10/M12 | step 5 |

IaC and commands: [infra/mvp/m09](../../infra/mvp/m09/README.md).

## Wake queue design

Per app, created by [`provider/cloud-tasks.mjs`](../../infra/mvp/provider/cloud-tasks.mjs):

- Queue `<prefix>-wake-<app hash>`: 5 dispatches/s, 2 concurrent; retries unlimited within 72 h,
  backoff 1 s doubling to 300 s. The first five retries (1+2+4+8+16 s) already outlast the longest
  transaction (30 s action deadline); later ones ride out outages. Beyond 72 h, MD12 recovery
  re-enqueues overdue work on the next inbound request.
- Invoker identity `<prefix>-w-<app hash>`: `run.invoker` on that app's service only.
- App runtime: `cloudtasks.enqueuer` on its own queue only, and `iam.serviceAccountUser` (actAs)
  on its own invoker only. The Cloud Tasks service agent also gets actAs on the invoker so it can
  mint OIDC tokens.

So app A can neither enqueue on B's queue nor attach B's invoker. It can still create a task on its
own queue that targets B's URL, but that request carries A's invoker token, which B's Cloud Run IAM
rejects at the front end (403, not billed, no instance started) and which B's drain would also
reject (wrong `email`). The suite checks both.

Not yet integrated: `provider/cloud-run.mjs` `deploy()` still refuses an app service whose invoker
policy contains anything but the gateway, so redeploying an app after binding its wake invoker
fails closed. M13 must teach `deploy()` the wake invoker member.

## Documented limits (checked 2026-10-15)

| Limit | Value | Source |
|---|---|---|
| Schedule horizon | 30 days ahead (M20 clamps to it) | [Cloud Tasks quotas](https://docs.cloud.google.com/tasks/docs/quotas) |
| Name reuse after delete/execution | Up to 24 hours (9 days for queue.yaml queues) | [tasks.create](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/create) |
| Task size | 1 MiB (M20 envelopes ≤ 256 KiB) | quotas |
| Dispatch rate | 500/s per queue | quotas |
| Queues | 1,000 per region per project (adjustable) | quotas |
| API requests | 6,000,000/min per region (adjustable) | quotas |
| Task retention | 31 days | quotas |
| HTTP handler timeout | default 10 min, max 30 min | [HTTP target tasks](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks) |

Quotas are per project, not per workspace: one noisy app can exhaust the shared create quota and
make other apps' enqueues fail closed (`UNAVAILABLE`, write rolled back). Per-app queues bound
dispatch only. The 1,000-queue limit caps one-queue-per-app at 1,000 apps per project.

The M20 design does not depend on the reuse window: names include the PostgreSQL transaction ID,
and a retried drain's follow-up names derive from the current task name.

## Acceptance case map

`pnpm test:mvp:cloud` runs the ordered suite in [`qualify.mjs`](../../infra/mvp/m09/qualify.mjs)
with the real provider in [`gcp.mjs`](../../infra/mvp/m09/gcp.mjs). Each case is judged by a pure
evaluator; teardown runs on every path once anything may exist.

| Case | Suite checks |
|---|---|
| M09.a | `M09.a.baseline`: the applied baseline is usable (SQL runnable, zonal shared-core, no authorized networks, encrypted only, backups on, Docker repository). `M09.a.teardown`: owned-name inventory empty after teardown. Terraform destroy and a no-change plan are runbook steps. |
| M09.b | `M09.e.queue-probe` identity cases, run **as app A's runtime identity** in a Cloud Run job: platform-DB secret, signer secret and app B's secret 403; sign as the gateway 403; Cloud Run deploy API 403; SQL admin 403. `M09.c.connect-denials`: app A's runtime role gets 42501 on B's and the platform database. `M09.b.cross-app`: app B is never woken, allowed or started by A's tasks. `M09.b.builder`: the builder's only binding is image-repository writer. |
| M09.c | `M09.c.storage` and `M09.c.gateway-store`: `test:postgres` and `test:gateway-store` against the Cloud SQL instance (provider mode, zero skips). `M09.c.storm`: limit+5 concurrent runtime connections, exactly the limit succeed, the rest are 53300, the platform role still connects. `M09.c.restore`: on-demand backup, a later marker row, restore, checksum equal and marker gone. `M09.c.cold-latency`: 20 new connections, p50/p95. |
| M09.d | `M09.d.scaling`: actual service and serving-revision min 0, max 1, request billing, concurrency, internal ingress, IAM on. `M09.d.zero`: a ≥ 60 s interval of explicit zero in `run.googleapis.com/container/instance_count`. `M09.d.emergency-stop`: no dispatch while paused, delivery after resume. Worksheet review by the owner. |
| M09.e | `M09.e.queue-probe`: own task created, same name 409, other queue 403, other invoker 403, 30 days − 10 min accepted, 30 days + 1 h rejected 400, and the real M20 `cloudTasksWakeQueue` adapter returns `created` then `duplicate`. `M09.e.dedup-after-execution`: re-creating an executed name is 409. `M09.e.retry-503`: five 503 answers then 200, in order with non-shrinking backoff. `M09.e.delayed-wake`: a task due 40 min later is delivered only after its due time, the service was at zero before, and an instance started for it. `M09.e.oidc-claims`: every token verified by the real `@embody/auth` verifier and carried `email` and `email_verified: true`. `M09.e.unauthenticated`: anonymous and operator-token calls from outside are blocked and never reach the service. Queue cost and quota are in the worksheet. |

Deferred M05 provider proof (IDENTITY "Open acceptance") is covered here only for the M09 app
runtime identity and IAM. A rerun of the full M05 runtime/invocation probes with a live gateway
belongs to M17.

## Cost worksheet

List prices for `us-central1`, captured 2026-10-15 from
[Cloud SQL](https://cloud.google.com/sql/pricing), [Cloud Run](https://cloud.google.com/run/pricing),
[Cloud Tasks](https://cloud.google.com/tasks/pricing),
[Artifact Registry](https://cloud.google.com/artifact-registry/pricing) and
[Cloud Logging](https://cloud.google.com/stackdriver/pricing). Computed by
[`costs.mjs`](../../infra/mvp/m09/costs.mjs), which ignores free allowances (they are per billing
account), so it errs high.

| Unit | Price |
|---|---|
| Cloud SQL `db-f1-micro` / `db-g1-small` | $0.0105 / $0.035 per hour |
| Cloud SQL HDD / SSD storage | $0.000123288 / $0.000232877 per GiB-hour |
| Cloud SQL backups (used) | $0.000109589 per GiB-hour |
| Cloud SQL IPv4 while idle | $0.01 per hour |
| Cloud Run (request billing) | $0.000024 per vCPU-s, $0.0000025 per GiB-s, $0.40 per million requests; requests denied by IAM are not billed |
| Cloud Tasks | $0.40 per million operations (an API call or delivery attempt; first 1M/month free) |
| Artifact Registry | $0.000136986 per GiB-hour (0.5 GiB free) |
| Cloud Logging | $0.50 per GiB ingested (50 GiB/project free) |

**Monthly running baseline** (default assumptions: 5 apps × 20,000 actions, 150,000 gateway
requests, 3,000 cold starts per service, 2,000 durable items per app at 2 tasks each):

| Line item | Basis | USD/month |
|---|---|---|
| Cloud SQL instance | db-f1-micro, zonal, 730 h | 7.67 |
| Cloud SQL storage | 10 GiB HDD | 0.90 |
| Cloud SQL backups | 1 GiB used | 0.08 |
| Cloud Run CPU | 139,000 active vCPU-s | 3.34 |
| Cloud Run memory | 139,000 s × 0.5 GiB | 0.17 |
| Cloud Run requests | 270,000 incl. drains | 0.11 |
| Cloud Tasks | 20,000 tasks × (create + delivery) | 0.02 |
| Artifact Registry | 2 GiB images | 0.20 |
| Cloud Logging | 2 GiB | 1.00 |
| Egress, DNS, domain, Secret Manager | contingency | 3.00 |
| **Total** | | **16.49** (ceiling $50) |

The fixed floor is the SQL instance (about $8.65 with storage and backup). Everything else scales
with use. Per M20's F2 note every claimed item adds a lease-wake task about 61 s later, so the
worksheet counts two tasks per durable item; a 50-step fan-out is about 76 tasks. Cloud Tasks stays
cents even at 10× this volume; Cloud Run CPU for cold starts and drains dominates the variable
cost. Not included: a custom domain or load balancer (not planned for the MVP), Neon, HA, SSD.

**One-off qualification projection:** $3.41 conservative (SQL instance for 24 h, two
services charged as fully active for 4 h each, one hour of jobs, 10,000 task operations, 48
GiB-hours of backups, 0.5 GiB logs, $2 contingency). `test:mvp:cloud` refuses to create anything if
the projection exceeds the approved budget, and fails if the measured estimate does. Neither is
an invoice; the invoice check is a separate step after the run.

## Running the qualification (phase 2, after approval)

1. Apply the baseline ([commands](../../infra/mvp/m09/README.md#commands)) with
   `enable_postgres=true`; save `terraform output -json` to a private file.
2. Build the fixture image from the exact candidate with the existing `Dockerfile.m05`
   (`--build-arg EMBODY_SOURCE_SHA=$(git rev-parse HEAD)`, `linux/amd64`), push it to
   `<region>-docker.pkg.dev/<project>/embody-test-m09-images/fixture` and use the digest.
3. Install the Cloud SQL Auth Proxy locally (v2.26.0, as in `Dockerfile.m05`).
4. Run, with names only in any record:

   ```sh
   export EMBODY_MVP_CLOUD_PROJECT=<project> EMBODY_MVP_CLOUD_RESOURCE_PREFIX=embody-test-m09
   export EMBODY_MVP_CLOUD_BUDGET_USD=25 EMBODY_MVP_CLOUD_BUDGET_APPROVED=true
   export GOOGLE_APPLICATION_CREDENTIALS=<credential file>
   export EMBODY_M09_BASELINE=<terraform output file> EMBODY_M09_IMAGE=<image@sha256:...>
   export EMBODY_CLOUD_SQL_PROXY=<path to cloud-sql-proxy>
   pnpm build && pnpm test:mvp:cloud
   ```

   The run takes about 1.5 hours (the delayed wake is 40 minutes out so the service can reach zero
   first). Sanitized results land in `.artifacts/verification/mvp-cloud.json`.
5. Destroy the baseline, confirm a no-change plan and an empty owned-name inventory, then record
   the evidence, measured cost and invoice check under `docs/mvp/evidence/M09-<date>/`.

## Known risks to settle in phase 2

- **Zero representation.** The suite counts only explicit zero points of `instance_count` as
  zero; a gap in the series is not zero. If Cloud Monitoring reports no points at zero, the case
  fails and the reviewer must decide on another provider signal, not infer zero from silence.
- **Internal ingress and Cloud Tasks.** Services use internal-only ingress. Cloud Tasks should
  count as an internal source in the same project; if it does not, wakes fail and the design must
  fall back to `all` ingress plus IAM, which the suite's external checks would then cover.
- **actAs requirements.** The adapter grants actAs on the invoker to both the runtime and the
  Cloud Tasks agent. The probe shows whether the runtime grant is required (other-invoker 403).
- **Builder.** Only IAM bindings are inspected; a build that runs user code is MD09/M11.
- **Network containment (step 4) is open:** MD09 decides the isolated build provider and runtime
  egress controls. Until then, user deployment stays blocked.

## Owner inputs needed before phase 2

1. The GCP test project ID (MD04 records `embody-cloud`) and region (`us-central1`).
2. How credentials are provided: operator ADC on this machine, or a dedicated credential file.
3. Explicit approval to spend the one-off $25 M09 qualification budget (MD06).
4. Optionally, the billing account ID if the budget alert should be created by Terraform.
5. Whether MD09 (isolated build provider and runtime network controls) is decided now or in M11.
