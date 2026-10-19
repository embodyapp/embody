# Hosted identity and tenant isolation (M05)

## Trust boundaries

```text
scoped user/agent API key
  -> HTTPS gateway /w/<workspace> (durable M04 credential and grant lookup)
  -> catalog + action/scope authorization
  -> ES256 principal JWT: issuer, one app audience, orgId, iat, exp, kid
  -> private provider invocation: provider ID token in Authorization
  -> app: principal JWT in X-Gateway-Auth; public JWKS verification
  -> kernel authorization/hooks -> app-only database runtime role
```

The API key is never forwarded. Provider identity authorizes network/service invocation,
not Embody actions. The principal JWT authorizes the application request, not cloud APIs.
Human/system MCP credentials become delegated agents using verified credential metadata
(hosted gateways force this attribution even if the legacy `token` opt-out is requested);
client-supplied delegation is not trusted. The default OIDC mapper rejects delegation
claims; a custom mapper is responsible for authorizing its own upstream contract.

## Implemented configuration

Hosted gateway (`GATEWAY_PROFILE=hosted`):

- `GATEWAY_PLATFORM_DATABASE_URL`: platform runtime role, not migrator/bootstrap.
- `GATEWAY_SERVICE_ACCOUNT_EMAIL`: exact provisioned gateway workload service account.
  The metadata ID token must match this identity, not an app/deployer/operator account.
- `GATEWAY_JWT_ISSUER`: stable, explicitly provisioned issuer.
- `GATEWAY_JWT_PRIVATE_KEY`: PKCS#8 ES256 private PEM, gateway-only secret.
- `GATEWAY_JWT_KID`: active key ID.
- `GATEWAY_JWT_PUBLIC_JWKS`: JSON `{ "keys": [...] }` with 1–10 unique public
  EC/P-256 keys, `alg=ES256`, `use=sig`; active key must match the PEM.

`GET /.well-known/jwks.json` is public, returns only allowlisted public fields and
has `Cache-Control: public, max-age=60`. Startup rejects private/symmetric public
keys, duplicate IDs and active key mismatches. Issued tokens live exactly 300 seconds.
The library accepts a trusted `invocationToken(origin)` adapter. It receives only the
catalog origin after authorization and puts its result in `Authorization`; failures
prevent dispatch. The hosted executable wires `cloudRunInvocationToken`: it fetches
Google ID tokens from the fixed local metadata endpoint, checks metadata flavor, issuer,
exact origin audience and workload email, then caches only until 60 seconds before expiry.
Retrieval timeout is 5 seconds and refresh failure never uses an expired cached token.
Google token issuance allows 5 seconds of `iat` clock skew while expiry remains strict;
Embody principal token verification retains zero clock tolerance. Metadata is the trusted
local issuer channel; Cloud Run performs signature verification. Only default HTTPS
`*.run.app` origins are supported; custom-domain invocation is not admitted by this profile.
No ADC file, impersonation credential or caller-controlled metadata URL is used.

Hosted app (`EMBODY_HOST_PROFILE=hosted`):

- `NODE_ENV=production`, `DATABASE_URL`: app-specific PostgreSQL runtime role.
- `EMBODY_WORKSPACE_ID`: the provisioned `ws_...` ID, fixed by trusted deployment.
- `GATEWAY_JWT_ISSUER`, `GATEWAY_JWKS_URL` (HTTPS): public verification configuration.
- No `GATEWAY_JWT_SECRET`, `GATEWAY_JWT_PRIVATE_KEY`, platform DB URL or verifier override.
- No legacy `EMBODY_EVENT_SECRET`/event destinations: shared-secret event ingress has no
  app/workspace principal binding and is not exposed by hosted apps.

Every execute/stream request verifies ES256, issuer, exact single app audience,
workspace, expiry and issuance time. Tokens must have `iat`/`exp`, lifetime at most
300 seconds and no future issuance. No clock tolerance is enabled; synchronize clocks.
There is no stale-key fallback after cache expiry if JWKS retrieval fails. Cache maximum
is 60 seconds; retrieval timeout is 5 seconds. Unknown key IDs trigger refresh immediately
(to support overlap), subject to a one-second unknown-ID refresh cooldown; use edge
request limits as well as M07 dispatch limits.

