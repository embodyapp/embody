# Phase 12 — Hardening and release

**Specs:** non-functional implications across 01–08. **Status:** P12-01, P12-02.

## Objective

Validate security, operability, compatibility, and packaging before declaring an MVP release. Set measurable budgets from baseline results instead of making unverified claims.

## P12-01: security and resilience

### Security

- Complete threat-model review and dependency/license audit; generate SBOM for images/packages.
- Fuzz/property-test target names, JSON/protocol parsers, scope matching, JSON Schema conversion, SQL filter/sort compiler, JWT claims, and SSE framing.
- Test SSRF/DNS policy, HTTP request smuggling protections supplied by stack, CORS defaults, CSP, body/header/decompression limits, audit-log injection, prototype pollution, and secret redaction.
- Document key/API-key/registration-secret rotation and compromise procedure. Production rejects default secrets, HTTP remote endpoints unless explicitly trusted, and development verifier/inspector.
- Verify PostgreSQL deployment uses runtime role subject to RLS and least privileges.

### Resilience/operations

- Graceful rolling restart for gateway/apps/workers; readiness drops before admission stops and no durable event is lost.
- Database outage/recovery, exhausted pool, gateway outage during registration/relay, malformed remote responses, slowloris/slow consumer, clock skew, and disk/queue growth behavior.
- Structured logs and metrics: request rate/duration/outcome, registry health, action target, auth denials, outbox depth/oldest age/retries/dead letters, worker duration, SSE connections. Avoid high-cardinality actor/event IDs in metric labels.
- OpenTelemetry traces propagate across gateway/app/event relay; sampling and payload redaction documented.
- Admin runbooks for unhealthy app, dead letter replay, key rotation, schema upgrade/rollback, and queue backlog.

### Performance baselines

Measure on declared hardware/configuration:

- kernel/harness warm boot median/p95;
- registry catalog with representative number of apps/tools;
- CRUD and gateway dispatch latency/throughput;
- outbox drain throughput and retry overhead;
- MCP tool-list payload/latency;
- memory under concurrent SSE streams.

Set release budgets after baseline review. Include a representative scale fixture (for example 100 apps × 50 tools, 10k tenant entities, 100k queued events) without claiming enterprise scale from a tiny test.

## P12-02: packaging and release

- Verify package exports, types, source maps, license/readme/changelog, provenance, and no test/source secrets in tarballs.
- Define semver policy for TypeScript APIs, plugin SPI, manifests/wire protocol, storage schema, and CLI output. Add deprecation/migration process.
- Test supported Node, PostgreSQL, and SQLite versions from D-04; publish compatibility table.
- Produce signed/pinned gateway and example container images running as non-root with healthchecks and graceful signals.
- Write installation, quickstart, production deployment, auth provider, database/RLS, gateway networking, observability, backup/restore, and upgrade docs.
- Pack all packages and run external-consumer/scaffolder/E2E tests using tarballs exactly as users receive them.

## Tests and success criteria

### Security gates

- Automated security regression suite proves tenant/RLS, scope, app-token audience, SSRF, XSS, injection, parser limits, and redaction controls.
- Fuzz runs complete a fixed CI corpus/time budget with no crash/hang/unbounded allocation; discovered seeds become permanent tests.
- High/critical exploitable dependency findings are zero or have approved documented mitigation.
- Production configuration negative suite rejects every default/dev credential and insecure endpoint setting.

### Resilience gates

- Kill/restart tests during registration, entity+outbox commit, worker claim, gateway fan-out, remote handling, and SSE streaming produce documented outcomes and no lost committed event.
- A 30-minute soak (nightly if too slow for PR) has bounded memory/connection/timer growth and all resources return near baseline after load.
- Database/gateway recovery requires no process restart where designed; otherwise readiness/runbook accurately indicates required action.
- Metrics/log/trace golden tests include correlation and outcomes while excluding secrets and raw sensitive payloads.
- Backup/restore drill restores entities, pending events, inbox dedupe, registry/audit data and resumes safely.

### Release gates

- Full CI matrix passes from packed artifacts and clean caches.
- Public API report and protocol fixtures have reviewed diffs; storage upgrade test covers previous released schema.
- npm tarball/container inspection contains only intended files, runs as non-root, and passes vulnerability/config checks.
- Quickstart executed verbatim in a clean environment reaches successful CLI and MCP action.
- Performance results meet approved budgets with no material regression from stored baseline; exceptions require explicit review.
- Documentation maps every advertised feature to implemented/tested status and calls out deferred workflows/provider limitations.

Phase 12 passes only when release checklist evidence is linked in `STATUS.md`; “tests pass locally” alone is insufficient. If workflows were deferred by D-02, release documentation and capability manifests must not advertise them.