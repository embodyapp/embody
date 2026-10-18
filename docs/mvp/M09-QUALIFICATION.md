# M09 cloud, database and wake-queue qualification

Status: **live-run and passed** on candidate `3ef5f28` (run `027dddff`, 2026-10-18): 19/19 cases,
zero skips, full cleanup. [Evidence](./evidence/M09-live-3ef5f28/README.md). Independent review
accepted; owner approved the worksheet (keep `db-f1-micro`) on 2026-10-18. **M09 is DONE.** Task definition: [IMPLEMENTATION M09](./IMPLEMENTATION.md#m09--qualify-the-clouddatabase-baseline-and-cost-limits).

## Proposed baseline

| Decision | Proposal | Source |
|---|---|---|
| Region / project | `us-central1`, one dedicated project | MD04 |
| Database | Cloud SQL for PostgreSQL 16, one shared `db-f1-micro` Enterprise zonal instance, 10 GiB HDD, one database and least-privilege roles per app; Neon is the fallback if Cloud SQL misses cost or latency | MD05 |
| DB connections | Cloud SQL connector/Auth Proxy with IAM; no authorized networks; `ENCRYPTED_ONLY`; per-role `CONNECTION LIMIT` (runtime 5, migrator 2), `statement_timeout` and `idle_in_transaction_session_timeout` 30 s (set, not exercised live); PUBLIC revoked on each **app and platform** database and its `public` schema (not on `postgres`/`template1`; see below) | M03 roles, M08 hosted pool limits |
| Backups | Automated daily backup, one retained, no point-in-time recovery for the MVP; restore drill is part of the suite | MD05 (tier chosen here) |
| Runtime | Cloud Run services: request billing (`cpuIdle`), min 0, max 1, concurrency 4, 60 s timeout, internal ingress plus Cloud Run IAM | MD02, M08 |
| Wake queue | One Cloud Tasks queue and one invoker identity **per app** (below) | MD12, M20 |
| Images | One Artifact Registry repository; untagged versions are deleted after a day. The KEEP-5 rule only protects the five newest; tagged versions beyond five are **not** deleted (open item) | step 5 |
| Budget | Alerts at 50/80/100% of $50/month when the operator can manage the billing account; not a cap | MD06 |
| Emergency stop | Pause an app's wake queue (`provider/cloud-tasks.mjs` `pause`, per app; there is no pause-all command yet); tasks are kept and dispatched on resume, and a pause takes seconds to apply. Admission stop for deployments arrives with M10/M12 | step 5 |

IaC and commands: [infra/mvp/m09](../../infra/mvp/m09/README.md).

## Connection budget (measured 2026-10-18)

`db-f1-micro` reports `max_connections` 25, of which 3 are reserved for superusers and 2 are held
by Cloud SQL's own `cloudsqladmin`, leaving **about 20** for the gateway and apps. Hosted pools
open at most 5 connections per instance (host and gateway) and close idle ones after 1 s, so
connections are held only while requests run.

| Consumer | Instances | Pool | Role `CONNECTION LIMIT` |
|---|---|---|---|
| Gateway | 1 | 5 | 5 |
| Each app | 1 (adapter `maxInstanceCount`) | 5 | 5 |

Guaranteed simultaneous full pools: the gateway plus **3 apps**. More apps share the remaining
slots: when they are exhausted PostgreSQL refuses the connection (`53300`) and the request fails
closed (`UNAVAILABLE`); the per-role limit stops one app from taking every slot (qualified by the
storm case). Allowing 3 instances per app (15 connections) would not fit at all on this tier.
Options when the MVP needs more: smaller hosted pools (code change, no cost), or `db-g1-small`
(50 connections, +$0.0245/h ≈ **+$17.89/month**, baseline about $34.38, inside the $50 ceiling).
The controller (M13) must set each app role's limit to pool × max instances.

## Pooling semantics

The selected pooling is **application-side `pg` pools** (at most 5 connections per gateway or app
instance, idle connections closed after 1 s) through the Cloud SQL connector or Auth Proxy. There
is no server-side transaction pooler (no PgBouncer, no Cloud SQL managed pooling), so every
checkout is a full PostgreSQL session: `SET ROLE`, `SET LOCAL` tenant context for RLS, GUCs and
advisory locks behave exactly as in the M03 fixture. The live run exercised this through the
storage (16) and gateway-store (43) conformance suites on Cloud SQL and the connection storm.
A transaction pooler would need a separate qualification of `SET LOCAL`/RLS and advisory locks.

## Shared-instance privileges

- PUBLIC `CONNECT`/`TEMP` is revoked on each app and platform database and PUBLIC is revoked on
  their `public` schemas, as the owner (live: cross-database CONNECT is `42501`).
- **Not revoked:** the `postgres` and `template1` databases keep PostgreSQL's default PUBLIC
  `CONNECT`/`TEMP`, so an app runtime role can connect to `postgres`. **M13 must revoke PUBLIC
  `CONNECT` on `postgres` and `template1`** when it provisions the shared instance.
- **Accepted residual:** cluster-wide catalogs (`pg_database`, `pg_roles`, `pg_stat_activity`)
  let any app role see other apps' database and role names and whether sessions exist (not query
  text or data). Database and role names must therefore never carry customer data.
