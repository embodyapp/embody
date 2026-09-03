# Phase 6 — Outbox, events, and real-time progress

**Specs:** 06 and cross-app example in 08. **Status:** P6-01 to P6-04. **Gate:** D-03.

## Objective

Guarantee atomic event persistence, at-least-once processing, direct cross-app delivery, and ordered progress delivery without external broker infrastructure. Keep transport-specific behavior behind the ADR 0004 infrastructure seam.

## P6-01: transactional publishing

- `ctx.events.publish(name,payload)` requires an active tenant transaction for entity hooks; custom actions get an execution transaction when they publish. Define behavior for actions needing long external work (recommended explicit short `ctx.transaction`, not holding DB transaction throughout).
- Envelope fields: protocol version, event ID, name, org ID, producer app/plugin, payload, occurred-at, correlation/causation IDs, attempt metadata, optional schema version.
- Validate event name and payload serializability/size before enqueue.
- Publishing does not invoke handlers inline.

## P6-02: worker

- Expose deterministic `tick()` plus scheduler default of 500 ms and batch default 50.
- Claim eligible rows atomically with worker ID/lease; process different events with bounded concurrency. For one event, invoke matching handlers in deterministic order and define all-handlers success semantics.
- On failure increment attempt count and store a redacted/truncated error. `maxAttempts` defaults to one (immediate durable dead letter); deployments may configure a larger value, with exponential delays beginning at 1 second. The recommended production profile uses five attempts.
- Recover expired processing leases after crashes. Use heartbeat/lease extension for long handlers or enforce handler timeout below lease.
- Shutdown stops claims, awaits active handlers to deadline, then leaves recoverable leases.

## P6-03: local and direct cross-app delivery

Implement ADR 0004 and its transport seam:

- Define a small host-level `EventTransport` interface and conformance suite. Exactly one outbound transport owns an event; domain plugins remain transport-neutral.
- Local matching handlers may process directly from the publisher app's outbox.
- The direct adapter resolves subscriptions through a configured directory, snapshots destinations, persists an independent delivery row for each, and sends a signed request to the receiver. Include a static directory adapter; gateway-backed discovery may be added with the registry.
- Receiver authenticates the producer, verifies envelope destination/org/replay/size limits, and uses inbox `(eventId,handlerId)` idempotency before handler execution.
- Temporarily unhealthy destinations remain pending. A completed destination is not rerun because another destination fails. No subscriber completes successfully with an audit record.
- Distinguish temporary from permanent errors. Permanent malformed events dead-letter; auth/config failure alerts and retries only per policy.
- Inspector/audit exposes metadata/status, not sensitive payload by default. Apply the 256 KiB envelope and minimum 30-day completed-delivery/inbox retention policy from ADR 0004.

Document the at-least-once seam: the framework suppresses repeated completed handler invocations, but a crash between an external side effect and inbox completion can repeat the effect; external handlers need idempotency keys.

## P6-04: progress and SSE

- Progress sink accepts ordered `{percent?,message}` updates; percent must be finite 0–100 and nondecreasing if present (choose reject or normalize explicitly).
- `/execute/stream` authenticates like `/execute`, starts SSE headers, emits `progress`, then exactly one `result` or structured `error`, plus keepalive comments.
- Escape/serialize newline-containing messages as JSON; detect backpressure and client disconnect; cancellation propagates to action.
- Keep transport-neutral progress so gateway/MCP can map it later.

## Tests and success criteria

### Atomicity/payload tests

- Entity mutation and event are both visible after commit and both absent after failure.
- Event IDs, org/correlation metadata, and timestamps are stable with injected sources.
- Circular, too-large, unsupported, or wrong-schema payloads fail before mutation commits.

### Worker tests

- `tick()` claims at most 50 eligible rows in order and bounded concurrency never exceeds config.
- Two PostgreSQL workers process 1,000 rows without simultaneous duplicate claims; injected post-handler/pre-complete crash causes allowed redelivery.
- Failures schedule exact fake-clock backoffs, retain truncated safe errors, dead-letter after the configured attempt limit, and prove both the one-attempt default and five-attempt production profile.
- Expired leases recover; unexpired leases do not. Shutdown/restart eventually processes all non-dead-letter rows.
- No arbitrary sleep is used in these tests.

### Event relay/idempotency tests

- No subscriber is handled per ADR and does not retry forever.
- Two local handlers run deterministic order; one failure prevents event completion and retry behavior is documented/tested.
- Publisher restart after destination fan-out does not lose delivery; rerouting the event does not create duplicate destination records.
- One offline destination recovers and completes without rerunning handlers at an already-completed destination.
- Delivering the same envelope twice executes each already-completed app handler once.
- Wrong relay signature/audience/org and malformed envelope invoke no handler.
- Simulated external-side-effect crash demonstrates duplicate possibility and reference handler proves idempotency-key mitigation.

### SSE tests

- Wire snapshot has correct headers and ordered `progress, progress, result`; failure has `progress, error` and no result.
- Concurrent streams never cross messages. Slow/disconnected client is bounded and cancels work.
- Invalid progress is handled by documented policy; Unicode/newlines remain valid SSE JSON.
- Keepalive uses fake clock and resources close after terminal event.

Phase 6 passes when crash/retry/concurrency tests prove at-least-once semantics on PostgreSQL, SQLite single-process behavior is green, and one authenticated direct cross-app event survives publisher/receiver restart.