# Phase 0 — Architecture and decisions

## Objective

Turn specification gaps into explicit, reviewable decisions before package APIs harden. This phase writes decisions and executable protocol fixtures; it does not build product behavior.

## Proposed baseline (D-01/D-04)

- TypeScript strict-mode monorepo using pnpm workspaces and Turborepo (or plain pnpm recursive scripts if avoiding another tool).
- Node.js 22 LTS, ESM, package `exports`, and declaration files.
- Zod for runtime contracts; a maintained Zod-to-JSON-Schema converter for manifests/MCP.
- Fastify for remote host and gateway HTTP servers; official MCP TypeScript SDK for protocol transport.
- A small internal storage port with explicit PostgreSQL (`pg`) and SQLite (`better-sqlite3`) adapters. Keep SQL in adapters; do not leak a query builder through `KernelContext`.
- `jose` for JWT/JWK operations; Commander (or equivalent) for static top-level CLI parsing, with dynamic commands generated from manifests.
- Vitest, Testcontainers, ESLint, and Prettier.

Record accepted choices as ADRs under `docs/adr/`; update this plan if choices change.

## Protocol/versioning decisions

All wire objects receive a `protocolVersion` (start at `1`) and are parsed with Zod at both sides. Standard error envelope:

```json
{"error":{"code":"VALIDATION_ERROR","message":"Input is invalid","details":[],"requestId":"..."}}
```

Never expose stack traces, SQL, tokens, or remote internal URLs to callers. Propagate `requestId` and W3C `traceparent` where available.

Manifest names are canonical dotted targets (`plugin.entity.operation`, `plugin.action`); transport adapters alone map these to MCP snake-case names or CLI hierarchy. Reject collisions during boot.

## Required decisions/gaps

### D-02: durable workflows

The SPI mentions durable multi-step workflows but defines no state model, persistence schema, retries, compensation, cancellation, or API. Recommendation: preserve a typed `workflows` field as reserved metadata, fail boot with a clear `UNSUPPORTED_WORKFLOW` if used in MVP, and specify/implement it as P12. Do not invent silent non-durable behavior.

### D-03: cross-app events

A database outbox in the publishing app cannot directly invoke subscribers in another app. Recommended MVP protocol:

1. App manifests advertise `eventSubscriptions` from plugin `events` keys.
2. Publishing app's outbox worker POSTs an event envelope to an authenticated gateway relay endpoint.
3. Gateway persists one delivery per matching healthy app in its own outbox/delivery table before acknowledging.
4. Gateway POSTs to each app's authenticated `/events/deliver`; app records `eventId + handlerId` in an inbox table transactionally before/with side effects where possible.
5. Success is acknowledged only after all local matching handlers complete; retries are at-least-once. Handlers remain responsible for idempotent external effects.

Define no-subscriber behavior (recommended: successful delivery with audit record), retention, payload limits, and event authorization before implementation.

### Other clarifications to approve

- `afterCreate/afterUpdate/afterDelete` hooks run inside the entity transaction after mutation but before commit so `ctx.events.publish` is atomic. They must not perform irreversible external I/O; async side effects belong in event handlers. `before*` hooks run before mutation in that same transaction.
- Actions and hooks execute serially in deterministic plugin/topological registration order unless explicitly documented otherwise.
- SQLite provides application-enforced tenant isolation; PostgreSQL adds RLS as defense in depth.
- Built-in custom indexes are deferred unless an adapter can add them safely and idempotently; the broad Postgres GIN and tenant/type indexes satisfy MVP.
- Registry endpoint URLs are deployment configuration and must pass an allowlist/private-network policy to prevent SSRF.
- Registration secret authenticates an app identity; production should support per-app hashed secrets and rotation, not one global plaintext secret.

## Deliverables

- ADRs for stack, cross-app relay, hooks/transactions, auth/token algorithms, and workflow deferral.
- Versioned Zod schemas plus JSON fixtures for manifest, registration, heartbeat, execution, principal JWT claims, event envelope, progress SSE, and error envelope.
- Threat model covering trust boundaries, SSRF, confused deputy, replay, token/key rotation, tenant escape, malicious schemas/payload sizes, and sensitive audit fields.
- Compatibility policy for protocol and package semver.

## Tests and success criteria

1. **Fixture parse tests**: each accepted fixture parses with its contract and each fixture with a missing version, unknown incompatible version, oversized field, or malformed URL fails with a stable error.
2. **Round-trip tests**: encoded/decoded manifest, principal, event, and execute objects retain all contract fields.
3. **Naming tests**: dotted targets map deterministically to global/scoped MCP and CLI names; collision fixtures are rejected.
4. **Threat-model review tests/checklist**: every external endpoint has documented authentication, authorization, input limit, replay behavior, and redaction rule.
5. **Decision completion**: D-01 through D-04 are marked `DONE`; workflow may instead be explicitly approved as post-MVP, which unblocks all except P12.

Phase 0 passes when another agent can implement contracts without making a new security- or compatibility-sensitive decision.