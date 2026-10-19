# M12: durable deployment controller

Implementation: records, rules and the store contract in [`@embody/gateway` `deployment.ts`](../../packages/gateway/src/deployment.ts); the controller and the deployment worker in [`deployment-controller.ts`](../../packages/gateway/src/deployment-controller.ts); the management routes in [`deployment-routes.ts`](../../packages/gateway/src/deployment-routes.ts); persistence in the memory and PostgreSQL gateway stores ([`store.ts`](../../packages/gateway/src/store.ts)); the shared queue adapter and task ingress in [`@embody/host` `tasks.ts`](../../packages/host/src/tasks.ts). Task definition: [IMPLEMENTATION M12](./IMPLEMENTATION.md#m12--durable-deployment-controller).

M12 turns an accepted submission into one active release, or a visible failure, without any process holding a timer. The gateway commits the deployment and its first queue task and answers at once. A separate **deployment worker** does everything else, one bounded step per delivered task, so a deployment keeps going while the gateway has zero instances. Provisioning and readiness checks are ports that M13 implements against Cloud Run; M12 drives them, promotes, cancels and recovers.

```text
CLI ──POST /deployments──► gateway ──one transaction──► platform DB: deployment row (= job),
                              │                           idempotency key, source pin, audit
                              └─ before COMMIT ─► Cloud Tasks (controller queue): wake task
202 + deployment ID ◄─────────┘
                                   Cloud Tasks ──OIDC (controller invoker)──► deployment worker
                                                                                │ claim (lease, epoch)
                                     validating → building (M11 start/settle) → provisioning (M13)
                                     → checking (M13) → promoting (CAS) → active
                                                                                │ fenced completion
                                                    next wake, before COMMIT ◄──┘
```

## State machine

States, attempts and delays are the [M02 contract](./CONTRACTS.md#durability-retries-and-fencing): `accepted → validating → building → provisioning → checking → promoting → active`; every nonterminal state can end `failed` or `cancelled`; `active`, `failed` and `cancelled` are terminal and immutable. Every state change is checked against `DeploymentTransitionSchema`.

| State | Work (one bounded step per task) | Leaves by |
|---|---|---|
| `accepted` | none | `validating` |
| `validating` | `verifySubmissionSource` (M10): verified, unexpired, same app, digest and size | `building`, or `failed INVALID_INPUT` |
| `building` | attempt N: `BuildAdmission.start` once (artifact record per attempt), then `settle` every 15 s | `provisioning` (admitted), next attempt (`DEPENDENCY_UNAVAILABLE`), `failed` (any other rejection) |
| `provisioning` | `stages.provision` (M13): candidate from the admitted digest, named and labelled from platform records | `checking`, retry, or `failed` |
| `checking` | `stages.check` (M13): readiness and smoke | `promoting`, retry, or `failed CHECK_FAILED` |
| `promoting` | promotion CAS (below) | `active`, or `failed STALE_GENERATION` |

Public errors are the fixed M02 messages. The operator-facing `reason` (for example `BUILD_LOCKFILE_REJECTED`, `WORKER_LOST`, `DEADLINE_EXCEEDED`) is stored on the record and never returned by the API. Rejected builds map to `INVALID_INPUT` (source), `UNSUPPORTED_PROFILE` (profile or capability mismatch), `LIMIT_EXCEEDED` (output size), `CANCELLED`, or `BUILD_FAILED`.

## The deployment row is the job

There is no separate job table that could disagree with the state. Each row carries the job fields:

- `dueAt`: when work is next due.
- `epoch`: a fencing token that advances on every claim, completion, cancellation and cleanup.
- `leaseToken`/`leaseUntil`: the claim. A claim is a transaction that locks the row, checks it is due and not leased, advances the epoch, writes a random token and a lease of **180 s**, and enqueues a **lease wake** for lease expiry + 1 s before it commits.
- `crashes`: consecutive claims that never completed in this stage attempt.
- `cleanup`: the deployment ended but a build or candidate may still exist.

A worker runs the stage, then completes under its fence (`epoch` and `leaseToken`); a completion whose claim was superseded (another claim, a cancellation, a terminal state) fails with `StaleDeploymentError` and commits nothing. Every completion also re-validates the workspace and the app: if the app was disabled or deleted (its `lifecycleFence` moved) or re-generated (another promotion, or any catalog write: generation is conservative, see [WORKSPACES](./WORKSPACES.md)), the deployment fails `STALE_GENERATION` at that transition. This is M02's "authorize workspace, epoch and current job at each privileged transition".

**Wake before commit (MD12).** Every transaction that makes work due enqueues its task before COMMIT, through the store's wake hook; a queue failure rolls the write back (submission answers `503`, nothing persisted). Task names hash the deployment, epoch, reason, due time and PostgreSQL transaction ID, so a retried transaction never reuses a name. A task can arrive before its transaction is visible (the worker sees no row and the transaction is still `in progress`: `503`, the queue retries) or after it rolled back (`200`, nothing to do).

**Tasks are only wake-ups.** A body is `{v, kind, workspaceId, appId, deploymentId, reason, epoch, txid?}`, strict, at most 1 KiB. It carries no URL, header, resource name, image or credential: provider resources and endpoints come from platform configuration and records (the recipe, the artifact's `imageReference`, candidate names from workspace/app/deployment IDs). A body naming another workspace or app finds nothing (`missing`). A task that finds the deployment leased or not yet due either re-arms itself for the lease expiry or due time (when it is the newest wake for that epoch) or is dropped as `superseded` (a later epoch committed its own wake in the same transaction).

## Leases, attempts, deadlines (step 5)

`DEPLOYMENT_LIMITS` is the executable source of these values.

| Item | Value | Why |
|---|---|---|
| Lease | 180 s | Longer than the handler deadline plus the longest provider call chain of one step (about 70 s: DB, Cloud Build find/submit, signBlob, each 5–15 s) |
| Handler deadline | 45 s | Under the worker's request timeout. A handler over it is not completed: its lease keeps everyone out until it expires |
| Build poll | 15 s | M11: settle promptly; the build deadline is 20 minutes after the artifact is created |
| Stage attempts / delays | 3 / 5 s, 30 s | M02 |
| Lost claims per attempt | 3 | A crash-looping or always-timing-out stage becomes a failed attempt (`WORKER_LOST`) |
| Poll errors per build attempt | 8, backoff 15 s doubling to 120 s | Then the attempt counts as failed |
| Deployment deadline | 2 h | Any claim after it fails the deployment `DEPENDENCY_UNAVAILABLE` (`DEADLINE_EXCEEDED`) and cleans up |
| Recovery grace / batch | 60 s / 10 | MD12 recovery below |
| Active deployments | 3 per app, 10 per workspace | `429 LIMIT_EXCEEDED` |

**Transient vs permanent.** A thrown error or a retryable stage result is transient: the next attempt after the M02 delay, or `failed DEPENDENCY_UNAVAILABLE` after the third. A build rejected `DEPENDENCY_UNAVAILABLE` is a new attempt with a new build, including the rejection an overdue `settle` produces when it still cannot read the provider (BUILDS N2). Every other build rejection, a `CHECK_FAILED`, an invalid source or a promotion CAS loss is permanent.

**Recovery bounds** (worker replacement, M12.c). A worker that dies mid-step is replaced when its lease wake arrives: at most **lease + 1 s (181 s)** after the claim, plus queue delivery latency. A step whose worker keeps dying fails visibly after at most 3 attempts × 3 lost claims × 181 s + 35 s of delays (about 28 minutes). With the controller queue's retry policy (backoff 1 s doubling to 300 s, unlimited attempts within 72 h, as the [M09 wake queue](./M09-QUALIFICATION.md#wake-queue-design)), a worker or queue outage resumes within **300 s** of both being available again; tasks created before a queue *dispatch* outage (paused queue) are kept and dispatched on resume. A queue *create* outage fails the write that needed the task, so nothing is committed without its wake.

## Recovery without a sweep (MD12)

Committed work always has a task, but tasks can still be lost outside the platform's control (an operator purge, retries exhausted after 72 h). Recovery re-enqueues a `recover` wake for nonterminal deployments (and pending cleanups) overdue by more than 60 s with no live lease, at most one per deployment, epoch and minute, 10 per pass. It runs:

- after every task the worker handles (any deployment's task heals the others);
- after every authenticated deployment request to the gateway (submit, status), scoped to that workspace and bounded to 2 seconds; it never fails the request;
- on `POST /_embody/tasks/reconcile` to the worker (same authentication as tasks), for operators.

There is no periodic sweep and no gateway timer: an idle platform with no deployments in flight creates no tasks and wakes nothing. A deployment whose tasks were all lost and that nobody looks at waits for the next request or reconcile.

## Submission, idempotency and source pinning (step 1)

`POST /v1/workspaces/:ws/apps/:app/deployments` with a [`DeploymentSubmission`](./CONTRACTS.md#api-and-cli-mapping) (16 KiB):

1. Authenticate (workspace credential), exact `deployment:submit` grant, durable quota/audit admission (M07).
2. `verifySubmissionSource` (M10).
3. One transaction under the workspace lock: replay or conflict by `(workspace, app, idempotencyKey)` and `submissionFingerprint` (same key and body, in any key order, returns the original deployment with `200`, even after it finished; a different body is `409 IDEMPOTENCY_CONFLICT`); the app must exist (`404`), be enabled (`403`) and be at `expectedGeneration` (`409 STALE_GENERATION`); the source is re-checked under lock and **pinned** (CAS on its revision: a concurrent purge fence fails the submission) for the deployment's 90-day retention; the deployment row is inserted (`accepted`, attempt 1, epoch 1, deadline 2 h) and the first task enqueued.
4. `202` with the `DeploymentStatus`; no build is waited for.

`GET …/deployments/:id` returns the status (`deployment:read`). `GET /v1/workspaces/:ws/apps/:app` returns `AppStatus` (`app:read`): `generation`, `lifecycleFence`, status and `activeReleaseId`; read it before submitting. Errors: `400` invalid, `401` unauthenticated, `403` permission or disabled app, `404` unknown or unauthorized app/deployment (other workspaces and apps are never revealed), `409` key conflict, stale generation or cancellation conflict, `413` body too large, `429` quota or active-deployment limit, `503` store or queue outage.

## Promotion (serialized per app)

The promoting step's completion is one transaction that locks the workspace row (the same serialization point as every catalog write), then the deployment and its admitted artifact, evaluates M02 `canPromote` (deployment `promoting`, app enabled, generation, lifecycle fence and cancellation fence all as captured) and, if it holds:

- inserts the release record (`rel_…`, the deployment, the artifact, its digest `imageReference`, and a `ReleaseManifest` validated against the contract, embedding the admitted artifact manifest);
- CAS-updates the catalog app: `activeRelease`, generation + 1, revision + 1, workspace revision + 1;
- pins the artifact to the release (`pinnedBy`), so retention never purges it;
- marks the deployment `active`.

Two deployments of one app that both reach promotion: one wins, the other fails `STALE_GENERATION`. A late or cancelled worker fails its fence. **M13 extends this same transaction** with the candidate's route and manifest switch (M13.a); M12 does not change the catalog registration.

## Cancellation and cleanup (step 4)

`POST …/deployments/:id/cancel` with `AppManagement` `{operation: "cancel", deploymentId, cancellationFence}` (`deployment:cancel`). One transaction: if the deployment is nonterminal and the fence matches, the fence and the epoch advance (any claim is now stale) and it ends `cancelled`. Repeating the request returns the cancelled status without advancing the fence again. Cancelling an `active` or `failed` deployment, or with a stale fence, is `409`. Cancellation does not undo applied database mutations.

A deployment that ends `failed` or `cancelled` from building or later gets a cleanup wake: the worker cancels any running build of every attempt (`BuildAdmission.abandon`: provider cancel, record rejected `CANCELLED` unless `settle` decided first) and calls `stages.abandon`, which removes candidates only when their ownership labels (workspace, deployment) match. A worker whose completion turns out stale (it lost a race with cancellation) does the same before it answers. Cleanup retries every 60 s up to 10 times; anything left is reclaimed by the retention sweeps (`purgeArtifacts`, `cleanupOrphanedImages`) and the provider's own build timeout.

## Task ingress and the shared queue (step 6)

All platform queues use one path in `@embody/host`:

- `cloudTasksQueue({ queue, url, audience, invokerEmail })`: Cloud Tasks HTTP tasks with an OIDC token. The target, audience and invoker are fixed when the adapter is built; a task contributes only its name, due time and JSON body. `cloudTasksWakeQueue` (M20) is this adapter; M21's relay uses it too.
- `authenticateTask(headers, platformInvokerVerifier(...))`: exactly one `Authorization: Bearer` token, at most 4 KiB, verified for Google's issuer and keys, the exact audience, the invoker's email with `email_verified`, a lifetime of at most an hour, and not expired. Gateway principal tokens, `X-CloudTasks-*` and forwarding headers never authenticate. The M20 drain and the deployment worker both use it.
- `MemoryTaskQueue` and `deterministicTaskName` for tests and names.

The deployment worker (`createDeploymentWorker`) authenticates task routes before it reads the body (an unauthenticated garbage or oversized body is `401`, not `400`/`413`), then validates the body (`400` for anything malformed, which the queue retries without effect). It serves only `GET /health`, `POST /_embody/tasks/deployment` and `POST /_embody/tasks/reconcile`.

## Deployment and identities

| Component | Identity and grants |
|---|---|
| Gateway | Platform DB runtime role; `cloudtasks.enqueuer` on the controller queue and `actAs` on the controller invoker (to create OIDC tasks). No build, Cloud Run or source-read permissions |
| Controller queue | One Cloud Tasks queue, retries unlimited within 72 h, backoff 1–300 s, a low dispatch rate (5/s, 2 concurrent per worker instance limit) |
| Controller invoker | `run.invoker` on the deployment worker only; the worker's verifier accepts no other email or audience |
| Deployment worker (controller identity) | Platform DB runtime role; the M11 controller grants (`cloudbuild.builds.create/get/cancel`, `actAs` on the builder only, `signBlob` on the read signer, delete on the builds repository and outputs bucket, read on outputs and logs); the controller queue enqueuer and invoker `actAs` (lease and follow-up wakes); M13 adds the candidate and runtime grants. Private ingress plus Cloud Run IAM; request timeout above the handler deadline (60 s) |

Clocks: leases and due times compare the workers' clocks (NTP on Cloud Run); the lease margin dwarfs any skew.

## Stuck-job runbook

1. `GET …/deployments/:id`: state, attempt, fences. A nonterminal state older than its stage's bound is stuck; the 2-hour deadline fails it anyway on its next claim.
2. Read the row's `reason`, `dueAt`, `leaseUntil`, `crashes`, `failures` (operator access to the platform DB; never shown to users).
3. Lost tasks: `POST /_embody/tasks/reconcile` on the worker (invoker identity), or any status read through the gateway, re-enqueues overdue deployments.
4. Queue paused or failing: resume it (`provider/cloud-tasks.mjs`); pending tasks dispatch on resume.
5. Worker failing: logs carry one `embody.deployment` line per task (workspace, app, deployment, reason, outcome, duration; no payloads, URLs or provider output). A deployment fails visibly after the bounds above; nothing needs a manual state edit. Never write the row by hand: cancel it through the API instead.

## Verification

- `pnpm --filter @embody/gateway test` (memory, part of `test:mvp`): store conformance, the controller end to end through the gateway routes with the gateway closed, retries and N2, bounded poll errors and lost claims, deadline, cancellation during a build and racing a check (ownership-checked cleanup), five concurrent deliveries, two deployments racing to promote, malicious task bodies, worker ingress authentication (expired, foreign, over-long, gateway and Cloud Tasks headers), queue outage, lost-task recovery, early-task re-arm.
- `pnpm test:gateway-store`: the same store conformance on real PostgreSQL (10 cases).
- `pnpm test:m12` (platform PostgreSQL fixture): the gateway and host suites above plus the real-PostgreSQL file: early task (`txid_status` in progress → 503, rolled back → no-op), nine deliveries across three pools, cancellation racing promotion on separate connections, queue outage, and the crash matrix with SIGKILLed processes and table-backed queue, build provider and candidates that survive the kill:

| Killed | Result |
|---|---|
| after enqueue, before commit | no deployment, source unpinned; the task answers `missing` |
| after commit, before the response | the task drives one active deployment; a client retry replays it |
| committed, task lost (commit/enqueue gap) | recovery wakes it; one active deployment |
| after the claim (worker lost mid-step) | the lease wake (lease + 1 s) reclaims it; attempt 1 completes |
| after the build was created, before its ID was recorded | the build is adopted by its tag: one build |
| after the candidate was created, before the receipt | provisioning adopts it: one candidate |
| after a stage committed, before the ACK | redelivery is harmless |
| after promotion committed, before the ACK | redelivery is terminal: one release, generation + 1 once |

Every case ends with exactly one active deployment, one build, one candidate, one generation step and no pending tasks.

### Live suite (`test:mvp:cloud` suite `m12`, owner-approved budget only)

[`infra/mvp/m12`](../../infra/mvp/m12/): `qualify.mjs` (guards, projection, evaluators, cases), `gcp.mjs` (provider, composed on the M11 one) and `worker.mjs` (the worker entry, run from the `Dockerfile.m05` repository image). It creates, run-scoped under the `embody-test-m12` prefix in `embody-cloud`/`us-central1`: the M11 build resources (builder, read signer, no-role runtime identity, recipe and builds repositories, source/output/logs buckets), a `db-f1-micro` Cloud SQL platform database (no authorized networks, TLS only, restricted maintenance and runtime roles as in M03), a secret with the worker's database URL, the controller queue, a worker (controller) identity, a controller invoker and the Cloud Run deployment worker (min 0, max 2). The worker's two project-level grants (`cloudbuild.builds.editor`, `cloudsql.client`) are removed before its identity is deleted, and the run checks project IAM is unchanged. The operator machine plays the gateway (Cloud SQL Auth Proxy) and closes it after each request.

| Case | What is real | Pass |
|---|---|---|
| `M12.live.iam` | provider IAM | worker holds exactly the controller grants; the invoker only `run.invoker` on the worker |
| `M12.a.c.chain-zero-gateway` | queue, OIDC, worker, Cloud SQL, Cloud Build | gateway gone after `202`; four duplicate tasks; the worker exits after its first claim, after creating the build (before recording it) and after promotion (before the ACK); one active deployment, one build, one candidate, generation + 1, three faults fired |
| `M12.a.lost-task` | same | committed without its task; a status read through a fresh gateway recovers it to active |
| `M12.a.rolled-back` | queue, Cloud SQL | the task of a rolled-back submission does nothing; source unpinned |
| `M12.b.cancel-during-build` | Cloud Build | cancelled while building: provider build `CANCELLED`, artifact `CANCELLED`, no release, no candidate |
| `M12.b.promotion-race` | Cloud SQL, two worker instances | two deployments of one app: one active, one `STALE_GENERATION`, one generation step |
| `M12.c.queue-pause` | queue | a paused queue holds a building deployment for two minutes; after resume it completes |
| `M12.d.ingress` | Cloud Run IAM, OIDC | anonymous, operator, wrong-audience and other-identity tokens refused; malicious body `400`; foreign workspace `missing`; no state change |
| `cleanup` | inventory | every run resource gone, project IAM unchanged |

Faults are rows in a fixture table the qualification worker reads (`m12_fixture_faults`); the process exits at the named point once, and Cloud Tasks redelivers to a new instance. Expired-token rejection and the full kill matrix are local (`test:m12`): a live provider token cannot be made to expire on demand.

## Cost

**Running (worksheet delta)**, list prices as in the [M09 worksheet](./M09-QUALIFICATION.md#cost-worksheet), 5 apps × 20 deployments a month: about 50 worker requests per deployment (polls, lease wakes) at about 0.2 vCPU-s each plus about 5 cold starts of about 3 vCPU-s: 2,500 vCPU-s, **$0.06**; memory and requests **$0.01**; Cloud Tasks about 8,000 operations (inside the free million) **$0.00**; worker image about 0.5 GiB **$0.07**; logs about 50 MiB **$0.03**. **Delta ≈ $0.17/month** (worksheet ≈ $20.03 → ≈ $20.20; ceiling $50). The gateway gains no cost: it only enqueues one task per submission. Builds are the M11 line.

**One-off live qualification, conservative:** six builds at the full 600 s timeout ($0.36), Cloud SQL `db-f1-micro` with storage and IPv4 for four hours ($0.09), plus $0.40 for the worker, queue, images for a day, buckets, logs and egress: **$0.85 per run** (`m12Projection`). The suite refuses to start above the approved budget (proposed cap **$6**, which covers several runs if the first ones fail closed, as M11's did) and fails if the measured estimate exceeds it.

## Not yet proven / later tasks

- **M13:** real provisioning/check stages (Cloud Run candidate, migrations, smoke), the route/manifest switch inside the promotion transaction, rollback, unpinning replaced releases.
- **M14:** CLI `deploy`/`status`/cancel over these routes.
- **M16:** schedules retention: deployments and key bindings expire after 90 days (`retainUntil`); unpin sources no deployment or release references; purge sweeps for artifacts and orphans.
- **M21:** event relay tasks on the shared queue path.
- **Residual risks:** a worker that dies after starting a build but before recording the artifact's build ID leaves at most one build running to its 600 s provider timeout (adopted on the next claim). The submission transaction holds the workspace lock while it enqueues (≤ 5 s), so submissions in one workspace serialize.
