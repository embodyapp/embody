I found no blocking defects in the gateway, auth or host runtime code. The two new live probes, though, can report success when isolation is actually broken, and the proof procedure doc claims checks they don't make. That's from reading only: I didn't run anything, edit anything or contact the cloud. Plan mode asked for a plan file and a plan-approval step, but no write or exit tool was available, so this reply is the whole review.

## Prior findings: what is now fixed

- **Clock skew:** fixed. The provider adapter allows 5 seconds on `iat` and keeps expiry strict (`packages/gateway/src/cloud-run.ts:60-61`, tested at `cloud-run.test.ts:79-86`). Principal tokens still allow zero skew (`packages/auth/src/index.ts:65-71`).
- **Round-trip test:** fixed. HTTP, streaming and MCP calls now go through the gateway's public key endpoint to a real host. The test checks provider and principal headers stay separate, redirects are refused, MCP calls are attributed to an agent, and a request for an unauthorized workspace never gets a provider token (`packages/gateway/test/hosted-roundtrip.test.ts`).
- **Token negatives:** fixed. Array audience, missing `kid`, `alg:none` and HS256 tokens are rejected (`packages/auth/test/hosted.test.ts:60,72-89`), and the verifier really requires a `kid` (`auth/src/index.ts:91`).
- **CI:** fixed. The mandatory PostgreSQL/MVP and baseline jobs run on Node 22 and 24. Stable summary checks fail on any failed, cancelled or skipped run (`.github/workflows/ci.yml:32-95,122-131`).
- **Secret exposure:** nothing found. Both probe scripts swallow error text, delete the old success file before running, and never put tokens, secret values or connection strings in their reports.

## Findings

### High: the probes can report success when isolation is broken

**1. The private-invocation probe never tests a signed-in caller who isn't the gateway** (`scripts/probe-m05-invocation.mjs:36-41`)
- Both negative checks send no Google identity. Cloud Run ignores `x-gateway-auth`, so the "leaked principal token" check is the same as the unauthenticated one.
- It would pass with an `allAuthenticatedUsers` invoker binding, or with app A's runtime account allowed to call app B directly. Both are forbidden by `IDENTITY.md:84-87` and `M05-PROVIDER-PROOF.md:34-35`.
- **Fix:** call with a Google ID token from a non-gateway identity (e.g. the app runtime) and expect 403. Also send the principal token in `Authorization` and expect 401/403.

**2. The impersonation check covers too little** (`scripts/probe-m05-runtime.mjs:167-180`)
- It only tries `generateAccessToken` on the gateway account. It misses ID-token minting (`getOpenIdToken`), which is exactly what's needed to invoke apps. That permission comes from a separate role (`roles/iam.serviceAccountOpenIdTokenCreator`), so granting it would pass this check.
- It also misses `signJwt`, `signBlob`, `actAs`, and the deployer, builder and other-runtime accounts.
- A 403 here can also mean the IAM Credentials API is disabled, and nothing proves that API is working, so a disabled API reads as "denied".
- **Fix:** use `iam.googleapis.com/v1/projects/-/serviceAccounts/{sa}:testIamPermissions` for each account and require a 200 with no permissions, or check the error reason.

**3. The permission sets checked are too narrow, and the doc overstates them**
- Project level (`probe-m05-runtime.mjs:132`) checks only `run.services.create/update` and `cloudbuild.builds.create`.
- It misses `run.services.delete/setIamPolicy`, `run.jobs.create/run/runWithOverrides`, `iam.serviceAccounts.actAs`, `resourcemanager.projects.setIamPolicy`, `iam.serviceAccountKeys.create`, and project-wide `secretmanager.versions.access` (unlisted secrets are never tested).
- It also misses `cloudsql.instances.connect/update` and `cloudsql.users.update` (M05.b platform DB), Artifact Registry upload, and `logging.logEntries.list` (M05.d log access).
- Per service (`:155`) it misses `run.routes.invoke`, which would directly catch direct app-to-app invocation (finding 1), and `run.services.delete`.
- Nothing proves this API actually evaluates the caller: any 200 body without a `permissions` field, such as `{}`, counts as "denied" (`:143-147,160-164`).
- `M05-PROVIDER-PROOF.md:67-69` describes these as "effective project and service-specific deployment/build/IAM permissions", which overstates what is checked.

### Medium

**4. A permission error after connecting can count as "connect denied"** (`probe-m05-runtime.mjs:190-197` with `:240-254`)
- The `try` wraps both `client.connect()` and the `pg_roles` query. If the role can connect but is denied the catalog query, PostgreSQL returns `42501` and the probe records a CONNECT denial.
- **Fix:** only classify errors from the connect step, and check the "permission denied for database" message.
- The least-privilege check also ignores `rolreplication` and membership in powerful roles (`pg_read_all_data`, `pg_write_all_data`, `cloudsqlsuperuser`).

**5. The example config passes validation unchanged** (`probe-m05-runtime.mjs:17`, `infra/mvp/m05-runtime-probe.example.json:2,8`)
- An all-zero candidate SHA and the literal example project are accepted, so a success report could record a placeholder SHA.
- The invocation probe also imports `packages/gateway/dist` (`probe-m05-invocation.mjs:87`) with no check that the build matches the candidate.

### Low

6. **Positive control can't confirm workspace.** Host `/health` returns only `appId` (`packages/host/src/index.ts:201-206`), and the probe matches the origin by service-name prefix only (`probe-m05-invocation.mjs:18`). The control can't confirm workspace binding or that the app accepts the principal token, so it is not live M05.a/c evidence.
7. **Gateway will mint provider tokens for any `*.run.app` origin in the catalog** (`cloud-run.ts:22-30`). There's no project or service allowlist, so this relies entirely on the catalog not being tampered with. A bad entry would receive both a Google ID token and a principal token valid for 300 seconds. Private ingress stays mandatory.
8. **Test gaps:**
   - The unsafe-origin cases all fail on the hostname, so the path, query and userinfo checks for real `*.run.app` hosts are untested (`cloud-run.test.ts:89-96`).
   - No test covers `createAppHost` in hosted mode, including rejecting a verifier override (`host/src/index.ts:546`).
   - Stale-report removal is tested only for the runtime probe, not the invocation probe (`m05-runtime.test.mjs:207-226`).
9. **Stale baseline evidence.** `M05-local/baseline.json` has a different lockfile hash from `mvp.json` (`e11da6…` vs `9f862a…`), so it ran on a different dependency set. This is disclosed (`M05-development.md:65-68`), but it must not count as candidate evidence.

## Local merge blockers

- **No code-level security blocker** in the gateway, auth or host runtime code.
- **Process blockers:** commit the candidate, then get clean CI on that exact commit for Node 22 and 24 (PostgreSQL/MVP and baseline). The current reports are from an uncommitted worktree, and the baseline is stale.
- **Conditional blocker:** either fix findings 1–4, or narrow the claims in `M05-PROVIDER-PROOF.md` (lines 65-76 and 90-98) to what the probes actually check. As written, the procedure would let a live run report a false pass.

## Disposition

- **Local code:** acceptable once the candidate commit passes Node 22/24 CI. The probe fixes (or doc corrections) are needed before the probes are used for live proof.
- **M05 DONE:** not met. There is no owner-approved dedicated cloud project, access or budget. Live proof is missing for runtime metadata/IAM/SQL denial, private ingress with external denial, and multi-revision key rotation. The mocked probe tests only show the scripts fail safely; they are not IAM evidence.
