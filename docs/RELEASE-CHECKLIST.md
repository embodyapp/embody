# Release readiness evidence

A checked box requires a CI URL or stored artifact; local success alone is insufficient.

## Security

- [ ] Threat model reviewed by security owner (`production/03-security.md`).
- [ ] `pnpm security:audit` has no exploitable high/critical finding or linked mitigation.
- [ ] CycloneDX npm SBOM and image SBOM attached; image digest signed and pinned.
- [ ] Fuzz corpus passes target/schema/protocol/JWT/SSE/SQL cases under fixed CI budget.
- [ ] Tenant/RLS, SSRF, XSS, injection, parser-limit, redaction, and insecure-production suites pass.
- [ ] Runtime PostgreSQL role is non-owner, `NOBYPASSRLS`, least privilege.

## Resilience and operations

- [ ] Kill/restart matrix passes registration, transaction/outbox, worker lease, fan-out, side-effect, SSE, and workflow crash points.
- [ ] Database/pool/gateway outage and malformed/slow peer recovery matches the runbook.
- [ ] 30-minute soak has bounded resources and returns within approved baseline variance.
- [ ] Log/metric/trace golden tests include correlation/outcome and no sensitive payload/high-cardinality labels.
- [ ] Encrypted backup/restore drill resumes entity, queue, inbox, registry/audit, delivery, and workflow data.
- [ ] Key rotation and queue/dead-letter/schema runbooks rehearsed.

## Performance

- [ ] Representative fixture and declared hardware results attached (`production/06-performance-baseline.md`).
- [ ] Budgets approved and regressions within budget or exception linked.

## Artifacts and documentation

- [ ] Node 22/24, PostgreSQL 16+, and qualified SQLite matrix passes from clean cache.
- [ ] `pnpm release:artifacts` and an external-consumer/scaffolder test pass from tarballs.
- [ ] Exports, declarations, source maps, readmes, changelogs, provenance, tarball contents checked.
- [ ] Non-root healthchecked images pass vulnerability/config scan and graceful-signal test.
- [ ] Quickstart run verbatim in clean environment reaches CLI and MCP action.
- [ ] API report, protocol fixtures, and previous-schema upgrade diff reviewed.
- [ ] Phase 13 counsel-approved licensing and distribution gates complete before publication.
