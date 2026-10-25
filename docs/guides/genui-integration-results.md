# GenUI integration results — 2026-10-25

Integration branch: `codex/genui-integration`.

GitHub refs were fetched before implementation. The integration starts at `origin/main` (`c319e23`) and merges the remote `docs/genui-incremental-plan` (`ef419be`). The local-only `ba249fc` theme/Pi UX work was preserved on its original branch and is not included here.

## Changes

- Resolved ten conflicted files while retaining main's shared dispatch, public error details, audit, human-to-agent MCP delegation, app metadata, workspace routing and database verification commands.
- Added GenUI's web/text renderers, MCP Apps resource delivery, browser handoff, Pi adapter and Kanban reference journey from the feature branch.
- Put presentation generation/target checks inside the audited dispatch preflight. Rejected UI requests are audited before any host action runs.
- Kept credential-based MCP session identity, including actor type in the legacy identity key. Close hijacked MCP responses before Fastify waits for active connections.
- Kept hosted promotion counters separate from the app's immutable resource manifest hash. Regression coverage exercises UI resources with a numeric catalog generation, delegated human credentials, ordinary action execution and audit.
- Retained main's MCP SDK 1.32.1 with ext-apps 1.7.5, and updated artifact checks and current documentation accordingly.
- Aligned Zod consumers, restored the Pi 1.0.0 internal package family on fresh installs, and patched production dependencies within compatible ranges. The external-consumer fixture uses the same pinned Pi family and pnpm version.
- Updated the PostgreSQL journey to inject an already-migrated runtime storage connection. Database checks retain a separate maintenance role, non-owner runtime role, forced row-level security and cross-database denial.

## Validation

Environment: macOS arm64, Node 24.21.0, pnpm 11.25.0, Chrome 155.0.8059.86, temporary PostgreSQL 16 Docker container. Temporary database credentials are generated for each run and are not recorded; the container is removed afterward.

| Check | Result |
| --- | --- |
| `pnpm verify` | Passed: lint, boundaries, skill checks, license consistency, typecheck, workspace tests, verification tests, builds, core API report and formatting |
| Browser renderer suite | Passed: 10 tests, including the official Apps bridge in an opaque iframe |
| Kanban SQLite interaction journey | Passed: native Pi, browser handoff, MCP Apps reference host, HTTP/CLI/plain MCP and state reconciliation |
| PostgreSQL gate | Passed: 12 storage/kernel cases and the authenticated cross-surface interaction journey |
| Packed GenUI consumer | Passed: fresh installation, public imports, Pi extension discovery/load/disposal and built browser asset |
| Real terminal smoke | Passed: fullscreen/dark and regular/light, resize, hook veto/correction, redaction and shutdown |
| Performance checks | Passed: enforced bundle, render, lifecycle, discovery, resource and retained-memory budgets |
| Production dependency audit | Passed: no known vulnerabilities |
| `pnpm test:genui-release` after final patches | Passed: 402 workspace tests with zero skips, 17 verification tests, browser/SQLite/PostgreSQL journeys, external consumer, terminal, performance, production audit and all 12 package artifact checks |

The normal workspace run skips database-only cases when no database is configured. The PostgreSQL gate above executes them against a real restricted-role database; skipped cases are not counted as database evidence.

## Scope and remaining work

This integration verifies the MCP Apps reference host, not live Codex, Claude or ChatGPT product surfaces. Named-client support still requires an actual client smoke test. Production standalone-browser authentication, custom HTML runtime and the local Pi UX proposal remain outside the merged subset. This work does not add a universal dashboard slash command or authorize publication/deployment.
