# Self-hosting the Embody Gateway

> Build and operate your own production control plane with `@embody/gateway`.

---

## When to self-host

Self-host when an organization needs to control identity, networking, audit retention, availability, or data-plane placement. Applications and clients use the same registration, catalog, execution, and MCP contracts as a managed Embody Gateway.

The package is a composition library rather than a zero-configuration SaaS replacement. The operator owns its production configuration and operations.

---

## Minimal composition

This example shows the required shape. Replace environment parsing and operational collaborators with your platform's configuration and secret systems:

```typescript
import {
  AuthChain,
  FixedWindowRateLimiter,
  GatewayRegistry,
  MemoryAuditLog,
  createGateway,
  oidcProvider,
} from "@embody/gateway";

const signingSecret = process.env.GATEWAY_JWT_SECRET;
const registrationSecret = process.env.OPS_REGISTRATION_SECRET;
if (!signingSecret || signingSecret.length < 32 || !registrationSecret) {
  throw new Error("Missing gateway secrets");
}

const registry = new GatewayRegistry({
  ttlMs: 90_000,
  credentials: {
    ops: registrationSecret,
  },
  allowedOrigins: ["https://ops.internal.example.com"],
});

const gateway = createGateway({
  registry,
  auth: new AuthChain([
    oidcProvider({
      issuer: "https://identity.example.com",
      audience: "embody-gateway",
      algorithms: ["RS256"],
    }),
  ]),
  token: {
    issuer: "https://gateway.example.com",
    key: new TextEncoder().encode(signingSecret),
  },
  audit: new MemoryAuditLog(),
  limiter: new FixedWindowRateLimiter(120, 60_000),
  environment: "production",
});

gateway.get("/health", () => ({
  live: true,
  registeredApps: registry.snapshot().length,
}));

await gateway.listen({
  host: "0.0.0.0",
  port: Number(process.env.PORT ?? 4000),
});
```

`MemoryAuditLog` and the in-process registry are useful primitives and examples. A production design must export audit records to durable storage and define how expected applications re-register after restart. `GatewayRegistry.initial` can seed known registrations, but registration ownership and persistence remain operator concerns.

---

## Application host configuration

Each host needs a distinct registration credential:

```ini
NODE_ENV=production
GATEWAY_URL=https://gateway.example.com
PUBLIC_URL=https://ops.internal.example.com
GATEWAY_REGISTRATION_SECRET=app-specific-secret
GATEWAY_JWT_ISSUER=https://gateway.example.com
GATEWAY_JWT_SECRET=shared-downstream-signing-key
```

The gateway registry's credential key must match the host's `appId`. The host registers and then sends heartbeats. Its public URL means gateway-reachable; it does not need to be reachable from the public internet.

The current downstream token implementation uses HS256, so the gateway and registered hosts share the configured signing key. Protect and rotate it as a high-value secret.

---

## Client identity

Prefer an OIDC provider with asymmetric verification. Claims must map to an Embody principal containing:

```text
orgId
actorId
actorType
roles
scopes
```

An API-key provider is available for controlled integrations. `hashApiKey()` is a lookup hash, not a password-storage KDF; production credential stores should protect stored keys appropriately and support expiration and revocation.

Grant least-privilege scopes. An app-scoped MCP URL reduces catalog size but does not replace scope enforcement.

---

## Endpoint policy

Registration causes the gateway to make requests to host-provided endpoints, so registry policy is security-critical.

- Prefer explicit `allowedOrigins`.
- Keep private-address targets disabled unless the gateway intentionally runs inside the same trusted network.
- If private targets are required, set `allowPrivateEndpoints: true` only with network-layer egress controls and app-specific registration credentials.
- Require HTTPS except inside a separately protected service network.
- Do not accept arbitrary registration credentials from untrusted tenants without an ownership policy.

---

## TLS and reverse proxy

Terminate TLS at the gateway process or a trusted reverse proxy. Configure the proxy to:

- preserve streaming responses for `/api/execute/stream` and MCP
- enforce request-size and connection limits
- use appropriate idle timeouts for progress streams
- pass authorization headers without logging them
- emit trusted request metadata
- prevent direct access to administrative infrastructure

---

## Audit and observability

Persist or export at least:

- request ID
- application and target
- actor and organization
- outcome and duration
- authentication failures
- registration and heartbeat changes
- rate-limit decisions

Do not log bearer tokens, registration credentials, sensitive action inputs, or unredacted workflow values. Monitor unhealthy registrations, elevated authorization failures, downstream latency, and stream disconnects.

---

## Availability and restart behavior

The built-in registry is process-local. Healthy hosts will attempt registration again, but operators should plan for the interval before the catalog is rebuilt. For high availability, define one of these strategies:

1. deterministic registry seeding plus host re-registration
2. sticky/single-writer registration with replicated routing state outside the package
3. an operator-maintained durable registry adapter around the gateway contracts

Test the selected behavior during rolling restarts and outages. Do not claim high availability solely because multiple gateway processes are running.

---

## Rotation and incident response

Maintain procedures for:

- client token or API-key revocation
- per-app registration secret rotation
- downstream signing-key rotation coordinated with hosts
- OIDC key rotation
- removing a compromised app origin
- preserving and reviewing audit records
- temporarily disabling execution while retaining health visibility

---

## Deployment checklist

- [ ] TLS and trusted proxy configuration are tested.
- [ ] Every app has a separate registration secret.
- [ ] Allowed origins and private-network policy are explicit.
- [ ] Client identities map to tenant-aware, least-privilege principals.
- [ ] Signing and registration secrets come from a secret manager.
- [ ] Audit records are exported to durable storage.
- [ ] Rate limits match expected agent behavior.
- [ ] Registration recovery after restart is tested.
- [ ] Streaming proxy timeouts are tested.
- [ ] Health checks and alerts are configured.
- [ ] Backup, upgrade, rollback, and rotation procedures are documented.

Next: **[Operations Runbook →](./04-operations-runbook.md)**
