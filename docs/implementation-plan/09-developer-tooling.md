# Phase 9 — Developer tooling and testing package

**Spec:** 07. **Status:** P9-01 to P9-03.

## Objective

Make app creation, local iteration, and integration testing fast and faithful to production paths. Tooling must consume public package APIs; it must not depend on monorepo source aliases.

## P9-01: `@embody/testing`

Implement `createTestHarness`:

- Defaults to isolated temporary SQLite and local principal, accepts plugins, principal/tenant shorthand, fake services, clock/ID sources, and worker options.
- Boots the real kernel and invokes the real execution/authorization/hook/entity/outbox path through `harness.call`.
- Offers `as(principal)` for multi-tenant tests without sharing request context, `tickOutbox()`, event/outbox inspection, progress capture, and `close()`.
- Supports expected service overrides only through explicit keys and detects leaked handles/resources.
- Target startup under 10 ms is a goal measured on a warm representative environment, not a flaky per-test hard assertion. Publish benchmark methodology and percentile.

## P9-02: `embody dev` and inspector

- Load `embody.config.ts` through a documented dev loader, boot local verifier and SQLite, show host/MCP/inspector URLs and registered tools.
- Hot reload using process restart or fresh worker isolation; drain old host before rebinding. Failed reload keeps clear error state and can recover after file correction.
- Inspector at `/__inspector` only in development, loopback by default, with strict CSP/no arbitrary code execution.
- Features: manifest/schema-driven action form, invocation/result/progress view, outbox status stream, and hook trace/latency view.
- Inspector API uses the same execution path and escapes all plugin descriptions/payloads to prevent stored/reflected XSS. Redact sensitive payload fields.

Prefer a minimal static frontend with generated assets; avoid coupling core to UI framework.

## P9-03: `create-embody-app`

- Validate/sanitize project name and destination; refuse nonempty directory unless explicit safe option.
- Generate exact spec layout plus README/env example, pinned compatible dependencies, scripts, lock strategy, healthcheck Dockerfile, `.dockerignore`, and initial plugin/harness tests.
- Support package manager selection if approved; never run shell with unsanitized project name.
- Template uses public imports, development-safe defaults, no committed secret, and graceful app shutdown.
- Offer `--no-install` for deterministic CI and offline use.

## Tests and success criteria

### Harness tests

- Spec's Kanban harness example works with only documented adjustments and vetoes agent completion without PR.
- `as(orgB)` cannot access orgA entities; 50 concurrent principals do not leak identity/progress.
- Fake service override is visible only where configured; missing services fail like production.
- `tickOutbox()` deterministically exercises success/retry/dead-letter without sleeps.
- Closing after success and injected boot/action/worker failure leaves no DB files, timers, or open handles.
- Warm startup benchmark records median and p95; p95 target is <10 ms if feasible, otherwise discrepancy is documented before release.

### Dev/inspector tests

- Spawn built CLI in a fixture: startup output URLs respond and registered tool list matches manifest.
- Editing valid plugin triggers one reload and new tool appears; syntax error shows failure; fixing it recovers without orphan port/process.
- Inspector action run exercises auth/validation/hooks/outbox and renders progress/result.
- Malicious HTML/script in description, input, result, hook error, and event payload remains inert under browser test; CSP disallows inline/external unauthorized scripts.
- Inspector/outbox endpoints are absent in production and inaccessible from non-loopback under defaults.

### Scaffolder tests

- Golden file tests cover generated layout/config/scripts; project-name traversal and shell-metacharacter inputs are rejected.
- Pack local packages, scaffold into a temp directory, install from tarballs, then run generated `typecheck`, `test`, `build`, and built app health smoke test.
- Build generated Docker image, start it, and verify health plus graceful SIGTERM where CI supports Docker.
- Nonempty destination failure leaves existing files untouched; interrupted generation cleans only files it created.
- Secret scan confirms no live registration/JWT credentials in output.

Phase 9 passes when a user can scaffold outside the monorepo, install, test, run dev inspector, build, and stop the app using only published package surfaces.