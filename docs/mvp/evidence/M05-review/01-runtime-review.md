# M05 independent review: uncommitted worktree `session-dc56` (base `596af34`)

This was a read-only review. I ran no tests, builds or cloud operations, so every test result below is what the evidence file claims, not something I checked. I couldn't write a plan file because no file-writing or plan-mode exit tool was available here, so the review is below.

## Findings, most severe first

**No critical security defect found in the local code.** The issues below are a documentation/evidence integrity problem, availability risks, and gaps in hardening and tests.

### High: the docs and evidence don't match the code
- `docs/mvp/IDENTITY.md:36-38` says *"The hosted executable does not yet supply a provider adapter."* `M05-development.md:31` says the same.
- But `apps/gateway/src/index.ts:94-96` does wire `cloudRunInvocationToken`, and it requires `GATEWAY_SERVICE_ACCOUNT_EMAIL`.
- That variable appears nowhere in the docs. It's only in code and in `postgres-store.test.ts:61`.
- The evidence reports in `M05-local/*.json` record only the base SHA plus `dirty: true`. Nothing ties them to the current file contents, so the stated counts (MVP 153, gateway 61) can't be shown to include `cloud-run.test.ts` or `invocation.test.ts`.
- The changeset says nothing about the new required variable, or that `createWorkspaceGateway` now rejects HS256. That's a breaking change for library users.
- **What's needed:** fix the docs and changeset, then rerun `verify`, `test:mvp` and the baseline on the final tree.

### Medium
1. **No allowance for clock differences on issue time.**
   - `cloud-run.ts:59` rejects a metadata ID token if its `iat` is later than the local second. A gateway clock that is a fraction of a second behind Google's will intermittently fail every dispatch for that app.
   - `packages/auth/src/index.ts:69,97` sets the same zero tolerance between the gateway and app instances. This one is documented, but nothing tests it under skew.
   - Suggested fix: allow a few seconds of `iat` leeway in the Cloud Run adapter and keep `exp` strict.
2. **Unbounded audit log in the hosted gateway.** The hosted gateway (`apps/gateway/src/index.ts:90-97`) doesn't pass an `audit` sink, so it falls back to `MemoryAuditLog` (`packages/gateway/src/index.ts:482`). That log grows without limit and isn't durable. This probably predates M05 and belongs to M07, but it should be tracked.
3. **Test gaps:**
   - No round-trip test where the gateway issues a token and a hosted host verifies it against the gateway's own `/.well-known/jwks.json`. Today `identity.test.ts` verifies with a local key set and `host/test/hosted.test.ts` mints its own tokens.
   - No `createWorkspaceGateway` test that uses `invocationToken` across HTTP, stream and MCP. Only `prepareDispatch` is unit-tested (`invocation.test.ts`).
   - Missing negative cases for the token verifier: an array `aud` (code rejects it at `auth/src/index.ts:92`, untested), `alg: none`, and a missing `kid`.

### Low
- **Metadata response handling** (`cloud-run.ts`):
  - Line 45 reads the whole response body before checking its size. This is a trusted channel, so the risk is small.
  - Nothing merges concurrent token fetches, so a cold start can send a burst of requests to the metadata server.
  - Cache eviction is first-in-first-out at 1000 entries.
- **Unknown key IDs always refetch** (`auth/src/index.ts:76`, `cooldownDuration: 0`). A request with an unknown `kid` forces a key-set fetch every time. This is only reachable if private ingress is bypassed, and it's documented. A short cooldown would still fit the 60-second publish-before-switch runbook.
- **Library-level escape hatches:**
  - `createHost` accepts any verifier. Only `createAppHost:546` blocks overrides.
  - `createWorkspaceGateway` (`workspace.ts:24-31`) doesn't check that the active `kid` is in the published key set or matches the private key unless the caller goes through `hostedSigningIdentity`.
  - The verifier with a workspace ID set allows an `http:` key URL; only the host environment parser enforces HTTPS.
  - The executable paths are safe.
- **Weak endpoint blocklist in the catalog** (`index.ts:116-151`): `http:` is allowed and IPv6 or other private ranges aren't blocked. It fails closed when the Cloud Run adapter is active, because the adapter requires HTTPS and binds the provider token's audience to that exact origin. Catalog writes are control-plane only.
- **Hosted apps still run registration and heartbeat** if those settings are present (`host/src/index.ts:627-639`), even though the hosted gateway has no registration routes. This is M08 sleep-safety territory.
- **CI coverage:** `test:mvp` runs only on Node 22 (`ci.yml:57-59`). Node 24 has only local MVP evidence.

### Checked and sound
- **Algorithm, issuer, audience and workspace pinning:** ES256 only, an exact single-string audience, `orgId` pinned to the workspace, `iat`/`exp` required with a lifetime of at most 300 seconds, a 60-second key cache, a 5-second fetch timeout, and no fallback to stale keys (confirmed by tests).
- **Gateway key validation:** the published key set is limited to allowed fields, private or symmetric keys are rejected, and the private key must match the active key (`identity.ts`).
- **Credential separation:**
  - The caller's API key is never forwarded (asserted in `identity.test.ts:78-80`).
  - The provider token goes in `Authorization` and the principal token in `X-Gateway-Auth`.
  - The host reads only `X-Gateway-Auth`.
  - The provider token is requested only after authorization succeeds, and a failure there stops dispatch.
- **Redirects:** `redirect: "error"` is set on all three execution fetches and on the metadata fetch.
- **Metadata identity checks:** issuer, exact origin audience, service account email, `email_verified` and a lifetime bound are checked; a missing `Metadata-Flavor` header is rejected.
- **Delegated MCP:** hosted MCP forces agent-on-behalf attribution. The default OIDC mapper rejects delegation claims. The store only allows delegation on agent credentials.
- **Alternate ingress:**
  - Hosted gateway: registration routes are off; `/health` and the key-set endpoint are the only unauthenticated GET routes.
  - Hosted host: legacy event ingress is rejected, verifier overrides are rejected, and signing secrets or the platform database URL are refused at startup.
- **Secret leaks:** none found in the docs, the evidence JSON or the error paths.

## Acceptance

**Local code: accept with conditions.**
- **Required before merge:** fix the documentation and changeset drift, then rerun the gates on the exact committed candidate (Node 22/24 CI plus the packed and E2E baselines).
- **Strongly recommended:** add clock-skew leeway to the Cloud Run adapter, plus the gateway-to-host round-trip test and the workspace-gateway `invocationToken` tests.
- Nothing found requires live IAM proof before the local code can be accepted.

**M05 DONE: no.** `STATUS.md:26` correctly shows IN_PROGRESS. These remain open:
- M05.b: proof that a runtime identity can't reach platform SQL, other secrets, deploy APIs or signing keys through metadata or IAM.
- M05.c: live key-set convergence across multiple gateway revisions.
- M05.d: private Cloud Run ingress, with an unauthenticated direct call rejected even when it carries a leaked valid Embody token.
- Live proof that Cloud Run accepts the token audience format (an origin without a trailing slash, and custom domains).
- Provider qualification in M09/M17.
