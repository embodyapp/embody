# M14 live journey evidence (phase 2)

**Run `e1a52e`** on clean `8d4bb07` (`dirty: false`), 2026-10-27, project `embody-cloud`, region `us-central1`, resource prefix `embody-test-m14`, release platform prefix `te1a52e`, operator gcloud login, Cloud SQL Auth Proxy v2.26.0, Node v24.21.0. Owner-approved budget: **$6 cap** (2026-10-24). Command: `pnpm build && caffeinate -i node scripts/test-mvp-cloud.mjs` with `EMBODY_MVP_CLOUD_SUITES=m14`, `EMBODY_MVP_CLOUD_PROJECT`, `EMBODY_MVP_CLOUD_RESOURCE_PREFIX`, `EMBODY_MVP_CLOUD_BUDGET_USD=6`, `EMBODY_MVP_CLOUD_BUDGET_APPROVED=true`, `EMBODY_MVP_CLOUD_CREDENTIALS=gcloud`, `EMBODY_CLOUD_SQL_PROXY` (names only). Sanitized results: [`mvp-cloud-m14-run1.json`](./mvp-cloud-m14-run1.json). Contract and case list: [CLI](../../CLI.md#verification).

**Result: 18/18 passed, zero skips, first live run.** The real integration topology: the M13 live topology (Cloud Build with the pinned recipe, Cloud SQL `db-f1-micro` platform and per-app databases, Cloud Tasks controller queue, the Cloud Run deployment worker with the real M12 controller and M13 release stages, real Cloud Run candidates with private invocation, the public hosted gateway on Cloud Run with its own identity and HTTPS JWKS), plus the M10 source routes on that gateway: the CLI uploaded every source to GCS through a V4 URL signed by a run-scoped upload signer (create-only on the run's bucket). The operator machine provisioned one workspace, reserved two apps (one durable, with its own wake queue) and issued a deployer, an app-caller and a revoked key, then acted only as a user: the **packed** CLI and scaffolder, installed from tarballs in a clean consumer, as separate processes with `0600` profiles.

| Case | Result | Observed |
|---|---|---|
| `setUp` | pass | public Cloud Run gateway with M10 source routes, M13 worker, Cloud SQL, queues |
| `M14.a.deploy-returns-id` | pass | `deploy --no-wait` returned `dep_52b1…` (`accepted`) in 2.9 s, with the resume hint |
| `M14.a.reconnect-by-id` | pass | the rerun resumed the same ID; a new process followed it to `active` (`rel_6dde…`, 4.8 min incl. Cloud Build) |
| `M14.a.discover` | pass | caller `apps list`/`inspect`; deployer `apps status` showed both apps |
| `M14.a.crud` | pass | create, get, update, create, delete, list through the gateway to the Cloud Run candidate |
| `M14.a.durable-workflow` | pass | durable scaffold `active` (`rel_7580…`); `followUp start` → `pending`; `followUp status` read it; **1 real Cloud Tasks task** in the app's wake queue for the delayed step |
| `M14.a.interrupt-keeps-running` | pass | SIGINT after the ID: exit 130, "NOT cancelled"; the same deployment (`dep_718f…`) reached `active`; data intact |
| `M14.a.cancel-fenced` | pass | cancelled right after submission (fence 1); repeat kept fence 1; wait exited 9; the previous release served |
| `M14.a.rollback` | pass | rollback to `rel_6dde…` promoted a new release `rel_f8f7…` on a fresh candidate; data intact |
| `M14.a.mcp-setup` | pass | `mcp setup --write` file (`0600`) at `<gateway>/w/<ws>/mcp/m14-cards`; the official MCP SDK client listed and called the app's tools over HTTPS |
| `M14.b.malformed-source` | pass | exit 2, "Packaging failed: embody.config.ts (or .mts/.js/.mjs) is required"; nothing sent |
| `M14.b.build-failure` | pass | Cloud Build failed the build script: exit 8, `BUILD_FAILED` and the fix-it hint; the previous release served |
| `M14.b.missing-scope` | pass | caller key deploying: exit 4 ("deployer credential") |
| `M14.b.stale-key` | pass | revoked key: exit 3 for deploy and for discovery |
| `M14.b.cold-timeout` | pass | exit 7 with the cold-start note at a 0.05 s deadline (below any round trip; Cloud Run instances cannot be frozen, unlike the local case) |
| `M14.c.workspace-prefixes` | pass | `/w/<ws>` URL, root + profile workspace, root + `--workspace`, a reverse proxy under `/edge` to the HTTPS gateway (status and CRUD) |
| `M14.c.no-secrets` | pass | 4 secrets (3 keys, the `.env` canary) absent from 585 KB: all CLI output, the run's Cloud Run logs (gateway, worker, candidates; read after a 90 s ingestion wait), the build logs bucket and every stored source archive |
| `cleanup` | pass | 31 resources removed; inventory empty; project IAM identical before and after |

**Cleanup, verified independently** after the run with gcloud: no Cloud Run services or jobs, service accounts, secrets, buckets, Cloud SQL instances, task queues, Artifact Registry repositories or custom roles matching `m14`/`te1a52e`; no running builds. No services were enabled by the run.

**Spend:** 4 Cloud Build builds, 5.87 build-minutes measured. The suite's conservative estimate (measured build minutes, Cloud SQL billed for 4 hours, $0.60 fixed for requests, queues, images, secrets, buckets, logs and egress) is **$0.72**, of the $6 cap; the run took about an hour, so actual charges are lower. Invoice confirmation stays open, as for M11–M13.

**Known limits of this evidence:** the cold-timeout case proves the CLI's bounded deadline, exit code and message against the real gateway, not a measured cold start (M17 owns cold latency). The durable case shows the wake task was created before the start committed; delivery of the delayed step is M13.e/M20 evidence. Logs scanned are the run's Cloud Run entries visible after 90 s.

**Reviewer decision:** pending (independent review).
