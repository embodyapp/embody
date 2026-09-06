# Operations runbook

## Signals and readiness

`GET /health` distinguishes liveness from readiness. During shutdown readiness drops before Fastify stops admission; in-flight requests and workers drain to their deadline. Run one process per container and forward `SIGTERM`; call `AppHostRuntime.stop()` before exit. A killed worker leaves leases recoverable and committed outbox/workflow rows are not lost.

Alert on request error/latency, auth denials, registry unhealthy count, database pool saturation, outbox and workflow runnable depth/oldest age/retries/dead letters, worker duration, event delivery failures, and SSE connection/memory count. Metric labels may include app, action target, outcome, and bounded error code, but never org, actor, request, event, or workflow IDs. Logs may carry correlation IDs as fields but no token, raw payload, workflow input/output, or authorization header.

Propagate W3C `traceparent` gateway → app → event metadata. Sample successful traces; retain failures at a higher rate. Exporters must apply the same payload redaction rules as logs.

## Unhealthy app

1. Confirm gateway registry status and app `/health`.
2. Check database reachability, pool exhaustion, JWT audience/clock, and registration secret.
3. Remove the instance from admission before restart. Leased work recovers after lease expiry.
4. Do not manually mark work complete. Record incident times and correlation IDs.

## Queue backlog and dead letters

Pause producers if oldest age or disk growth breaches the environment budget. Scale workers only after checking database capacity and downstream limits. Inspect safe error codes, fix the cause, and replay into a new pending row with the same domain idempotency key. Never mutate a completed row or replay external side effects without verifying idempotency.

## Database outage

Admission may remain live but operations requiring storage fail. Drop readiness if outage exceeds the platform threshold. Restore connectivity; pooled clients recover on subsequent acquisition. If recovery does not occur, restart after leases expire. Compare committed row counts and queue oldest age—do not infer loss from client timeout.

## Backup and restore

Take encrypted PostgreSQL physical backups plus WAL (or managed PITR). Quarterly, restore to an isolated environment, use non-owner runtime credentials, run migrations, and verify entities, pending outbox rows, inbox dedupe, event destinations, workflow instances/steps, registry, and audit rows. Start workers only after endpoint/secrets are isolated, then verify safe resume. SQLite backup uses the SQLite online backup API while writers are quiesced.

## Schema upgrade and rollback

Back up first. Deploy additive migrations before code requiring them, retain every workflow definition version referenced by nonterminal instances, and run upgrade fixtures. Application rollback is allowed only while its code understands the current schema. Infrastructure migrations are forward-only; restore the pre-upgrade backup for destructive rollback.

## Clock and capacity

Use NTP and alert above 2 seconds skew. Schedules and leases use UTC database-compatible timestamps. Apply database/queue disk alerts at 70/85/95%, bound ingress at the proxy, and disconnect slow SSE consumers rather than buffering without limit.
