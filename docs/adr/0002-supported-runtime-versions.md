# ADR 0002: Supported runtime versions

- Status: Accepted
- Date: 2026-09-01

## Decision

- Support active Node.js LTS lines 22 and 24; CI tests both for package quality checks.
- Use PostgreSQL 16 as the minimum production database version. Later majors are supported only after their CI job passes.
- Use SQLite 3.45 with JSON1 as the minimum development/test database capability. Phase 2 must verify the actual SQLite version exposed by the selected driver and fail startup clearly when JSON1 is unavailable.

## Consequences

Package engine ranges are `^22 || ^24`. PostgreSQL-specific tests run against version 16 at minimum. SQLite behavior cannot rely on features introduced after 3.45 without a compatibility decision.