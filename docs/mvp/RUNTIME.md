# Hosted request-only runtime (M08)

> **Scope change 2026-10-14:** events, subscriptions and durable workflows are now part
> of the hosted MVP. They will run in a separate hosted *durable* profile (M20, with
> M19 and M21) that is woken by queue tasks instead of workers. This request-only
> profile stays supported unchanged. Where this page says such apps "must use reference
> mode", read that as "until the durable profile lands". See
> [README](./README.md) and [IMPLEMENTATION](./IMPLEMENTATION.md#m20--queue-woken-durable-runtime).

`EMBODY_HOST_PROFILE=hosted` selects the request-only host; the default `reference`
profile retains the existing self-hosted registration, heartbeat, event and workflow
workers. Hosted runtime requires Node 22.x or 24.x, production, PostgreSQL runtime
credentials, workspace identity, issuer and HTTPS public ES256 JWKS configuration.
It rejects verifier/storage overrides, SQLite/local persistence settings, reference
registration settings and legacy event ingress. Database pools are capped at five
connections per instance; deployment admission must separately enforce the three
instance limit (M09/M13). Idle database connections expire after one second.

## Startup and preflight

Call `assertRequestOnlyPlugins` from `@embody/core` during build/preflight. The same
check runs before hosted adapter construction and during request-only kernel boot.
Declared workflows, event handlers/subscriptions, schedules, background handlers
and always-on capability declarations fail with actionable errors. `init` and
service factory callbacks also fail: move work into authenticated actions rather
than relying on repeated cold-start side effects. Background kernel components
are forbidden. Static entity/action/hook definitions are supported.

Boot reads the migration version ledger and verifies exact compatibility; it does
not create tables or migrate. Pre-migrate using a separate maintenance identity.
Runtime roles must have only schema usage, migration-ledger SELECT, tenant-bound
DML privileges and EXECUTE on the storage functions listed in `STORAGE_RUNTIME_FUNCTIONS`
(the [M19 workflow claim/version functions](./WORKFLOWS.md#runtime-role-claims)); no DDL,
ownership, superuser or RLS bypass. See the M03 role fixture
and M05 identity contract. Missing/outdated schemas fail closed and close the pool.
No registration, heartbeat, workflow, outbox or delivery workers start. Manual
worker tick/drain methods fail rather than reintroducing delivery. Both JSON
`/execute` and request-owned `/execute/stream` progress/result SSE are supported
(the gateway uses SSE for MCP actions). Hosted streams have no keepalive intervals
and share the same concurrency/deadline/cancellation budget as JSON actions.

## Outbox decision: zero retained generated notifications

Request-only generated CRUD **does not enqueue framework change notifications**.
Retention for these non-deliverable notifications is exactly zero, independent of
traffic volume. No polling or maintenance cleanup is needed for newly generated
notifications. Validation, tenant-bound entity mutations, synchronous before/after
hooks and rollback/commit all remain in the original transaction. A hook failure
rolls back the write. Success is returned only after transaction commit. There is
no event delivery, durable notification history, or replay guarantee in this mode.

Custom `ctx.events.publish` fails the action and rolls back its transaction. Apps
requiring reliable external effects, subscriptions or workflows must use reference
mode; do not interpret a successful CRUD response as a delivery acknowledgement.
This is an explicit profile policy, not a global change to transactional outbox
semantics. Reference mode continues to persist and deliver events normally.

Existing outbox records are **not** silently deleted or drained at hosted boot.
Before switching a database from reference mode, stop producers, drain/reconcile
pending deliveries and workflows with the reference workers, and archive/delete
completed records through maintenance credentials according to the old app's data
policy. Prefer a fresh database for hosted admission. Historical retained records
are not made bounded by switching profiles; migration/admission must verify that
legacy workload is settled. No unsupported delivery promises carry across modes.

## Deadlines, cancellation and persistence

The HTTP host gives authentication at most 30 seconds and action execution at most
30 seconds, each constrained by the remaining 60-second host request budget. Body
reception uses Fastify's request timeout. PostgreSQL statements are bounded at
30 seconds; idle open transactions are terminated after 30 seconds. Gateway/provider cold-start time is not re-budgeted here: the gateway's
end-to-end deadline and provider qualification remain required.

Disconnecting after receipt of a complete request body aborts `ctx.signal`, as do
execution deadlines. The kernel checks cancellation before invoking customer code
and after its handler returns, before allowing the transaction to commit. Customer
code must observe the signal and settle promptly. Deadline responses are bounded,
but a non-cooperative handler keeps its concurrency slot until it actually settles;
a timeout is not a claim that arbitrary JavaScript or an external effect was killed.
PostgreSQL statements already running need to settle/timeout. Use idempotency for
external writes. Instance destruction rolls back open PostgreSQL transactions.

Durable request state belongs in PostgreSQL. Use `/tmp` only for disposable scratch;
never infer durability from the container filesystem or module globals. This
profile does not sandbox arbitrary imports, timers, filesystem access or network
calls. Isolation/build admission belongs to M11 and provider controls to M09/M13.

## Scaffold and migration

```sh
pnpm dlx create-embody-app my-app --request-only
```

The generated app includes a ping action, CRUD card entity, hosted environment
example and a startup guard against reference/SQLite fallback. Supply environment
variables through the deployment (the example file is not automatically loaded),
pre-migrate separately, then build and start. `pnpm dev` is a local development
convenience, not a certified production verifier. Never give runtime processes
maintenance credentials or gateway private keys.

To migrate an always-on app: remove unsupported declarations/startup callbacks,
move business work into authenticated bounded actions, replace local persistence
with PostgreSQL, settle legacy outbox/workflow data, arrange separate migrations,
and test cancellation/idempotency. If reliable background delivery is required,
do not migrate that workload to request-only mode.

## Verification

`pnpm test:m08` requires Node 22/24 and the disposable M03 PostgreSQL fixture
variables, including `EMBODY_POSTGRES_TEST_CONTAINER`. It fails without real DB
configuration, builds packages, pre-migrates with maintenance credentials, runs
mandatory core/host/scaffold and M08 PostgreSQL suites with zero skipped tests, and
runs the packed external-consumer request-only scaffold through typecheck, test,
build and hosted startup. It emits sanitized evidence in `.artifacts/verification`.
This is local runtime evidence, not cloud zero-instance/provider qualification.
