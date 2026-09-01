# Phase 7 — Central gateway

**Specs:** 01, gateway side of 04, relay from 06. **Status:** P7-01 to P7-03.

## Objective

Build the central control plane: authenticated app registry, health-derived catalog, caller authentication/authorization, downstream token exchange, audit/rate limits, execution dispatch, and durable event relay.

## P7-01: registry and health

- `POST /api/registry/register` authenticates per-app credentials, validates protocol/app ID/version/manifest/URLs, and atomically upserts an app generation.
- `POST /api/registry/heartbeat` requires app identity and matching generation; store last-seen using gateway time.
- Mark unhealthy after 90 seconds/three missed 30-second heartbeats. Health watcher may also probe configured health URL, but push TTL remains authoritative and SSRF controls apply.
- Publish immutable catalog snapshots so concurrent MCP/CLI reads never see partial manifest updates.
- Reject app ID ownership conflicts, endpoint changes outside policy, stale generations, oversized manifests, duplicate target/tool names, and unsupported protocol versions.
- Persist registrations so gateway restart retains data but mark status unknown/unhealthy until fresh heartbeat.

## P7-02: auth, authorization, audit, and rate limits

Create provider chain contract from spec. Built-in MVP:

- API key provider: hash at rest, constant-time verification, key ID lookup, expiry/revocation/org/roles/scopes.
- OIDC provider: issuer allowlist, discovery/JWKS cache with bounded refresh, signature/claims/audience validation, claim-to-Principal mapping.
- Clerk provider can adapt OIDC/JWT mechanisms if approved; otherwise document as post-MVP, never stub insecurely.

Issue short-lived downstream JWT with issuer, app-specific audience, subject, Principal, `jti`, issued/expiry times (target ≤5 min), and request/correlation IDs. Protect signing keys and support `kid` rotation.

Authorize target before dispatch using exact/wildcard scopes plus optional provider policy. Apply per-principal/app/target rate limiting with bounded in-memory MVP implementation or documented persistent option. Write append-only audit records for every attempt with redacted parameter summary and duration/outcome.

## P7-03: dispatch and relay

- `POST /api/execute/:appId/:target` authenticates caller, checks healthy catalog and target membership, authorizes, signs downstream token, and sends canonical `/execute` body.
- Forward deadlines, cancellation, request/trace IDs, safe response/error mappings, and progress stream in phase 8. Do not blindly forward hop-by-hop headers.
- Defend against SSRF by dispatching only to registry-approved parsed origins resolved under network policy; handle DNS rebinding per deployment model.
- Retry policy: do not automatically retry non-idempotent action execution after ambiguous timeout. Event relay uses durable retries and inbox IDs.
- Implement gateway event ingress/fan-out/delivery tables from D-03 and expose operational dead-letter controls with authorization/audit.

## Tests and success criteria

### Registry tests

- Valid registration is immediately cataloged; heartbeat keeps it live; fake clock at TTL boundary marks it unhealthy and removes tools.
- Recovery heartbeat/re-registration restores tools. Gateway restart requires a fresh liveness signal.
- Wrong secret/app identity, app-ID takeover, stale generation, endpoint outside allowlist, localhost/cloud-metadata URLs, malformed/oversized manifest, and target collision are rejected.
- 100 concurrent registration/catalog readers observe old or new complete snapshot, never mixed data.

### Security tests

- Valid API key and OIDC fixtures map to expected Principal. Revoked/expired key; bad OIDC issuer/audience/nonce/signature/JWK; and provider outage fail per documented policy.
- Downstream JWT has correct app audience and short expiry; token for Kanban fails at Email. Rotation overlap/retirement works.
- RBAC/scope denial occurs before network dispatch. Rate limit returns 429 with retry metadata and does not affect another principal/org.
- Audit records exist for auth failure, denial, unavailable app, downstream failure, and success; token/API key/password-like input is redacted.

### Dispatch/resilience tests

- Exact canonical target and input reach only selected healthy app; output and stable errors map back with same request ID.
- Unknown/unhealthy app and unadvertised target never cause outbound request.
- Timeout/disconnect cancels downstream and is not retried ambiguously.
- Circuit-breaker behavior, if added, opens/half-opens deterministically with fake clock and cannot bypass health status.
- Event ingress persists fan-out before acknowledging; duplicate event IDs are idempotent; one failing subscriber does not block successful subscribers permanently.

Phase 7 passes when an authenticated caller can execute a registered remote action end-to-end, unhealthy tools disappear within TTL, security negatives cause zero dispatch, and audit evidence exists for every outcome.