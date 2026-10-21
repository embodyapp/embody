# M13 local evidence (phase 1)

**Candidate:** `a561eaf` on `feat/mvp-m13-provision-promote` (from `33bcc62`, M12 DONE). Node 24.21.0, pnpm 11.25.0, `pnpm install --frozen-lockfile`. Disposable fixture: Compose project `embody-m13-verification`, loopback port 55741, from `docker-compose.postgres-test.yml` and `test/postgres/init.sql` (which now also creates the fixture-only `embody_provisioner` role). No cloud resources were created and nothing was spent; the live suite `m13` waits for an owner-approved budget.

| Command | Result |
|---|---|
| `pnpm verify` (no DB variables) | exit 0: lint, license, typecheck, tests (optional DB files skipped as designed), build, API report, format |
| `pnpm test:verification` | **108** passed, 0 skipped (M13 adds 7 mocked live-suite guard, evaluator and teardown cases) |
| `pnpm test:mvp` | **630** passed, 0 skipped: postgres 16, gateway-store 68, contracts 106, auth 6, host 113, MCP 18, gateway 287 (M13 adds 21 release and 6 adapter cases, and splits one M12 bound case in two), CLI 16 |
| `pnpm test:m12` | **128** passed, 0 skipped |
| `pnpm test:m13` | **87** passed, 0 skipped: release (memory) 21, release (real PostgreSQL) 14, Google adapters 6, M12 controller 32 and its real-PostgreSQL file 12, storage migration policy 2 |

Each evidence JSON (`.artifacts/verification/{mvp,m12,m13,postgres,gateway-store}.json`) records commit `a561eaf`, `dirty: false`, failed 0, skipped 0.

## Acceptance coverage (local)

| Case | Where |
|---|---|
| M13.a first deploy registers; update switches route and manifest together; no mixed catalogs | `release.test.ts` (reserved app, registration from the re-read manifest, namespace from the platform, drain then sweep); `release.postgres.test.ts` (a second pool reads the catalog throughout three promotions and sees only release-defined pairs) |
| M13.b failed readiness / compatible migration failure leaves the old route; destructive migration modifies nothing | memory: readiness timeout, crashing revision, failing migration; real PostgreSQL: contract migration refused before execution and a failing expand migration rolled back, ledger, columns and checksum unchanged; an older release boots after an expand migration |
| M13.c concurrent promotions, stale and cancelled workers | memory: race, stale promoting claim, cancel during checks, review finding 1 (late candidate after a timed-out stage); real PostgreSQL: promotions completed concurrently on two pools |
| M13.d rollback restores code with data intact; incompatible rollback refused | memory: rollback through the route (replay, fresh candidate, previous manifest, data and schema unchanged), refusals (active, expired, stale generation, unknown), schema reader floor, workflow versions; real PostgreSQL: rollback, replay, expiry refusal |
| M13.e workflow v1 finishes on v1 after v2; dropping v1 refused; subscriptions switch with the generation | real PostgreSQL: a v1 instance started on release A's code completes on release B's code (real engine, `WorkflowWorker`); memory: `WORKFLOW_VERSION_IN_USE`, `WORKFLOW_VERSION_CHANGED`, subscriptions switch in one write |
| Retention (M12 re-review N1/N3/N4) | 9 × 10 MiB promoted sources: replaced pins released, purged after retention, uploads still fit (memory and PostgreSQL); `migrate()` repair of pre-M13 rows; pinned column agrees with `pinnedBy` |
| Crash matrix (SIGKILL) | after a migration, after a credential version, after candidate creation, after an update's promotion (see [RELEASES](../RELEASES.md#verification)) |

## Findings fixed during phase 1

- **App-name audience:** hosted apps verify the gateway's tokens against their own `defineApp({ appId })`, which the gateway issues for the catalog name; a release built under another name could serve no call. Now refused at checks (`APP_NAME_MISMATCH`).
- **Cloud SQL connector:** a candidate's runtime identity needs `roles/cloudsql.client`; the controller grants it through a project IAM admin grant conditioned to that one role, so it gains no other IAM authority.
- **Test isolation:** `test:m13` runs its files sequentially: platform-wide MD12 recovery on a test clock years ahead would otherwise wake the M12 file's in-flight deployments.

## Not yet proven (phase 2)

Real Cloud Run candidates, promotion, rollback and the IAM conditions above need the live suite `m13` (`infra/mvp/m13`, proposed cap $6, projection $0.99 per run). Exact-candidate CI and the independent review are also outstanding.
