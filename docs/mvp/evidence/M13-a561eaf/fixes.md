# M13 review fixes (`a561eaf` → `deff69f`)

Answers the [independent review](./independent-review.md) of `a561eaf` (REJECTED, B1–B3). Every blocker has a fix and a regression; non-blocking notes are fixed or recorded.

| Finding | Fix | Regression |
|---|---|---|
| **B1** durable wakes target the replaced candidate | Durable candidates use the app's **stable wake route** on the deployment worker (`/_embody/wake/<ws>/<app>`) as `EMBODY_DRAIN_URL` and `EMBODY_DRAIN_AUDIENCE`. The worker authenticates the app's own invoker for exactly that audience before reading the body, resolves the **active** release from the catalog and forwards to its `/_embody/drain` with a token minted as the same invoker for the same audience; candidates accept it as a Cloud Run custom audience (`wake-forwarder.ts`, `release-stages.ts`, `cloud-release.ts` `mintIdToken`/`ensureWakeRoute`) | `release.test.ts` "wakes scheduled by a replaced release reach the active release after its candidate is gone" (stable URL on every release, forward to B after A is swept, 503/Retry-After passthrough, foreign identity, other app's audience and missing token refused before the body); "no served release yet answers 503". On `a561eaf` the drain URL is the candidate's own, so the first assertion fails. Live: `M13.e.durable-wake` |
| **B2** sweep starvation | `GoogleReleaseProvider.list` follows `nextPageToken` (10 pages × 200 > regional quota); `CandidateSweep` counts and skips a failing decision or delete and is bounded by 20 s per pass | `cloud-release.test.ts` "lists every page of services"; `release.test.ts` "a delete that keeps failing is counted and skipped; later removable candidates still go" |
| **B3** unconditioned live worker role | The run-scoped custom role is split: `base` (list, operations, create only) unconditioned; `candidates`, `wakeRoute`, `secrets`, `queues`, `invokers` each bound with a resource-prefix condition (`m13Conditions`); the missing `-w` invoker `setIamPolicy` (plus `getOpenIdToken` for the forwarder) added. The evaluator requires every conditioned group and rejects an unconditioned one | `test/verification/m13-cloud.test.mjs` "every resource-touching worker role is prefix-conditioned" (the `a561eaf` posture is a negative) |
| Note 1 | Runtime `cloudsql.client` is a binding conditioned on the shared instance; the 1,500-principal ceiling is recorded in RELEASES (M15 removes deleted apps) | `cloud-release.test.ts` "grants the runtime Cloud SQL client for the one instance" |
| Note 2 | Recorded in the RELEASES identity table (bounds the role, not the member) | docs |
| Note 3 | Credential rotation serialized under a per-app advisory lock (`withCredentialLock`); remaining cold-start window recorded | existing crash case "after a credential version was written" |
| Note 4 | `RECIPE_SCHEMA_VERSIONS` table; an unknown recipe fails `UNKNOWN_RECIPE` / `ROLLBACK_INCOMPATIBLE` instead of throwing | typecheck; stage path |
| Note 5 | Rollback re-checks the target artifact's built name against the platform name (`APP_NAME_MISMATCH`) | stage path, as deploys |
| Note 6 | Sweep pass budget 20 s | B2 regression |
| Note 7 | Provisioning step budget 25 s: past it a step hands over (`STEP_BUDGET`) | existing provisioning paths |
| Note 8 | Rolling-upgrade note in RELEASES residual risks | docs |
| Note 9 | Cost ($1.11/run with the durable case), runtime role wording, SA condition format (live run decides) | docs |

Live run 1 (old code, shakedown) failed at setup on a provider bug: Cloud Run v2 serves `getIamPolicy` by GET, the run used POST (404). Fixed. It created and removed everything (inventory empty, project IAM unchanged); conservative estimate $0.69.

## Verification of the fixed candidate (`deff69f`, clean, Node 24.21.0, fixture `embody-m13-verification` on port 55741)

| Command | Result |
|---|---|
| `pnpm verify` (no DB variables) | exit 0 |
| `pnpm test:verification` | **108** passed, 0 skipped |
| `pnpm test:mvp` | **635** passed, 0 skipped (gateway 292: +3 release and +2 adapter regressions) |
| `pnpm test:m12` | **128** passed, 0 skipped |
| `pnpm test:m13` | **92** passed, 0 skipped: release (memory) 24, release (real PostgreSQL) 14, Google adapters 8, M12 controller 32 and real-PostgreSQL 12, storage policy 2 |

Each evidence JSON records commit `deff69f`, `dirty: false`.
