# Trustworthy verification runners (M03/M04)

Use Node **22 or 24**, pnpm **11.25.0** and the frozen lockfile. PostgreSQL/container gates require Docker; the packed-consumer baseline requires npm **11**, matching CI. Never run these disposable fixture migrations or isolation drills against customer databases.

## Commands and what they prove

| Command | Prerequisites / meaning |
|---|---|
| `pnpm verify` | Workspace quality/build/API/package tests and runner negatives. DB cases may explicitly skip in this optional local layer when no URL exists; this is not DB evidence. |
| `pnpm test:verification` | 36 deterministic runner tests, including intentionally missing DB/cloud config, rejected budgets, normalized credential redaction and false-green JSON reports. No DB or cloud required. |
| `pnpm test:postgres` | Required runtime/migration/other-app URLs and actual disposable PostgreSQL container ID; builds, migrates as maintenance, tests runtime isolation plus storage/kernel adapters, rejects **any** required skip or empty report. |
| `pnpm test:gateway-store` | Separate platform runtime/migration URLs plus app fixture URLs/container; maintenance migrations, real store conformance, fresh-process/two-gateway/MCP and SQL boundary tests, zero required skips. |
| `pnpm test:mvp` | Both app/platform DB prerequisites; runner regressions + mandatory app/kernel and gateway-store cases + current contract/auth/host/MCP/gateway suites. Extend its explicit suite list as later implementations land. It does not qualify an unimplemented deployment controller or provider. |
| `pnpm test:mvp:client` | Opt-in installed/authenticated Claude Code **2.1.296**; synthetic local hosted gateway/host, direct bearer-auth MCP across replicas/replacement, live 120-second idle observation and plain CLI discovery/action. Model budget `$1`; no cloud resources. [Contract](./MCP.md). Missing client/auth or failed/quiescence check cannot pass. |
| `pnpm test:baseline` | Docker + npm 11; builds clean packed CLI/scaffold/plugin artifacts and executes the actual distributed E2E. Records app/PostgreSQL image IDs/digests. CI runs this on both Node 22/24. |
| `pnpm test:mvp:runtime-isolation` / `pnpm test:mvp:private-invocation` | Targeted M05 live metadata/IAM/SQL and private-invocation probes, requiring actual dedicated fixture workloads and approved budget/config. Not yet live-run; [procedure](./M05-PROVIDER-PROOF.md). Their six mocked fail-closed tests are included in `test:verification`, not claimed as provider evidence. |
| `pnpm test:mvp:cloud` | Explicit test project/resource prefix, approved positive budget and accessible credential file. **Always exits nonzero today**: M09–M17 qualification suites do not exist yet. It never creates resources or reports placeholder success. |

The package-level `pnpm --filter @embody/storage test:postgres` also rejects missing configuration, sets mandatory mode, and includes PostgreSQL **and kernel-adapter** tests. It assumes the root runner already built/migrated/granted the schema; use the root command for the actual gate. The gateway package also exposes `test:postgres` with a prerequisite guard; root `test:gateway-store` performs the build/platform migration/grants and rejects skipped/empty/failed reports. Ordinary gateway tests explicitly exclude this real-store file; mandatory MVP includes it separately.

## Local disposable PostgreSQL fixture

The fixture uses public **test-only** passwords in `test/postgres/init.sql` and `fixture.env.example`; these are not production secrets. Its bootstrap superuser only creates databases/roles. Migration and runtime execution use separate restricted roles:

- `embody_migrator`: owns app A schema/tables; NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOBYPASSRLS.
- `embody_runtime`: non-owner, same restricted flags; schema usage plus data-table SELECT/INSERT/UPDATE/DELETE only. No schema creation or migration-ledger access.
- `embody_other`: owns app B; PUBLIC CONNECT removed from app databases; app A runtime cannot connect to B.
- `embody_platform_migrator` / `embody_platform_runtime`: separate restricted maintenance/non-owner runtime identities in a **third platform DB**, not app tables. App runtime cannot CONNECT to platform; gateway runtime cannot CONNECT to app A. Runtime cannot migrate/CREATE/ALTER platform tables.

```sh
pnpm install --frozen-lockfile
docker compose --project-name embody-m04-verification \
  --file docker-compose.postgres-test.yml up --detach --wait
set -a
. test/postgres/fixture.env.example
set +a
pnpm test:postgres
pnpm test:gateway-store
pnpm test:mvp
# Inspect only sanitized .artifacts/verification/*.json.
docker compose --project-name embody-m04-verification \
  --file docker-compose.postgres-test.yml down --volumes --remove-orphans
```

Default local port is 55432, bound only to loopback. If busy, set `EMBODY_POSTGRES_TEST_PORT` before Compose and supply matching URLs rather than changing another person's service. Fresh initialization must run on a fresh disposable container/data directory. Do not rerun `init.sql` against an existing customer or shared database; it intentionally fails on duplicate fixture roles/databases instead of silently repurposing them.

Required variables are **names only** in evidence:

- `EMBODY_POSTGRES_URL`: app A runtime connection.
- `EMBODY_POSTGRES_MIGRATION_URL`: different maintenance identity on the same server/database.
- `EMBODY_POSTGRES_OTHER_URL`: distinct app B database on that server.
- `EMBODY_PLATFORM_URL` / `EMBODY_PLATFORM_MIGRATION_URL`: different restricted gateway runtime/maintenance roles on a distinct platform DB on the same test server; must not reuse either app DB/role.
- `EMBODY_POSTGRES_TEST_CONTAINER`: actual Docker PostgreSQL service ID/name for immutable image evidence (CI uses `job.services.postgres.id`). This M03 gate is a Docker fixture, not managed-provider qualification.

