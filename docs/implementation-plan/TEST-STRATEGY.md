# Cross-cutting test strategy

## Test layers

1. **Unit**: pure graph sorting, scope matching, schema conversion, naming, backoff, error mapping. No network or database.
2. **Adapter conformance**: one shared black-box suite against SQLite and PostgreSQL storage implementations.
3. **Package integration**: real kernel plus real temporary SQLite; real Fastify injection for HTTP; fake clock only at owned timing boundaries.
4. **Protocol contract**: fixed request/response fixtures for registration, execute, SSE, JWT claims, JSON-RPC, manifests, and errors. Validate both producer and consumer.
5. **Browser/renderer contract**: execute built GenUI assets in a real browser against the official MCP Apps reference/basic host and the standalone host. Assert semantic DOM, accessibility, keyboard behavior, CSP, bridge messages, cleanup, and inert hostile content; screenshots supplement rather than replace behavior assertions.
6. **Distributed end-to-end**: gateway, Kanban, Email, and PostgreSQL containers on ephemeral ports. Invoke via HTTP, MCP, CLI, and—when Phase 14 is in scope—the MCP Apps reference host and standalone browser.
7. **Harness adapter conformance**: replay the same normalized GenUI fixture/event corpus against web, text, and Pi renderers. Host-specific rendering may differ, but semantic content, enabled actions, validation, principal, and final domain outcome must agree.
8. **Non-functional**: focused security, concurrency, shutdown, fuzz, soak, accessibility, and performance tests in phases 11, 12, and 14.

## Required infrastructure

- Vitest for TypeScript tests and coverage.
- Testcontainers for supported PostgreSQL integration tests. CI must run these on every main-branch/PR build.
- Temporary-file SQLite by default; in-memory SQLite only where connection sharing is controlled.
- Injectable clock, UUID source, HTTP transport, and worker scheduler to make failures deterministic.
- WireMock-style local HTTP test servers or Fastify injection; no calls to external OIDC/Clerk/email services.
- A pinned real-browser runner for GenUI DOM/accessibility/CSP tests. CI serves packed renderer assets locally and makes no vendor-host network calls.
- The official MCP client and a pinned MCP Apps reference/basic host for protocol conformance. Vendor products are manual dated smoke evidence, never a substitute for deterministic CI.
- Pi adapter tests use its documented extension/TUI APIs and built package installation path; tests must not patch Pi internals.

## Stable test conventions

- Name black-box tests as behavior: `rejects update from another org`, not implementation detail.
- Each test creates a unique org and cleans up resources.
- Assert structured error `code`, status, and safe message; do not only match text.
- For at-least-once delivery, handlers must be idempotent in E2E tests and duplicate delivery must be deliberately simulated.
- Timing tests control the clock. Worker tests call `tick()` directly; only one smoke test exercises the actual interval loop.
- Snapshot only stable JSON Schema/manifests/help text and deterministic GenUI text/semantic DOM; normalize timestamps, UUIDs, ports, generated integrity values, and property order.
- Renderer tests assert semantics and interaction before screenshots. Every interactive fixture has a no-HTML fallback assertion and every hostile-content regression runs against web and text renderers.
- Cross-renderer fixtures identify nodes/actions by stable semantic IDs, not CSS selectors, screen coordinates, ANSI bytes, or vendor-specific wrapper markup.

## Coverage expectations

Coverage is a warning signal, not the definition of quality. Nonetheless, changed packages should maintain at least 90% branch coverage for pure core/security code and 80% branch coverage elsewhere. Generated files, CLI entry shims, and type-only modules may be excluded with a documented reason.

## CI matrix

- Node version(s) fixed by D-04 on Linux.
- SQLite package tests.
- PostgreSQL package tests against the minimum supported major version.
- Build/type/lint for every package.
- E2E on Linux using built package artifacts, not TypeScript source aliases.
- Scaffolder smoke test installs and tests the generated project from packed local tarballs.
- When GenUI changes, CI builds renderer assets once, tests their integrity digest, and runs browser and Pi adapter tests from packed artifacts rather than workspace source aliases.

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
- GenUI capability negotiation preserving plain MCP behavior for clients without Apps support.
- GenUI resource/session authorization, same-principal allowlisted UI actions, and cross-tenant result isolation.
- GenUI hostile-content inertness, CSP defaults, deterministic fallback, keyboard accessibility, bounded renderer/session cleanup, and packed-asset integrity.