- `ALTER DEFAULT PRIVILEGES` is not used; PUBLIC `EXECUTE` on functions follows PostgreSQL
  defaults, and the storage migrations grant only `STORAGE_RUNTIME_FUNCTIONS` explicitly. M13
  should review function `EXECUTE` grants per app.
- Fixture passwords are set with `CREATE ROLE ... PASSWORD`; if such a statement errors it can
  reach `postgres.log`. The M13 controller must set passwords so they stay out of statement logs.

## Open items before real tenants (step 5, owned by M10–M16/M18)

- **Alerts:** no budget alert exists (needs a billing account) and no Monitoring alert policy.
- **Emergency stop:** per-app queue pause only; add pause-all and the deployment admission stop.
- **Logs:** no exclusion, retention or volume bound (`log_connections=on`, task log sampling 1 in
  the fixture).
- **Images:** bound tagged versions too (the KEEP rule only protects); per-app repositories or
  immutable tags so a build cannot overwrite another app's or the gateway's tag (M11). **M11:** app
  images go to a separate builds repository with immutable tags, admission binds digests from the
  provider record, and `purgeArtifacts`/`cleanupOrphanedImages` bound retained versions
  ([BUILDS](./BUILDS.md#retention-and-cleanup)); the platform repository stays builder read-only.
- **Secrets:** no secret-version lifecycle.
- **Builds and source storage:** M10 source storage and the M11 build recipe exist ([SOURCES](./SOURCES.md), [BUILDS](./BUILDS.md)); M11's live run qualifies them on Cloud Build.
- **Restore:** Cloud SQL restores the whole shared instance (about 15 minutes, every app rolled
  back). Per-app recovery needs restore-to-new-instance plus a per-database copy (M16).
- **Invoker tokens:** each app can make Cloud Tasks mint its own invoker's OIDC token for any
  audience, so nothing but that app's own drain may ever trust a wake-invoker token.
- **Evaluator hardening:** the emergency-stop check should compare the delivery time with the
  resume time; isolation should count any non-403 status as allowed; identity negatives should
  record the error reason (403 can also mean a disabled API).
- **Builder scope:** the check does not cover who may act as the builder or the state bucket. M11
  inspects every binding the builder holds on its run's resources and the project; only the
  controller (M12) may act as the builder.

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

   Keep the operator machine awake and on mains power for the whole run (`caffeinate -i`,
   lid open): a sleeping laptop freezes timers and drops provider connections mid-run, which
   is what stalled the first live attempts. The run takes about 1.5 hours (the delayed wake is 40 minutes out so the service can reach zero
   first). Sanitized results land in `.artifacts/verification/mvp-cloud.json`.
5. Destroy the baseline, confirm a no-change plan and an empty owned-name inventory, then record
   the evidence, measured cost and invoice check under `docs/mvp/evidence/M09-<date>/`.

## Settled by the live runs

- **Zero representation:** `instance_count` reports explicit zeros for about seven minutes after
  scale-down, then no points. Zero before a due time = an explicit zero plus no platform-logged
  instance start and no request since. Silence alone never counts.
- **Internal ingress:** Cloud Tasks reaches internal-only services in the same project.
- **actAs:** the runtime cannot attach another app's invoker (403), so per-app invokers hold.
- **Pause:** takes a few seconds to stop dispatch; the emergency stop allows a minute.
- **Bootstrap:** PUBLIC must be revoked as the database owner (a non-owner REVOKE is a no-op).
- **Builder:** only IAM bindings are inspected; a build that runs user code is MD09/M11.
- **Network containment (step 4):** MD09 deferred to M11; user deployment stays blocked.

## Owner inputs (answered 2026-10-15)

1. The GCP test project ID (MD04 records `embody-cloud`) and region (`us-central1`).
2. How credentials are provided: operator ADC on this machine, or a dedicated credential file.
3. Explicit approval to spend the one-off $25 M09 qualification budget (MD06).
4. Optionally, the billing account ID if the budget alert should be created by Terraform.
5. Whether MD09 (isolated build provider and runtime network controls) is decided now or in M11.

Answers: `embody-cloud`, `us-central1`, the operator's gcloud login, $25 approved, no billing
account (no budget alert), MD09 delegated and deferred to M11.