The runner fails before build/tests if any required configuration is absent. Preparation checks the maintenance identity is not elevated, applies real storage migrations, verifies table ownership and grants only runtime data-table DML. Runtime SQL negatives assert that it cannot create/alter schema, write the migration ledger, assume maintenance, gain BYPASSRLS, bypass RLS via `row_security=off`, write another tenant's rows or connect to app B. Existing raw-read RLS/SET LOCAL checks and concurrency claims also execute.

Expected current mandatory app DB result: **12 passed, zero skipped** (10 PostgreSQL cases, SQLite adapter boot and PostgreSQL runtime-role kernel boot). Mandatory gateway-store result: **25 passed, zero skipped** (20 shared conformance cases including M06 replica/replacement/grant/scope/no-host-discovery/shutdown, plus separate-process persistence, actual hosted bootstrap, closed-pool fail-closed, platform-role/DDL and cross-DB CONNECT negatives). Current MVP result: **182 passed, zero skipped**, broken down as app DB 12 + gateway-store 25 + contracts 38 + auth 6 + host 16 + MCP 18 + gateway 67. M05 adds mandatory asymmetric token/rotation and host rejection coverage; see [identity contract](./IDENTITY.md). Runner unit tests are separately reported as 36, not mixed into that Vitest count. Optional workspace verification with no DB reports 11 explicit DB skips; the mandatory CI DB/MVP job must report zero.

To reproduce the missing-config failure deliberately, run `pnpm test:verification`. Its subprocesses remove inherited credentials, invoke the selected DB/MVP runners, assert exit 1 before any build/test, and remove temporary evidence. Never paste real connection strings in a shell history or evidence file.

## Clean packed/distributed baseline

```sh
# Clean worktree/check out the exact candidate; choose supported Node on PATH.
pnpm install --frozen-lockfile
# Provide npm 11 on PATH (CI installs it in its disposable runner).
npm --version
pnpm test:baseline
```

Repeat separately for Node 22 and Node 24. Rebuild native SQLite dependencies when changing ABI. CI's artifact matrix uses separate clean Linux runners, not a local dirty-tree pass. The Docker reference-app recipe still uses Node 24; Node 22/24 host/packed-scaffold consumers are both tested. This is baseline distributed framework behavior, **not** the request-only hosted profile, scale-to-zero, stateless MCP or hosted background-workflow qualification.

M01's SQL Compose initializer is reused without a local workaround. The journey creates an isolated Compose project, tests CLI/MCP/HTTP/events/restart/TTL/isolation, tears down containers/volumes and keeps the shared built image for digest inspection. If interrupted, remove only the project's test resources—never global `docker system prune`.

## Evidence and CI

Sanitized JSON defaults to `.artifacts/verification/` (ignored by Git); override `EMBODY_TEST_EVIDENCE_DIR` if needed. Reports include gate outcome, timestamp, exact Git commit/dirty flag, Node version, SHA-256 lockfile/app-schema/platform-schema/fixture, executed/failed/skipped counts, per-suite MVP counts, PostgreSQL version and actual DB container image identity. Baseline counts label **journeys**, not fabricated unit counts, and include app/PostgreSQL image IDs/registry digests. Local dirty reports are development diagnostics; task acceptance uses clean committed-candidate CI.

Raw Vitest JSON is temporary and deleted, not published as evidence. Child output replaces known secret/URL/password variants; public reports do not contain env values, query payloads, tokens or connection strings. Redaction is defense in depth, not permission to log arbitrary customer data. Failures exit nonzero and write failed evidence; empty/all-skipped reports cannot pass.

CI uploads the sanitized JSON on success/failure as `postgres-mvp-evidence-node-22`/`-24` and `baseline-evidence-node-22`/`-24`; missing evidence files fail upload. The DB matrix provisions disposable PostgreSQL 16 fixtures on both Node majors, executes deliberate prerequisite regressions, then mandatory DB/MVP tests. A stable `postgres` aggregate requires both mandatory DB/MVP matrix legs to pass. The baseline matrix builds/packs/runs actual E2E on both supported Node majors. A stable `e2e-artifacts` aggregate preserves the existing protected check name and succeeds only when both matrix legs succeed (failed/skipped/cancelled matrix results fail the check). Retain the run link and exact tested head in dated task evidence. No skipped DB job is accepted as successful conformance.

## Future cloud qualification gate

Required names: `EMBODY_MVP_CLOUD_PROJECT`, `EMBODY_MVP_CLOUD_RESOURCE_PREFIX` (starts `embody-test-`), `EMBODY_MVP_CLOUD_BUDGET_USD` (positive), `EMBODY_MVP_CLOUD_BUDGET_APPROVED=true`, and `GOOGLE_APPLICATION_CREDENTIALS` (accessible file). Obtain explicit owner approval for a dedicated project/budget before supplying them. Budget flags are attestations, not hard spending caps or IAM proof.

M03 tests missing credentials/budget and the deliberately unimplemented qualification path without contacting cloud APIs. M09–M17 must implement the real suites, IAM checks, bounded observation, cleanup inventory and measured costs before this command can pass. M03 completion does not authorize spend, customer data or release.
