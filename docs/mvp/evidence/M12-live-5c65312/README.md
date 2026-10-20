# M12 live qualification: durable deployment controller on real infrastructure

**Result: passed 10/10, zero skips.** Run `f45104` on the clean candidate `5c65312` (`dirty: false`), on 2026-10-20, in project `embody-cloud`, region `us-central1`, with prefix `embody-test-m12`. The owner approved a budget of up to $6 on 2026-10-20. The sanitized results are in [`mvp-cloud-m12.json`](./mvp-cloud-m12.json). Contract and case list: [DEPLOYMENTS](../../DEPLOYMENTS.md#live-suite-test-mvp-cloud-suite-m12-owner-approved-budget-only).

```sh
EMBODY_MVP_CLOUD_SUITES=m12 EMBODY_MVP_CLOUD_PROJECT=embody-cloud \
EMBODY_MVP_CLOUD_RESOURCE_PREFIX=embody-test-m12 EMBODY_MVP_CLOUD_BUDGET_USD=6 \
EMBODY_MVP_CLOUD_BUDGET_APPROVED=true EMBODY_MVP_CLOUD_CREDENTIALS=gcloud \
EMBODY_CLOUD_SQL_PROXY=<cloud-sql-proxy v2.26.0> caffeinate -i node scripts/test-mvp-cloud.mjs
```

## Setup

- **Worker.** A Cloud Run service runs the repository image built from `Dockerfile.m05` at the candidate. It uses the controller identity, scales between 0 and 2 instances, and accepts only the controller invoker's OIDC tasks.
- **Queue.** The controller queue is a Cloud Tasks queue that retries for up to 72 hours, backing off from 1 s to 300 s.
- **Platform database.** A `db-f1-micro` Cloud SQL instance with PostgreSQL 16, no authorized networks and TLS only. The maintenance and runtime roles are restricted as in M03 and created through the Auth Proxy; the worker reaches the database over the Cloud SQL socket and reads its URL from Secret Manager.
- **Builds.** Real Cloud Build with the M11 recipe and builder identity, building the clean request-only scaffold.
- **Gateway.** The operator machine played the gateway and closed it after every request.

## Cases

| Case | Observed |
|---|---|
| `M12.live.iam` | The worker holds exactly the 10 controller grants: builder `actAs`, builds-repository `repoAdmin`, invoker `actAs`, `objectAdmin` on outputs and on logs, project `cloudbuild.builds.editor` and `cloudsql.client`, queue enqueuer, read-signer token creator and secret accessor. The invoker holds only `run.invoker` on the worker. No owner or editor role. |
| `propagation` | The worker accepted the invoker's token after 47 s (4 attempts). |
| `M12.a.c.chain-zero-gateway` | After the `202` the gateway was gone and 4 duplicate tasks were added. The worker exited at three planted points, and each time Cloud Tasks redelivered to a new instance: after its first claim, after creating the build but before recording it, and after promotion but before the acknowledgement. The deployment reached **active** at attempt 1 with **1 build** (adopted by tag), 1 candidate and generation 1 → 2, all 3 faults fired, in 404 s. |
| `M12.a.lost-task` | The deployment was committed without its task. A status read through a fresh gateway (`200`) re-enqueued it, and it reached active with 1 build and generation + 1, in 171 s. |
| `M12.a.rolled-back` | The task was enqueued but the transaction rolled back. The delivered task did nothing: no deployment row, and the source was not pinned. |
| `M12.b.cancel-during-build` | Cancelled while building (`200`). The Cloud Build build was `CANCELLED` and the artifact was rejected `CANCELLED`. No release, no candidate, and the generation did not change. |
| `M12.b.promotion-race` | Two deployments of one app on two worker instances: one became active and the other failed `STALE_GENERATION`, with exactly one generation step. |
| `M12.c.queue-pause` | The queue was paused while the deployment was building. Its epoch did not change for the 2-minute hold. After resume it reached active in 20 s. |
| `M12.d.ingress` | Requests to the real worker URL: anonymous, operator ID token, invoker token for the wrong audience, and another service account's token were all refused (`401`/`403`). A body carrying a URL got `400`. A foreign workspace got `200 missing`. The real invoker token got `200`. The deployment's epoch did not change. |
| `cleanup` | Removed: the service, queue, secret, Cloud SQL instance, 5 service accounts, 3 buckets and 2 repositories. The inventory was empty and project IAM was unchanged. |

An independent check after the run found 0 Cloud SQL instances, Cloud Run services, queues, service accounts, repositories, buckets, secrets and project bindings with the prefix.

## Earlier runs on this branch (all failed closed, none promoted anything)

| Run | Candidate | Outcome | Fix |
|---|---|---|---|
| `a03e9f`, `eef0ab`, `74cea3` | `da45f71` (+ diagnostics) | The proxy refused connections: the instance was still `PENDING_CREATE` after its insert operation finished (ephemeral-certificate `409`). Teardown was complete and the inventory empty. | Wait for the instance to be `RUNNABLE` (`ed5fc6e`) |
| `4ab5cd` | `ed5fc6e` | The cases ran, then the operator process crashed: the server dropped an idle connection through the local proxy, and the pool had no `error` listener. Teardown did not run. The suite's own teardown was then run manually for that run ID, and the inventory and project IAM were verified empty. | Error listeners on every pool in the live suite and fixtures (`5c65312`) |

Neither failure was in the controller.

## Cost

| | Amount |
|---|---|
| Measured build time, this run | 7.1 build-minutes over 6 builds |
| Suite's conservative estimate, this run | $0.53 (it charges the database for 4 hours) |
| Conservative estimate, all five runs | ≈ $2.49 of the $6 approved: $0.49 × 4 + $0.53 |
| List-price estimate, all five runs | about $0.35: about 15 build-minutes, about 3 Cloud SQL hours, cents for Cloud Run, Tasks, storage and logs |

The invoice check is open. The running worksheet delta is ≈ $0.17/month ([DEPLOYMENTS](../../DEPLOYMENTS.md#cost)).

## Limits of this evidence

- Provisioning and checks used fixture candidates (rows in the platform database). Real Cloud Run candidates and promotion of a route are M13.
- The live worker used `INGRESS_TRAFFIC_ALL` plus Cloud Run IAM so the suite could probe it from outside. Production uses internal ingress, which Cloud Tasks reaches (M09).
- The expired-token case and the full kill matrix are local (`test:m12`), because a live provider token cannot be made to expire on demand.
