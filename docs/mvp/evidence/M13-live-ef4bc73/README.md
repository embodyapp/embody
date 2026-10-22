# M13 live evidence (`test:mvp:cloud` suite `m13`)

**Run `ed009e`** on clean `ef4bc73` (`dirty: false`), 2026-10-22, project `embody-cloud`, region `us-central1`, resource prefix `embody-test-m13`, release platform prefix `ted009e`, operator gcloud login, Cloud SQL Auth Proxy v2.26.0. Owner-approved budget: $6 cap (2026-10-21). Sanitized results: [`mvp-cloud-m13.json`](./mvp-cloud-m13.json). Contract and case list: [RELEASES](../../RELEASES.md#live-suite-test-mvp-cloud-suite-m13-owner-approved-budget-only).

**Result: 9 cases, 8 passed; `M13.e.durable-wake` failed one sub-check (`replacedCandidateRemoved`) because of an asynchronous-delete race in the check itself, not in M13 (below).** The suite therefore reports `failed`. The check is fixed on the branch; a confirming run needs an owner budget decision (the conservative tally of all runs is about $5.27 of the $6 cap).

Topology, all real and run-scoped: a public hosted gateway on Cloud Run (its own identity, the JWKS candidates verify against), the M13 deployment worker on Cloud Run (controller identity, real release stages), Cloud Tasks controller queue and OIDC invoker, Cloud Build with the M11 recipe, a `db-f1-micro` Cloud SQL instance holding the platform database and every app database (provisioner role `CREATEDB`/`CREATEROLE` only). Each app was provisioned at reservation by the operator (`provisionAppIdentity`): runtime identity, database secret, instance-conditioned Cloud SQL client, and for the durable app its queue, invoker and wake route. The operator then acted only as a client of the public gateway and read data checksums through the provisioner.

| Case | Result | Facts |
|---|---|---|
| `M13.a.first-deploy` | pass | a reserved app was hidden before its first release; the release registered it (route on the candidate's `run.app` origin), a CRUD create and list succeeded through the gateway |
| `M13.a.update-switch` | pass | every catalog observation during the update was the old or the new (generation, route, manifest) pair, monotonic, both seen; every call succeeded; data checksum unchanged; the replaced candidate was removed after the drain, the new one kept |
| `M13.b.failed-readiness` | pass | a release whose container exits at boot failed `CHECK_FAILED`; the route was unchanged and the previous release kept serving; checksum unchanged; the failed candidate was removed |
| `M13.b.destructive-migration` | pass | a `contract` migration on the live app database was refused before execution; ledger and checksum unchanged |
| `M13.c.promotion-race` | pass | two deployments of one app: one active, the other `STALE_GENERATION`; exactly one generation step |
| `M13.d.rollback` | pass | rollback to the first release: a new release (`rollbackOf`) on a fresh candidate with the previous manifest; checksum unchanged; a call succeeded afterwards; rollback to the active release refused `409 ROLLBACK_INCOMPATIBLE` |
| `M13.e.durable-wake` | **fail (check race)** | `bothActive`, `started`, `sweptBeforeDue` and `stepCompletedOnActiveRelease` true; `replacedCandidateRemoved` false (see below) |
| `M13.live.iam` | pass | worker: the base role, the prefix-conditioned secrets role, no IAM-admin role, no project-wide `actAs`, resource-level `actAs` on runtimes and token creation on the invoker only; runtimes: Cloud SQL client and their own secret only; candidates invokable only by the gateway, the worker and the app's wake invoker; gateway without release authority; no owner/editor |
| `cleanup` | pass | every run resource removed; inventory empty; project IAM unchanged |

### The durable case

The durable app's workflow step was scheduled by release A, 28 minutes ahead. Release B was promoted; A's candidate drained and was swept; the step then completed on the active release through the stable wake route (review B1). Provider audit log (worker identity `embody-test-m13-c-ed009e`):

| Time (UTC) | Event |
|---|---|
| 13:31:55 | `CreateService` `ted009e-c7418ce96b5b969e3da911382` (release A's candidate) |
| ≈13:33 | workflow started on A (step due ≈14:01) |
| 13:35:15 | `CreateService` `ted009e-c161527ba15021061dd5826aa` (release B's candidate) |
| 13:48:02 | `DeleteService` `ted009e-c7418ce96b5b969e3da911382`: the sweep removed A, before the step was due |
| after 14:01 | the step's status read `completed` through the gateway |

The check listed the durable app's candidates immediately after the sweep's `DeleteService`, while Cloud Run was still deleting A, and counted two. The removal itself is on record above; the check now waits for an asynchronous delete to finish (`qualify.mjs`). Because A no longer existed when the step came due, only the forwarder to the active release could have delivered it.

## All live runs

| Run | Code | Outcome | What it found (fixed on the branch) |
|---|---|---|---|
| 1 | `3812f22` | setup failed | Cloud Run v2 serves `getIamPolicy` by GET (provider used POST) |
| 2 | `80a7e87` | deployments failed in provisioning | stage errors were only `HANDLER_ERROR`: added bounded diagnostic tags |
| 3 | `4de59be` | provisioning `provider-403` | Cloud Run resource-name conditions; retried with ID/number forms |
| 4 | `4a1e7c4` | provisioning `provider-403` | probed as the worker: Cloud Run and service-account IAM ignore name conditions, Secret Manager honours them; identity creation moved to app provisioning (resource-level grants) |
| 5 | `fd487fd` | candidates exited at boot | the socket-form `DATABASE_URL` had an empty host |
| 6 | `b663705` | promote/switch/rollback/IAM/cleanup passed | app calls refused (scope namespaces: gateway `<app>:*`, kernel `app:*`); IAM 429s; IAM case moved after provisioning |
| 7 | `ef4bc73` | 8/9 | the durable sub-check's async-delete race (above) |

Every run tore down completely: inventory empty and project IAM unchanged each time (a just-deleted account listed by a lagging IAM list made runs 2 and 4 report a leftover; the inventory now re-checks).

## Cost

Conservative suite estimates (builds at the full timeout, SQL for four hours, $0.60 fixed per run): $0.69, $0.77, $0.80, $0.76, $0.76, $0.72, $0.77 = **≈ $5.27** of the $6 cap. Run 7 measured 12.8 build-minutes (≈ $0.08 at list price); list-price spend per run is roughly $0.20–0.30. The invoice check is open (owner).
