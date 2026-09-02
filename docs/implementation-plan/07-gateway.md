# Phase 7 — Central gateway

**Specs:** 01, gateway side of 04, optional relay from ADR 0004. **Status:** P7-01 to P7-04.

## Objective

Build the central control plane: authenticated app registry, health-derived catalog, caller authentication/authorization, downstream token exchange, audit/rate limits, and execution dispatch. Add durable event relay as an optional transport adapter after the required gateway path works.

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

## P7-03: dispatch

- `POST /api/execute/:appId/:target` authenticates caller, checks healthy catalog and target membership, authorizes, signs downstream token, and sends canonical `/execute` body.
- Forward deadlines, cancellation, request/trace IDs, safe response/error mappings, and progress stream in phase 8. Do not blindly forward hop-by-hop headers.
- Defend against SSRF by dispatching only to registry-approved parsed origins resolved under network policy; handle DNS rebinding per deployment model.
- Retry policy: do not automatically retry non-idempotent action execution after ambiguous timeout.
- Expose a read-only subscription directory compatible with the Phase 6 direct transport, while preserving static directory support for deployments that do not use the gateway.

## P7-04: optional durable event relay

- Implement an `EventTransport` adapter conforming to ADR 0004; domain plugins and receiver handlers must not change when switching from direct delivery.
- Authenticate event ingress, snapshot all matching registered subscriptions (including temporarily unhealthy destinations), and persist independent fan-out delivery rows before acknowledging the publisher.
- Deliver through the same authenticated `/events/deliver` receiver interface and inbox IDs used by direct transport.
- Expose authorized, audited delivery status, retry, and dead-letter controls. Gateway restart after acknowledgement must not lose delivery.
- Keep this adapter outside the MVP release critical path and clearly report whether a deployment has enabled it.

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
- Optional P7-04 conformance: event ingress persists fan-out before acknowledging; duplicate event IDs are idempotent; one failing subscriber does not block successful subscribers permanently; gateway restart loses no acknowledged delivery.

Phase 7 passes when an authenticated caller can execute a registered remote action end-to-end, unhealthy tools disappear within TTL, security negatives cause zero dispatch, and audit evidence exists for every outcome.