# M13: provision, migrate, promote and roll back

Implementation: release stages, naming, migration and workflow policy, registration re-read and the candidate sweep in [`@embody/gateway` `release-stages.ts`](../../packages/gateway/src/release-stages.ts); the per-app database and migration runner in [`app-database.ts`](../../packages/gateway/src/app-database.ts); the Cloud Run, IAM, Secret Manager and Cloud Tasks adapters and the health probe in [`cloud-release.ts`](../../packages/gateway/src/cloud-release.ts); memory providers in [`memory-release.ts`](../../packages/gateway/src/memory-release.ts); the promotion transaction and rollback submission in [`store.ts`](../../packages/gateway/src/store.ts) and the decisions in [`deployment.ts`](../../packages/gateway/src/deployment.ts); the rollback route in [`deployment-routes.ts`](../../packages/gateway/src/deployment-routes.ts). Task definition: [IMPLEMENTATION M13](./IMPLEMENTATION.md#m13--provision-migrate-promote-and-roll-back). M13 plugs into the [M12 controller](./DEPLOYMENTS.md): it implements the `provisioning` and `checking` stages, prepares and extends the promotion, and adds rollback.

```text
building (M11) ─► provisioning ───────────────────────────► checking ──────────────► promoting ─► active
                  app identity, DB secret, DB roles          candidate is ours,         re-read manifest,
                  (once per app, adopted by name)            runs the digest,           workflow versions
                  next framework migration (one per step)    revision ready,            ──► ONE transaction:
                  durable: own wake queue + invoker          /health ready: true,       release, route+manifest,
                  candidate: Cloud Run service, min 0        registration valid         generation+1, pins,
                  exact invoker binding                                                 replaced release drains
```

## Route model

Every deployment gets its own **candidate**: a Cloud Run service (min 0 instances, max 3, request-billed CPU) running exactly the admitted digest (`repo@sha256:…`). The catalog's `registration.endpoint` is the candidate's origin. Switching releases is a write of one catalog row (route, manifest, active release, generation); the replaced candidate keeps serving calls that were routed before the switch for the **drain** (10 minutes; a call is at most 60 seconds) and is then removed. There is no traffic splitting at the provider, so the switch is exactly as atomic as the database row.

Names come from platform records only (`appResourceNames`, `candidateName`): a 2–8 character platform prefix plus a hash of the workspace, app and deployment IDs. Candidates carry the labels `embody-platform` (prefix), `embody-role=candidate`, `embody-owner` (hash of workspace/app/deployment) and the annotations `embody.dev/workspace`, `embody.dev/app`, `embody.dev/deployment` (exact IDs). A same-named service whose labels and annotations do not match is never adopted, modified or removed (`CANDIDATE_CONFLICT`).

## First deploy and the catalog (M13.a)

An app can be **reserved** before its first release: a catalog record with `name` (its CLI/MCP namespace), `registration: null`, no active release and state `unavailable`. A reserved app is not discoverable or dispatchable; deployment and status routes see it. The first promotion registers it: the registration (namespace, version, route, health URL, catalog), the active release and state `idle` (dispatchable, woken on demand) are written together.

The namespace is always the catalog's `name`, never the build's `manifest.appId` (a customer claim, BUILDS follow-up). The claim still has to *equal* the name: the hosted host verifies the gateway's principal tokens against its own `defineApp({ appId })` and the gateway issues them for the catalog name, so a release built under another name could serve no call and is refused (`CHECK_FAILED`, `APP_NAME_MISMATCH`). The catalog is re-read from the retained `manifest.json`, which must hash to the artifact's `manifestDigest` and whose catalog must hash to the admitted `catalogDigest`; anything else fails the deployment `CHECK_FAILED` (`MANIFEST_MISMATCH`). The registration then passes the same validation as every catalog write (M04/M06). The check stage validates it, and the promoting step re-reads it, so it is never stored on the deployment record.

**No mixed catalogs.** Gateways keep no catalog cache and read each workspace's catalog in one statement (M04), and route plus manifest live in one row written by one transaction, so every gateway instance sees the old pair or the new pair. `release.postgres.test.ts` reads the catalog from a second pool continuously across three promotions and finds only pairs that some release defines.

## Promotion transaction

M12's transaction, extended. PostgreSQL lock order: **workspace → deployment → artifact → source → replaced release → its artifact → its source** (every transaction that touches more than one of these takes the workspace lock first; submissions and rollback submissions take workspace → source → artifact, and the release lifecycle is written only under the workspace lock, so there is no cycle). Under the locks it:

1. checks the artifact is promotable (admitted, not purging, this deployment's build or this rollback's target) and the source usable, then the registration (`registrationRefusal`: namespace, route equals this deployment's candidate, validation). Any failure ends the deployment (`DEPENDENCY_UNAVAILABLE`/`CHECK_FAILED`) instead of throwing, so nothing retries forever;
2. evaluates `canPromote` (M02/M12);
3. marks the replaced release inactive (`inactiveSince`, `drainUntil` = +10 minutes, `retainUntil` = +30 days) and **releases its pins**: an artifact or source the replaced release pinned is unpinned with `retainUntil = max(current, now + 30 days)`. The existing artifact and source sweeps then reclaim them, and the 100 MiB workspace source quota stops counting them after 30 days (M12 re-review N1);
4. inserts the new release (registration, candidate, source upload, schema version, `rollbackOf`), CAS-writes the catalog (registration, active release, state, generation + 1), and pins the new release's artifact and source (re-pinning anything it shares with the replaced release).

`migrate()` also repairs releases replaced before M13: it marks every non-active release without a lifecycle inactive (retention starting at the migration) and unpins whatever an inactive release still pins. An inactive release never becomes active again (a rollback promotes a *new* release), so this is safe while promotions run (M12 re-review N3).

**Generation stays conservative** ([WORKSPACES](./WORKSPACES.md)): promotion is the only catalog write M13 adds. Release lifecycle, pins, candidate removal and the app environment are written to their own rows, never through a generation-bumping catalog write, so they cannot fail an in-flight deployment `STALE_GENERATION`. M13 does not write runtime state (`idle`/`ready`/`unavailable`) after the first promotion; M15/M17 must keep doing that outside the generation.

## Provisioning (step 1)

One bounded step per task; anything that starts a provider operation returns `pending` and the controller polls (`DEPLOYMENT_LIMITS.stagePollMs`, 5 s), bounded by the stage limit (15 minutes, then `PROVISION_TIMEOUT`). Every step adopts what an earlier, crashed step created.

| Step | Resource (per app unless noted) | Idempotency |
|---|---|---|
| Runtime identity | service account `<prefix>-a<hash>`; its only project role is `roles/cloudsql.client` (the Cloud SQL connector authorizes by identity; database access stays per app role) | get, else create (then `pending` for IAM propagation); the Cloud SQL client binding by an etag-guarded project policy edit |
| Database | database `embody_<prefix>_a<hash>`, owner role `…_o` (no login), runtime role `…_r` (login, `CONNECTION LIMIT 15` = 3 instances × pool 5, statement and idle-in-transaction timeouts 30 s) on the shared Cloud SQL instance (MD05) | existence checks |
| Credential | secret `<prefix>-a<hash>-db` holding the runtime `DATABASE_URL`; only accessor: the runtime identity | the role's comment records the secret version its password came from; a mismatch (a crash between writing the version and the role) rotates again. The controller never reads a payload |
| Migration | next pending framework migration (below) | one per step, re-planned under an advisory lock |
| Wake queue (durable) | Cloud Tasks queue `<prefix>-a<hash>`, invoker `<prefix>-w<hash>`; the runtime may enqueue only there and act only as that invoker; the invoker may invoke only this app's candidates | get, else create (then `pending`) |
| Candidate (per deployment) | Cloud Run service from the admitted digest, min 0, max 3, env `NODE_ENV`, `EMBODY_HOST_PROFILE=hosted`, workspace, issuer, JWKS URL, `DATABASE_URL` from the secret (`latest`), durable: queue, invoker and the app's **stable wake route** as drain URL and audience (accepted as a Cloud Run custom audience, see below); invoker binding exactly the gateway, the controller (health) and, durable, the wake invoker | 409 adopted after the ownership check |

Customer secret references are refused (`INVALID_INPUT`, `SECRETS_UNSUPPORTED`) until M15 serves them. **The runtime has no migration or platform authority**: it cannot run DDL, cannot connect to another app's database or the platform database, and its only provider role is `roles/cloudsql.client`, conditioned on the shared instance (the Cloud SQL connector authorizes by identity). Each step stops at a 25-second budget and hands over to the next step, which adopts what was done, so even slow provider calls stay inside the 45-second handler deadline.

## Migrations (step 2)

Customers cannot ship DDL: hosted apps store entities as JSON documents in framework tables. The only migrations are the framework's (`@embody/storage` `STORAGE_MIGRATIONS`), and the release's schema is the one its recipe bundles (`BUILD_RECIPE.storageSchemaVersion`, 6). Each migration declares `compatibility`:

- `expand` (all six today): adds structure or backfills without changing what older code reads. Hosted boot accepts a **newer** applied schema whose prefix is exactly what the code expects (`hostedSchemaCompatible`), so the serving release keeps booting after a candidate's migration, including after that candidate fails.
- `contract`: removes or rewrites data an older release reads. The plan is refused **before anything executes** (`CHECK_FAILED`, `MIGRATION_REJECTED`); the real-PostgreSQL test shows the ledger and the data checksum unchanged.
- `readerFloor`: an operator-run platform upgrade can declare that code older than a schema cannot read the data any more; a rollback below it is refused (`ROLLBACK_INCOMPATIBLE`, `SCHEMA_INCOMPATIBLE`).

`PostgresAppDatabase.applyNextMigration` applies one migration per step in its own transaction as the owner role (`SET LOCAL ROLE`), with `lock_timeout` 5 s and `statement_timeout` 30 s, re-checks the plan under a per-database advisory lock (two deployments of one app never apply a version twice), records it in the ledger and grants the runtime DML on the data tables, read-only on the ledger and `EXECUTE` on the storage runtime functions. A failing migration rolls back entirely (`M13.b`: ledger, columns and checksum unchanged) and the deployment fails after its retries; the serving release is untouched. An applied database newer than this controller knows is refused (`SCHEMA_AHEAD`). Migrations of very large tables that need longer than the statement timeout are outside the MVP and fail visibly. Route rollback cannot undo data changes (expand migrations do not need undoing).

The provisioner is a database role with `CREATEDB` and `CREATEROLE` only (no superuser, no `BYPASSRLS`). It administers the roles it created and may `SET ROLE` to an app's owner without inheriting its privileges, so it cannot read app data without explicitly acting as the owner; it runs only platform migrations and the workflow-version query, never customer SQL.

## Checks (step 3)

Readiness is side-effect free: the candidate is owned by this deployment and runs exactly the admitted digest at the deterministic URL; the provider reports the newest revision ready (the host booted, which includes the read-only schema check); `GET /health` with the controller's own ID token answers `ready: true`; the registration it would serve validates. A revision that cannot start fails `CHECK_FAILED` (`CANDIDATE_FAILED`); one that never becomes ready fails after 10 minutes (`READINESS_TIMEOUT`). No app action is called: the controller holds no gateway signing key.

## Rollback (steps 4–5, M13.d)

`POST /v1/workspaces/:ws/apps/:app/rollback` with `AppManagement` `{operation: "rollback", expectedGeneration, releaseId}` (`app:rollback`, deployer or operator). A rollback is a deployment of the target release's admitted artifact: it reuses the target's submission, skips the build, provisions a **fresh** candidate from the same digest, re-runs every check and promotes a **new** release (`rollbackOf`) through the same CAS. So concurrent deploys, cancellation and stale workers behave exactly as for a deploy. One rollback exists per target and generation (`rollback-<release>-g<generation>`): a retry replays it (`200`); submission keys with that prefix are refused.

Refused explicitly with `409 ROLLBACK_INCOMPATIBLE` ("Rollback target is no longer retained or is incompatible with current data or workflows."): the active release, a release past its 30-day inactive retention (its artifact and source may be gone), a release promoted before M13 (no registration), a target whose artifact or source is gone. Checked against the app's database by the stages, failing the rollback deployment with the same public code: the schema reader floor, and workflow versions still in use that the target lacks. Unknown releases are `404`, a stale generation `409 STALE_GENERATION`. The target's artifact and source are retained at least as long as the rollback deployment.

Data stays as it is: a rollback switches code, never data. The live suite records the app's data checksum before and after.

## Workflow versions and subscriptions (step 6, M13.e)

The engine runs an instance only on code that has its exact `definition@version`. Before promoting, the controller reads `embody_active_workflow_versions()` (running or retryable instances) and refuses a release (`CHECK_FAILED`) or rollback (`ROLLBACK_INCOMPATIBLE`) that does not keep every version in use (`WORKFLOW_VERSION_IN_USE`), or keeps a version under the same name with a different step graph (`WORKFLOW_VERSION_CHANGED`). To change a workflow with running instances, ship it under a new definition or wait for (or cancel) the instances. The real-PostgreSQL test starts an instance on release A's code and finishes it on release B's code, which kept `fulfil@1.0.0` and added a new definition.

Subscriptions are part of the catalog (`eventSubscriptions`) and the release manifest, so they switch in the same row and transaction as the active release and generation. M21's relay reads them from there.

## Durable wakes follow the active release (review B1 of `a561eaf`)

A durable app's host enqueues its wake tasks (delayed and retried steps, leases, events and the 30-day retention cleanups) with a URL and OIDC audience fixed when it boots. If those named one candidate, every wake due after that candidate's drain would hit a removed service. So durable candidates get `EMBODY_DRAIN_URL` = `EMBODY_DRAIN_AUDIENCE` = the app's **stable wake route** on the deployment worker, `<worker>/_embody/wake/<workspace>/<app>` (`wake-forwarder.ts`). The worker authenticates the app's own wake invoker for exactly that audience before reading the body (4 KiB), looks up the app's **active** release in the catalog and forwards the body to its `/_embody/drain` with a token minted as the same invoker for the same audience; candidates list the wake route as a Cloud Run custom audience, and the host's drain verifies it as before. The drain's answer is the queue's answer (`503` and its `Retry-After` keep the task). An app without a served release answers `503`; a deleted app's wakes are dropped. Wakes scheduled by any release therefore run on the code that serves the app when they are due, and replaced candidates can go after their drain. Each wake costs one extra worker request (the worker scales to zero like the app).

## Retention: what reclaims each record

| Record | Kept | Reclaimed by |
|---|---|---|
| Active release's artifact and source | pinned while active | unpinned in the promotion that replaces it |
| Replaced release's artifact and source | 30 days (`retainUntil`), so it can be rolled back to | the M11 artifact sweep and the M10 source sweep, as ordinary unpinned records |
| Replaced release's candidate | the drain (10 minutes) | the candidate sweep (`candidateRemovedAt` recorded) |
| Failed or cancelled deployment's candidate | until cleanup | cleanup (`abandon`, ownership-checked, 10 tries); the candidate sweep catches anything later, including a candidate a timed-out stage created after a cancellation (M12 review finding 1; the controller also runs `abandonIfEnded` when such a stage settles) |
| Candidate with no deployment record | none | the candidate sweep |
| Release and deployment rows | indefinitely | M16 (M12 review finding 7) |
| App identity (and its Cloud SQL client binding), database, roles, secret, wake queue | the app's lifetime (one set per app, never per deployment) | app delete (M15) |
| Secret versions superseded by a credential rotation | until M15 rotation policy | M15 (at most one per crashed convergence) |

**Candidate sweep.** `CandidateSweep` lists **all** of this platform's candidates (the provider follows `nextPageToken`, up to 10 pages of 200, more than the regional service quota; review B2) and removes one only when its labels and annotations name exactly one workspace, app and deployment of this platform (anything else is foreign and untouched) and that deployment failed, was cancelled or no longer exists, or its release was replaced and has drained. It removes at most 10 per pass within a 20-second budget; a decision or delete that fails is counted and skipped, so it never blocks the candidates behind it. It runs after delivered worker tasks (at most once a minute per instance) and on `POST /_embody/tasks/reconcile`, never on a timer, so an idle platform stays at zero. Every deployment creates one candidate and delivers several tasks, so removal keeps pace with creation; on an idle platform, drained candidates wait for the next task or reconcile, cost nothing at min 0 instances and do not grow.

## Identities and grants (additions to [DEPLOYMENTS](./DEPLOYMENTS.md#deployment-and-identities))

| Identity | M13 grants | Never |
|---|---|---|
| Deployment worker (controller) | **Unconditioned, create or list only:** `run.services.list`, `run.operations.get`, `iam.serviceAccounts.create/get`, `secretmanager.secrets.create`, `cloudtasks.queues.create` (creating grants no access). **Each bound with a resource-prefix IAM condition (review B3):** Cloud Run `run.services.create/get/delete/getIamPolicy/setIamPolicy` on `<prefix>-c` candidates only; `run.services.getIamPolicy/setIamPolicy` on the worker service itself (to let app invokers call the wake route); Secret Manager `secrets.get/getIamPolicy/setIamPolicy`, `versions.add/get` on `<prefix>-a` secrets only (no `versions.access`); Cloud Tasks `queues.get/getIamPolicy/setIamPolicy` on `<prefix>-a` queues; `iam.serviceAccounts.getIamPolicy/setIamPolicy/getOpenIdToken` on `<prefix>-w` invokers; `actAs` on `<prefix>-a` runtimes; project IAM admin conditioned to grants of `roles/cloudsql.client` only (`modifiedGrantsByRole`; it bounds the role, not the member, which is acceptable for trusted platform code). Plus `cloudsql.client` and the database provisioner credential | `actAs` on the gateway, builder or any platform identity; reading secret payloads; app actions (no signing key) |
| App runtime | `roles/cloudsql.client` conditioned on the shared instance (connector only; each app adds one member to that binding, and a project allow policy holds at most 1,500 principals, which bounds apps per project until M15 removes deleted apps); its own secret (accessor), its own queue (enqueuer) and `actAs` on its own invoker | any other project role, other apps' databases (no `CONNECT`, other passwords), secrets or queues, the platform database |
| App wake invoker | `run.invoker` on its app's candidates and on the worker (the wake route, which accepts it only for its own app's path and audience); Cloud Tasks' service agent and the app runtime may act as it | anything else |
| Gateway | `run.invoker` on every candidate (set per candidate) | as M05 |

The live suite pins these grants exactly and checks project IAM is unchanged (as M12 did). M12 review finding 6 (the worker's live build grants exceeded the table) is not widened by M13; narrowing those roles stays a recorded follow-up. Binary Authorization on Cloud Run is a hardening option, not enabled.

## Limits

| Item | Value |
|---|---|
| Provisioning stage | 15 minutes, then `PROVISION_TIMEOUT` |
| Checks | 10 minutes, then `READINESS_TIMEOUT` |
| Provider poll | 5 s; each provider call 15 s, health probe 5 s, database statements 30 s, locks 5 s |
| Drain of a replaced candidate | 10 minutes |
| Rollback window | 30 days after a release was replaced |
| Candidate instances | min 0, max 3, concurrency 4, request timeout 60 s, 1 vCPU, 512 MiB, CPU only during requests |
| Candidate sweep | at most 10 removals per pass, at most once a minute per worker instance |

## Verification

- `pnpm --filter @embody/gateway test` (memory, part of `test:mvp`): `release.test.ts` (24 cases: the app-name check, the stable wake route (review B1), the sweep past a failing delete (B2), M13.a–e on the controller with the real stages over memory providers, manifest substitution, secret references, readiness and crash failures, failing and destructive migrations, concurrent and stale promotions, cancellation during checks, finding 1, rollback by route with replay and refusals, schema floor, workflow-version refusals, durable environment, subscriptions switch, the source quota over 100 MiB of promotions, sweep ownership) and `cloud-release.test.ts` (8 adapter and probe request-shape cases, including paging, the instance-conditioned Cloud SQL grant, the wake-route grant and ID-token minting).
- `pnpm test:m13` (platform PostgreSQL fixture plus the `embody_provisioner` fixture role, `EMBODY_PROVISIONER_URL`): the files above, `release.postgres.test.ts` (14 cases) and the M12 controller suites as a regression, sequentially, with zero skips. The real-PostgreSQL file covers the per-app database and its least privilege, destructive and failing migrations with checksums, an older release booting after an expand migration, a v1 workflow instance finishing on the next release's code, promotion on two pools, no mixed catalogs, rollback, the source quota, the `migrate()` repair and the crash matrix below.

| Killed (SIGKILL) | Result |
|---|---|
| after a migration committed, before the step's receipt | the next step continues; every version applied once |
| after a credential version was written, before the role | the credential converges: the role matches the newest version, whose URL connects |
| after the candidate was created, before its receipt | adopted by name after the ownership check; one candidate |
| after an update's promotion committed, before the ACK | redelivery is terminal; one switch; the replaced release's pins released once; after the drain the sweep leaves only the active candidate |

Each case ends with one active deployment, the catalog route on its candidate, one candidate for it, one generation step and no pending tasks.

### Live suite (`test:mvp:cloud` suite `m13`, owner-approved budget only)

[`infra/mvp/m13`](../../infra/mvp/m13/) follows M12's pattern (guards, projection, exact case set, teardown on every path, inventory and project IAM unchanged). It needs the M12 resources plus a `db-f1-micro` instance with the provisioner role, and runs real candidates, promotions and rollbacks with data checksums:

| Case | Pass |
|---|---|
| `M13.live.iam` | worker, runtime, invoker and candidate grants exactly as the table above |
| `M13.a.first-deploy` | a reserved app's first release is served through a gateway: catalog route is the candidate, a CRUD call succeeds |
| `M13.a.update-switch` | an update switches route and manifest in one generation; calls during the switch succeed on one pair or the other; the old candidate is removed after the drain |
| `M13.b.failed-readiness` | a release whose container exits at boot fails `CANDIDATE_FAILED`; the old route serves; checksum unchanged |
| `M13.b.destructive-migration` | a contract migration is refused; ledger and checksum unchanged |
| `M13.c.promotion-race` | two deployments on two worker instances: one generation step |
| `M13.d.rollback` | rollback by digest to the previous release: a fresh candidate, previous manifest, checksum unchanged; expired and active targets refused |
| `M13.e.durable-wake` | a durable app starts a workflow whose step is due 12 minutes later (past the 10-minute drain); a second release is promoted and the first candidate swept; the step completes on the active release through the stable wake route |
| `cleanup` | every run resource gone, project IAM unchanged |

M13.e's version guard and continuation are also proven locally with a real engine and PostgreSQL.

## Cost

**Running (worksheet delta)** at the M09 assumptions (5 apps, 20 deployments a month each): one database secret per app with one or two active versions, about **$0.36** (Secret Manager $0.06 per active version-month); candidates at min 0 cost nothing idle and run only during checks (about 3 cold starts per deployment, inside the M09 Cloud Run line); the per-app databases share the existing instance (no new line); durable wake queues are free under the Cloud Tasks free tier, and each durable wake adds one worker request (inside the M12 worker line at the worksheet's volumes). **Delta ≈ $0.40/month** (worksheet ≈ $20.20 → ≈ $20.60; ceiling $50).

**One-off live qualification, conservative** about **$1.11 per run** (`m13Projection`: seven builds at the full timeout $0.42, Cloud SQL four hours $0.09, $0.60 for the gateway, worker, candidates, secrets, queues, images, logs and egress). Approved cap: **$6** (owner, 2026-10-21), which covers several runs if early ones fail closed, as M11's and M12's did.

## Residual risks

- **Workflow-version race.** The workflow-version check reads the app database before the promotion transaction (different databases). An instance of a version the new release drops, started in that window (one handler, under 45 s), would wait for a release that has the version (roll back, or redeploy the old definition). The engine never runs it on the wrong code.
- **Drain.** A call routed to the replaced candidate more than 10 minutes after the switch (impossible for gateway requests, which re-read the catalog per request and finish within 60 s) would fail. Durable wakes never address a candidate (stable wake route), so they are not affected.
- **Credential rotation.** Rotating the runtime password writes the new secret version, then the role password, under a per-app lock. An instance cold-starting in between reads a password the role does not have yet and fails to boot; Cloud Run starts another. Rotation happens once per app (and after a crash in that window).
- **Recipes.** Every recipe ID ever admitted stays in `RECIPE_SCHEMA_VERSIONS`; an unknown one fails the deployment `UNKNOWN_RECIPE` (or `ROLLBACK_INCOMPATIBLE`) instead of throwing.
- **Rolling upgrade.** Releases replaced by a pre-M13 worker after the M13 `migrate()` ran keep their pins until the next `migrate()`; run it again once every worker is upgraded.
- **Provisioner authority.** The controller can act as any app's schema owner through the provisioner role. It is trusted platform code that runs only framework migrations; the live suite checks it has no other database grants.
- **Large migrations.** A framework migration that needs more than 30 s on an app's data fails and rolls back; such migrations need a separate operator path.
