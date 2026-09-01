# Cross-cutting test strategy

## Test layers

1. **Unit**: pure graph sorting, scope matching, schema conversion, naming, backoff, error mapping. No network or database.
2. **Adapter conformance**: one shared black-box suite against SQLite and PostgreSQL storage implementations.
3. **Package integration**: real kernel plus real temporary SQLite; real Fastify injection for HTTP; fake clock only at owned timing boundaries.
4. **Protocol contract**: fixed request/response fixtures for registration, execute, SSE, JWT claims, JSON-RPC, manifests, and errors. Validate both producer and consumer.
5. **Distributed end-to-end**: gateway, Kanban, Email, and PostgreSQL containers on ephemeral ports. Invoke via HTTP, MCP, and CLI.
6. **Non-functional**: focused security, concurrency, shutdown, and performance tests in phase 11.

## Required infrastructure

- Vitest for TypeScript tests and coverage.
- Testcontainers for supported PostgreSQL integration tests. CI must run these on every main-branch/PR build.
- Temporary-file SQLite by default; in-memory SQLite only where connection sharing is controlled.
- Injectable clock, UUID source, HTTP transport, and worker scheduler to make failures deterministic.
- WireMock-style local HTTP test servers or Fastify injection; no calls to external OIDC/Clerk/email services.

## Stable test conventions

- Name black-box tests as behavior: `rejects update from another org`, not implementation detail.
- Each test creates a unique org and cleans up resources.
- Assert structured error `code`, status, and safe message; do not only match text.
- For at-least-once delivery, handlers must be idempotent in E2E tests and duplicate delivery must be deliberately simulated.
- Timing tests control the clock. Worker tests call `tick()` directly; only one smoke test exercises the actual interval loop.
- Snapshot only stable JSON Schema/manifests/help text; normalize timestamps, UUIDs, ports, and property order.

## Coverage expectations

Coverage is a warning signal, not the definition of quality. Nonetheless, changed packages should maintain at least 90% branch coverage for pure core/security code and 80% branch coverage elsewhere. Generated files, CLI entry shims, and type-only modules may be excluded with a documented reason.

## CI matrix

- Node version(s) fixed by D-04 on Linux.
- SQLite package tests.
- PostgreSQL package tests against the minimum supported major version.
- Build/type/lint for every package.
- E2E on Linux using built package artifacts, not TypeScript source aliases.
- Scaffolder smoke test installs and tests the generated project from packed local tarballs.

## Release-blocking scenarios

A release fails if any of these regress:

- Cross-tenant get/list/update/delete access.
- Auth fail-closed behavior or scope wildcard matching.
- Hook veto rollback and atomic entity/outbox commit.
- Duplicate plugin/action/service registration detection.
- Concurrent workers processing one claim simultaneously.
- Gateway removing unhealthy tools and refusing dispatch.
- MCP global/scoped naming correctness and schema validity.
- CLI non-zero exit behavior and secret redaction.
- Graceful shutdown accepting no new work while preserving claimed events.