# M14 local journey evidence (phase 1, no cloud)

| Field | Value |
|---|---|
| Task / acceptance cases | M14.a, M14.b, M14.c on the local integration topology ([CLI](../../CLI.md#verification)) |
| Owner / reviewer | claude / independent review pending (after the live journey) |
| Date / CI | 2026-10-24, local macOS run; exact-candidate CI pending on the PR |
| Commit | `5b55835291cfd513683f3306541b86fee504990b` (clean tree, `dirty: false`) |
| Runtime | Node v24.21.0, npm 11.19.0, pnpm 11.25.0 (lockfiles `corepack pnpm@11.25.0`), Docker 29.8.2 |
| PostgreSQL | `postgres:16-alpine` fixture `sha256:721873c3…` in a private Compose project (`embody-m14-verification`, loopback port 55514); the shared `embody-local-*` services were not touched |
| Environment | local integration topology: hosted workspace gateway, M12 controller, M11 build admission on the local Docker build emulator (real recipe image built from this commit, local framework registry), M13 release stages with per-app databases via the provisioner role, candidates as Docker containers |
| Command | `pnpm test:m14` with `EMBODY_PLATFORM_URL`, `EMBODY_PLATFORM_MIGRATION_URL`, `EMBODY_POSTGRES_URL`, `EMBODY_POSTGRES_MIGRATION_URL`, `EMBODY_POSTGRES_OTHER_URL`, `EMBODY_POSTGRES_TEST_CONTAINER`, `EMBODY_PROVISIONER_URL` (fixture values; names only) |
| Result | **16 passed, 0 failed, 0 skipped**; 5 builds, 4 candidates, 81 controller tasks, 305 s |

The CLI and the scaffolder were packed and installed from their tarballs into a clean consumer directory; every journey step spawned that installed binary with a clean environment and protected profiles (`0600`). The only operator steps (workspace, two reserved apps with their identities, a deployer key, an app-caller key, a revoked key) ran before the journey.

| Case | Result | Observed |
|---|---|---|
| `M14.a.deploy-returns-id` | pass | `deploy --no-wait` returned `dep_e16f…` in state `accepted` with the resume hint |
| `M14.a.reconnect-by-id` | pass | rerun resumed the same ID; a new process followed it to `active` (`rel_d477…`) |
| `M14.a.discover` | pass | caller `apps list`/`inspect`; deployer `apps status` showed both apps |
| `M14.a.crud` | pass | create, get, update, create, delete, list (6 operations) |
| `M14.a.durable-workflow` | pass | durable scaffold `active` (`rel_45d3…`); `followUp start` → `pending`; `followUp status` read it; 1 wake task created for the delayed step |
| `M14.a.interrupt-keeps-running` | pass | SIGINT after the ID: exit 130, "NOT cancelled"; the same deployment reached `active`; data intact |
| `M14.a.cancel-fenced` | pass | cancelled right after submission (fence 1); repeat kept fence 1; wait exited 9; previous release served |
| `M14.a.rollback` | pass | rollback to `rel_d477…` promoted a new release `rel_cfa6…`; data intact |
| `M14.a.mcp-setup` | pass | `mcp setup --write` made a `0600` file; the official MCP SDK client listed and called the app's tools |
| `M14.b.malformed-source` | pass | exit 2, "Packaging failed: embody.config.ts (or .mts/.js/.mjs) is required" |
| `M14.b.build-failure` | pass | exit 8, `BUILD_FAILED` with the fix-it hint; previous release served |
| `M14.b.missing-scope` | pass | caller key deploying: exit 4 ("deployer credential") |
| `M14.b.stale-key` | pass | revoked key: exit 3 for deploy and discovery |
| `M14.b.cold-timeout` | pass | serving container frozen: exit 7 with the cold-start note after 3 s; answered again after unfreezing |
| `M14.c.workspace-prefixes` | pass | `/w/<ws>` URL, root + profile workspace, root + `--workspace`, reverse proxy under `/edge` (status and CRUD) |
| `M14.c.no-secrets` | pass | 4 secrets (3 keys, the `.env` canary) absent from 430 KB of CLI output, gateway audit lines, worker log, candidate logs, build logs and the uploaded archives |

**Other local gates on this branch:** `pnpm verify` passed (CLI 29 tests including the new M14 suite, gateway 296 + 4 optional skips, contracts 106, create-embody-app 4; lint, license, typecheck, build, API report, format); `pnpm test:verification` 110 passed, 0 skipped.

**Provider stand-ins (why this is local evidence only):** no Cloud Run IAM, ingress or scaling; Cloud Tasks requests recorded but not delivered; the platform JWKS reached over HTTP through a test-only preload in the candidate process (the admitted image is unchanged); the source object store on loopback HTTPS with a throwaway certificate. The live journey (phase 2, owner-approved budget) covers these.

**Cleanup:** all 4 candidate containers, the run's app images and the builder image removed; both per-app databases and roles dropped (zero `embody_m14l%` databases left); no cloud resources exist.

**Reviewer decision:** pending.
