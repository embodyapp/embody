# M09 live qualification (run `027dddff`, candidate `3ef5f28`)

```text
Task / acceptance cases: M09.a–e
Owner / reviewer: claude / independent review pending
Date: 2026-10-18, 09:04:43–10:20:38 UTC (suite); baseline 2026-10-15 09:44 – 2026-10-18 10:23 UTC
Candidate: 3ef5f28fd0cb2a8cd02bed2d0beb6e33be9cc5a0 (CI 9/9 green on PR #47). The report says
  dirty=true: the only uncommitted change was docs/mvp/M09-QUALIFICATION.md (connection-budget
  text, committed afterwards); no code differed.
Fixture image: us-central1-docker.pkg.dev/embody-cloud/embody-test-m09-images/fixture@sha256:903daf2be99b499a1d6fa049f66d811495e4c374d50a44532c30e6ce76699344
  (built from git archive of 3ef5f28 with Dockerfile.m05, linux/amd64, revision label 3ef5f28)
IaC: infra/mvp/m09 (Terraform 1.16.5, google 8.6.0), state gs://embody-cloud-tfstate-930896908754/mvp/m09/baseline
Runtime: operator Node 24.21.0; fixture image Node 22; Cloud SQL PostgreSQL 16.15 (db-f1-micro, zonal, 10 GiB HDD)
Environment: real cloud, project embody-cloud, us-central1, prefix embody-test-m09
Credentials: operator gcloud login (EMBODY_MVP_CLOUD_CREDENTIALS=gcloud); no key or ADC file
Command: pnpm test:mvp:cloud with EMBODY_MVP_CLOUD_PROJECT, EMBODY_MVP_CLOUD_RESOURCE_PREFIX,
  EMBODY_MVP_CLOUD_BUDGET_USD=25, EMBODY_MVP_CLOUD_BUDGET_APPROVED, EMBODY_MVP_CLOUD_CREDENTIALS,
  EMBODY_M09_BASELINE, EMBODY_M09_IMAGE, EMBODY_CLOUD_SQL_PROXY, EMBODY_M09_RUN_ID (names only)
Result: passed, 19 cases passed, 0 failed, 0 skipped
```

Sanitized report: [`mvp-cloud.json`](./mvp-cloud.json). It contains statuses, counts, timings and
public resource names only; no token, password or connection string.

## Results by acceptance case