The old reference profile retains HS256 for existing local/distributed fixtures.
It is **not** the hosted isolation contract. A production hosted deployment must set
both hosted profile flags explicitly. Hosted apps do not require heartbeat registration;
they may still optionally register if reference registration settings are supplied.
This change does not claim M08 sleep-safe worker/scaffold completion.

## Required provider role matrix (not yet live-qualified)

| Identity | Allowed | Must be denied |
|---|---|---|
| Gateway | platform runtime DML; gateway signing secret; invoke admitted app services | migration DDL; builds; deployment; app DB credentials |
| Controller/deployer | provision approved services/identities and bind approved runtime identity | signing secret; arbitrary impersonation; customer app SQL |
| Builder | isolated source input and scoped artifact output | platform/app DB; runtime secrets; signing keys; deployment |
| App runtime (one per workspace/app) | own app DB runtime credential; own explicitly admitted secrets | platform DB; other app secrets/DB; signing key; deploy/build APIs; identity impersonation |
| App migrator (one per workspace/app) | own app migration credential and bounded migration execution | other app/platform DB; signing/deploy/build privileges |
| Platform migrator/operator | explicit platform schema/credential administration | normal user API availability; automatic runtime bootstrap |

Do not grant project-wide Editor/Owner, Secret Accessor or service-account token creation
to app runtimes/builders. Bind secret access to exact secret resources, Cloud Run invoker
to gateway on exact app services, and SQL grants to exact app databases. Deny public
invocation and use private platform-to-app ingress. The provider ID token audience must
be the admitted Cloud Run origin, not an arbitrary caller URL; obtain it using gateway
workload identity, never a caller API key. Do not send provider tokens to redirected
origins; all gateway execution fetches use `redirect: "error"`. Custom transport adapters
must preserve that restriction during live qualification.

**Open acceptance:** no live Cloud Run IAM configuration or metadata negative test is claimed.
Executable metadata/IAM/SQL and private-invocation probes are provided in
[provider proof procedure](./M05-PROVIDER-PROOF.md); their local mocked failure tests do not
constitute live provider evidence.
M09/M17 must prove each runtime identity cannot access platform SQL, another secret,
deployment APIs or signing keys, and unauthenticated external invocation fails even with
a leaked valid Embody token. Separate PostgreSQL roles are tested locally, not proof of
provider IAM. Management/log/source/secret APIs not yet delivered by their milestones
must remain absent, not be treated as authorized by this token work.

## Key rotation and revocation runbook

1. Generate a new ES256 key under gateway-only secret authority. Assign a fresh `kid`.
   Never reuse IDs or distribute private keys to apps, archives, builds or evidence.
2. Publish **old + new public keys** on every gateway revision first. Wait at least
   60 seconds and verify public JWKS convergence before switching the active signer.
3. Deploy the new PEM/active ID while retaining both public keys. Confirm old and new
   token acceptance on every app. A new `kid` also triggers an immediate JWKS refresh.
4. After the last old signer is stopped, retain the old public key for at least 300 seconds
   (plus operational rollout margin); then remove it from **every** serving JWKS revision.
5. App key caches may accept a removed key for at most 60 seconds after authoritative
   removal. A fetched stale old gateway revision invalidates this bound: remove/drain all
   old serving revisions first. No CDN may override the 60-second cache contract.

For compromise, stop the old signer and remove its public key immediately on all gateway
revisions; apps reject it after cache expiry (or earlier fresh lookup). Restart apps if
immediate cache eviction is required. Tokens verified before removal cannot cancel already
running actions. Revoking an API credential blocks the next gateway request immediately
(M04 no positive credential cache); a previously issued principal token remains valid for
at most its remaining 300-second lifetime while its signing key is trusted. Private ingress
is therefore mandatory, not optional protection against replay. Disable/deletion fencing
and logs/secrets operation revocation remain M13/M15 work.

## Verification

`pnpm test:mvp` now includes auth and host suites alongside contracts, gateway, real
app PostgreSQL and real platform store conformance. Cryptographic negatives cover expiry,
missing/excessive lifetime, wrong issuer/algorithm/audience/workspace, forged delegation,
attacker signing keys, public-key overlap/removal and failed key retrieval. Host HTTP/SSE
negatives demonstrate rejection before kernel execution. Existing M04 store conformance
continues to cover cross-workspace catalog/action/MCP and credential revocation.

See [M05 development evidence](./evidence/M05-development.md). Independent review, exact-candidate Node 22/24 CI/baselines and actual provider negative
proof are required. See the development evidence for current dispositions.
