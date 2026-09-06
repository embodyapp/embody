# Security model and incident procedures

## Threat model

Trust boundaries are the public gateway, gateway-to-app JWT channel, direct event receiver, database, plugin code, and development inspector. Plugins run in-process and are trusted application code; Embody is not a JavaScript sandbox. Primary threats are cross-tenant access, forged principals/events, SSRF through registered endpoints, injection in JSON/SQL/logs, replay, secret disclosure, denial of service, and supply-chain compromise.

Controls include catalog-gated dispatch, audience-bound short-lived JWTs, segment-aware scopes, PostgreSQL RLS, org-bound repositories, parameterized SQL, strict protocol schemas, endpoint-origin policy, signed event envelopes, inbox idempotency, request/body/concurrency limits, safe error envelopes, CSP/security headers, and redacted workflow/inspector records. CORS is disabled by default. Fastify/Node own HTTP framing and reject conflicting framing; do not place a proxy in front that normalizes ambiguous requests differently.

Residual risks: at-least-once actions, event handlers, and workflow steps require idempotent external effects; a compromised trusted plugin can access its process credentials; SQLite is for a single trusted process and does not provide database RLS.

## Production configuration

Production rejects the development verifier, absent PostgreSQL/JWT/gateway settings, common default secrets, and plain HTTP gateway/public URLs. Plain HTTP requires the explicit `TRUST_INSECURE_HTTP=true` acknowledgement and should only be used on an authenticated private network. Terminate TLS at a trusted proxy, cap decompressed bodies there, and preserve `traceparent` and `x-request-id`.

Use separate PostgreSQL owner/migration and runtime roles. The runtime role must not own tables, have `BYPASSRLS`, or have broad schema DDL rights. Verify with `rolbypassrls = false`, `relrowsecurity = true`, and a raw cross-org query in deployment CI.

## Rotation and compromise

1. Create a new random registration/event/JWT key in the secret manager; never log it.
2. For JWTs, deploy verifiers accepting old and new key IDs, switch issuers, wait longer than maximum token TTL, then remove the old key. HS256 deployments that cannot accept two keys require a coordinated gateway/app rolling deployment.
3. For registration and event HMAC secrets, roll producers and receivers with a bounded dual-key overlap, then revoke old values.
4. API keys are stored hashed by the gateway. Issue replacement, verify it, revoke the old key, and inspect auth-denial/audit activity.
5. On compromise, stop admission, revoke affected keys, isolate workloads, preserve immutable audit/database logs, identify affected organizations and event IDs, restore if integrity is uncertain, and notify owners under the applicable incident policy.

Never reuse secrets across environments or applications. Rotation must be rehearsed at least quarterly.

## Dependency and artifact review

Run `pnpm security:audit`, `pnpm sbom`, and `pnpm release:artifacts`. High/critical exploitable findings block release unless a time-bounded mitigation and owner are recorded in the release checklist. The generated CycloneDX SBOM covers production npm dependencies; image scanners must add OS packages and image digest/signature evidence.
