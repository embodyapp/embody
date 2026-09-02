# ADR 0004: Direct cross-app event delivery with optional gateway relay

- Status: Accepted
- Date: 2026-09-02

## Decision

Cross-app events use a pluggable infrastructure transport. Direct app-to-app delivery is the MVP baseline. A durable gateway relay is an optional additional adapter and implementation step; it is not on the MVP release critical path.

Domain plugins only publish through `ctx.events.publish(name, payload)` and receive events through declared handlers. They do not depend on the selected transport. The host accepts exactly one outbound `EventTransport`; implementations hide discovery, authentication, fan-out, persistence ownership, and retry classification behind a small delivery interface.

### Shared delivery semantics

- Publishing persists a versioned event envelope in the same transaction as the domain mutation.
- Delivery is at least once. Receivers authenticate envelopes and deduplicate `(eventId, handlerId)` in a durable inbox.
- External handler effects must use event-derived idempotency keys because a crash after an external effect but before inbox completion can repeat the effect.
- A destination has independent status and retries; one failing destination does not rerun or block a completed destination.
- The destination set is resolved and durably snapshotted when routing starts. Temporarily unhealthy destinations remain pending. Later subscription changes affect new events, not an event already being delivered.
- No matching subscriber is successful and produces an audit record.
- Envelopes are limited to 256 KiB. Completed delivery and inbox records are retained for at least 30 days; dead letters require explicit resolution or administrative deletion. Payloads are hidden from audit and inspection by default.

### Direct transport

The publisher resolves matching subscriptions through a configured directory adapter, persists one local delivery row per destination, and calls each receiver's authenticated `/events/deliver` endpoint. Static configuration supports small deployments; gateway-backed discovery may be added when the registry exists. The publisher owns retries and dead letters until every destination reaches a terminal state.

The receiver verifies the producer identity, destination audience, organization, signature, expiry, protocol version, and payload limits. Direct deployments must explicitly configure trusted app credentials and allowed destination origins; discovered URLs are subject to SSRF/network policy.

### Optional gateway relay transport

The publisher sends each event once to authenticated gateway ingress. The gateway durably snapshots matching subscriptions and persists independent destination deliveries before acknowledging acceptance. It then delivers to receivers using destination-scoped credentials and owns retries, dead letters, and centralized operational views.

The relay adapter preserves the same envelope, receiver endpoint, inbox semantics, and event-handler interface as direct delivery. Switching transports must not require domain plugin changes.

## Consequences

Small deployments do not need a durable gateway data plane, and direct delivery avoids an extra network hop. Publishers do, however, require destination reachability, trusted discovery, delivery storage, and operational handling of their own dead letters.

The optional relay adds centralized auditing, retry operations, network isolation, and continued delivery after a publisher stops, at the cost of another durable worker and database responsibility in the gateway.

Phase 6 implements and verifies direct delivery. The gateway relay is tracked as optional P7-04 after normal gateway dispatch. Release claims must state which transport adapters are included and configured; both adapters must satisfy the shared transport conformance suite when the relay is implemented.