| Case | Live result |
|---|---|
| **M09.a** | Fresh `terraform apply` of a reviewed saved plan: 21 creates, 0 changes, project IAM unchanged. `M09.a.baseline`: SQL runnable, zonal shared-core, no authorized networks, `ENCRYPTED_ONLY`, backups on, Docker repository. `M09.a.teardown`: owned-name inventory empty after the suite. Baseline destroyed with a reviewed destroy plan (21 destroyed); see Cleanup. |
| **M09.b** | Queue probe run as app A's runtime identity (`embody-test-m09-r-49660c6779ed`, metadata credentials): platform-DB secret, signer secret and app B's secret 403; `signJwt` as the gateway 403; Cloud Run deploy API 403; SQL admin 403; app B's queue 403; app B's invoker 403. App A's runtime role: CONNECT to app B's and the platform database denied with `42501`. App B was never woken: 16 requests from A's cross-app task, all refused 403 by Cloud Run IAM, no instance start. Builder: its only binding is `artifactregistry.writer` on the image repository. |
| **M09.c** | In-region Cloud Run job through the Cloud SQL Auth Proxy: `test:postgres` 16/16 and `test:gateway-store` 43/43 on Cloud SQL (provider mode), zero skips. Connection storm: 10 concurrent runtime connections against a role limit of 5, exactly 5 succeeded, 5 refused with `53300`, the platform role still connected, slots released afterwards. Restore: on-demand backup, a later marker row, restore to the instance in 924 s; checksum equal, marker gone. New-connection latency from us-central1, 20 trials: p50 35 ms, p95 43 ms, max 45 ms (Cloud SQL does not suspend, so this is the cold-connection figure). |
| **M09.d** | Actual service and serving revision: min 0, max 1, request billing (`cpuIdle`), concurrency 4, internal ingress, IAM on. `instance_count` reported explicit zeros 09:32:40–09:38:40, then no points; no platform-logged instance start and no request until the delayed task was due, so the service was at zero. Emergency stop: queue paused, task created 60 s later, nothing delivered in 120 s, delivered after resume. Cost worksheet: [M09-QUALIFICATION.md](../../M09-QUALIFICATION.md#cost-worksheet), owner review pending. |
| **M09.e** | Task 40 minutes out delivered 1.1 s after its due time, never before, with a platform-logged cold start for it. Same name 409 before and after execution. 30 days − 10 min accepted, 30 days + 1 h rejected (400). Five 503 answers then 200: retry gaps 1.6, 3.0, 4.0, 8.0, 16.0 s. The real M20 `cloudTasksWakeQueue` adapter: `created`, then `duplicate`. Every delivered OIDC token (10) carried `email` and `email_verified: true` and passed the real `@embody/auth` verifier. Anonymous and operator-token calls from outside: 404 (internal ingress), never reached the service. Queue cost and quota: worksheet and documented limits. |

## Findings from the live runs (all fixed before this run)

Runs 2–5 and two SQL-only checks (2026-10-15 to 2026-10-18) found:

1. **Cross-database isolation (bootstrap bug).** A non-owner `REVOKE ... FROM PUBLIC` is silently a
   no-op, so app A's runtime role could connect to app B's and the platform database. The
   bootstrap now runs owner-scoped statements under `SET ROLE <owner>`; denial is now `42501`.
2. **Zero reporting.** `instance_count` reports zeros for about seven minutes after scale-down and
   then nothing until the next instance. Silence alone is not counted as zero; the rule is an
   explicit zero plus no platform-logged start and no request. M17 must use the same rule.
3. **Pause is not instant.** A task created right after `queues.pause` returned was still
   delivered 2.5 s later. The emergency stop allows a minute to take effect.
4. **Operator environment.** A sleeping laptop froze timers and dropped provider calls; operator
   runs need `caffeinate` and mains power. Provider calls now have hard deadlines, retries for
   reads and 429s, and token refresh on 401.
5. **Remote SQL timing.** From the operator laptop the conformance suites time out on round-trip
   latency (connection p50 796 ms); they run in-region instead.
6. **Fixture connection limit.** The M03 suites open 20 concurrent boots, so role limits are
   applied only for the storm.
7. **Cloud Tasks reaches internal-ingress Cloud Run services**, and OIDC tokens carry `email` and
   `email_verified` (both were open questions from M20).

## Connection budget

`max_connections` 25, 3 superuser-reserved, 2 held by `cloudsqladmin`: about 20 usable. With
5-connection pools and one instance each, the gateway plus 3 apps fit at full pool; more apps
share slots and fail closed (`53300`) when exhausted. See
[M09-QUALIFICATION.md](../../M09-QUALIFICATION.md#connection-budget-measured-2026-10-18).

## Cleanup (verified 2026-10-18 10:23 UTC)

- Suite teardown: owned-name inventory empty (services, jobs, queues, invoker/runtime/migrator
  and SQL-job identities, secrets, conditional `cloudsql.client` binding).
- Baseline: reviewed destroy plan applied, 21 destroyed (SQL instance and its backups, image
  repository with images, platform identities, secret containers). Terraform state empty; a
  destroy plan reports no changes.
- Provider inventory for `embody-test-m09`: 0 SQL instances, services, jobs, queues, service
  accounts, secrets and repositories. Project IAM bindings identical to before the first apply.
- Retained on purpose: the private versioned state bucket shared with M05, and enabled APIs
  (`disable_on_destroy=false`). Deleted queue names stay reserved for up to seven days.
- Operator-side private fixture files (random passwords) deleted; redacted diagnostic logs kept
  outside the repo.

## Spend

Conservative estimate from list prices (2026-10-15) and measured lifetimes; **not an invoice**:

| Item | Basis | USD |
|---|---|---|
| Cloud SQL | db-f1-micro + 10 GiB HDD, 72.6 h | 0.85 |
| Backups | daily automated + on-demand drills | 0.10 |
| Cloud Run services | ~16 service-hours over all runs, charged as fully active 1 vCPU + 1 GiB | 1.53 |
| Cloud Run jobs | queue probes and 3 SQL jobs (2 vCPU, 4 GiB) | 0.15 |
| Logging, images, tasks | < 1 GiB logs, ~3 GiB images for ~3 days, < 10,000 task operations | 0.30 |
| Contingency | | 2.00 |
| **Total** | | **≈ $4.93** (approved one-off budget $25) |

The suite's own estimate for run 6 was $3.45. The invoice check for the billing period remains
open (as for M05).

## Known gaps and residual risks

- `provider/cloud-run.mjs` `deploy()` still refuses a service whose invoker policy holds the wake
  invoker; M13 must accept it.
- Cloud Tasks quotas are per project, shared by all workspaces; per-app queues bound dispatch only.
- The connection budget limits guaranteed simultaneous apps to three on `db-f1-micro`.
- MD09 is deferred to M11: user source must not be deployed until then.
- Durable drains still bypass the M07 audit/quota ledger (DURABLE.md).
- Budget alerts were not created (no billing account supplied); alerts are not caps anyway.
- Cold-latency targets for gateway/app (MD06) are M17's measurement; M09 records DB connection
  latency only.

Reviewer decision: **ACCEPTED** by an [independent review](./independent-review.md) of `308edf8` (no blockers; DONE conditional on the owner's worksheet review C1 and the documentation corrections C2, made in [M09-QUALIFICATION.md](../../M09-QUALIFICATION.md#shared-instance-privileges)).
