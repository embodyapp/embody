# Phase 6 — Outbox, events, and real-time progress

**Specs:** 06 and cross-app example in 08. **Status:** P6-01 to P6-04. **Gate:** D-03.

## Objective

Guarantee atomic event persistence, at-least-once processing, cross-app relay, and ordered progress delivery without external broker infrastructure.

## P6-01: transactional publishing

- `ctx.events.publish(name,payload)` requires an active tenant transaction for entity hooks; custom actions get an execution transaction when they publish. Define behavior for actions needing long external work (recommended explicit short `ctx.transaction`, not holding DB transaction throughout).
- Envelope fields: protocol version, event ID, name, org ID, producer app/plugin, payload, occurred-at, correlation/causation IDs, attempt metadata, optional schema version.
- Validate event name and payload serializability/size before enqueue.
- Publishing does not invoke handlers inline.

## P6-02: worker

- Expose deterministic `tick()` plus scheduler default of 500 ms and batch default 50.
- Claim eligible rows atomically with worker ID/lease; process different events with bounded concurrency. For one event, invoke matching handlers in deterministic order and define all-handlers success semantics.
- On failure increment retry count, store a redacted/truncated error, schedule exponential delays `2^retry * 1s` (clarify whether first is 1s or 2s), and dead-letter at five attempts.
- Recover expired processing leases after crashes. Use heartbeat/lease extension for long handlers or enforce handler timeout below lease.
- Shutdown stops claims, awaits active handlers to deadline, then leaves recoverable leases.

## P6-03: local and cross-app delivery

Implement approved D-03 relay:

- Local matching handlers may process directly from publisher app's outbox.
- For remote subscriptions, worker sends signed service request to gateway; gateway durably fans out and acknowledges only after persistence.
- Receiver authenticates relay, verifies envelope org/audience/replay limits, and uses inbox `(eventId,handlerId)` idempotency before handler execution.
- Distinguish temporary from permanent errors. Permanent malformed events dead-letter; auth/config failure alerts and retries only per policy.
- Inspector/audit exposes metadata/status, not sensitive payload by default.

Document at-least-once boundary: framework suppresses repeated completed handler invocations, but a crash between external side effect and inbox completion can repeat the effect; external handlers need idempotency keys.

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
- Failures schedule exact fake-clock backoffs, retain truncated safe errors, and dead-letter on the fifth configured failure.
- Expired leases recover; unexpired leases do not. Shutdown/restart eventually processes all non-dead-letter rows.
- No arbitrary sleep is used in these tests.

### Event relay/idempotency tests

- No subscriber is handled per ADR and does not retry forever.
- Two local handlers run deterministic order; one failure prevents event completion and retry behavior is documented/tested.
- Gateway restart after durable fan-out does not lose delivery; publisher retry does not create duplicate delivery records.
- Delivering the same envelope twice executes each already-completed app handler once.
- Wrong relay signature/audience/org and malformed envelope invoke no handler.
- Simulated external-side-effect crash demonstrates duplicate possibility and reference handler proves idempotency-key mitigation.

### SSE tests

- Wire snapshot has correct headers and ordered `progress, progress, result`; failure has `progress, error` and no result.
- Concurrent streams never cross messages. Slow/disconnected client is bounded and cancels work.
- Invalid progress is handled by documented policy; Unicode/newlines remain valid SSE JSON.
- Keepalive uses fake clock and resources close after terminal event.

Phase 6 passes when crash/retry/concurrency tests prove at-least-once semantics on PostgreSQL, SQLite single-process behavior is green, and one authenticated cross-app event survives gateway/app restart.