# Phase 1 — Workspace and public contracts

**Specs:** all, especially 02–05. **Status items:** P1-01, P1-02.

## Objective

Create a reproducible monorepo and the stable, framework-agnostic types used by every later package. No database or HTTP implementation belongs here.

## P1-01: workspace bootstrap

1. Add root `package.json`, `pnpm-workspace.yaml`, strict shared TypeScript configs, formatting/lint configs, Vitest workspace config, changeset/release config, and lockfile.
2. Create package directories and package manifests with explicit `exports`; prevent accidental imports from `src/` or another package's internals.
3. Add root scripts: `build`, `typecheck`, `lint`, `test`, `test:postgres`, `test:e2e`, `format:check`, and `clean`.
4. Add CI with dependency cache, frozen install, lint/type/unit/build jobs, PostgreSQL integration job, and artifact-built E2E placeholder.
5. Enable strict TypeScript options including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Define a single approach to source maps and ESM file extensions.

## P1-02: contracts and compiler

Implement in `@embody/core`:

- `Principal`, `KernelContext`, `EmbodyPlugin`, entity/action/hook/event/service/workflow definitions, records, progress updates, manifests, execution and protocol types.
- `definePlugin()` preserving Zod inference without runtime mutation.
- `ActionDefinition` with input Zod schema, optional output schema, description, and handler.
- Structured `EmbodyError` subclasses/codes: validation, unauthenticated, forbidden, not found, conflict, hook veto, dependency, duplicate registration, unavailable, and internal.
- Canonical target parser/formatter and reserved-name rules.
- Manifest compiler that converts entity/action schemas to transport-neutral JSON Schema and emits plugin/version/entities/actions/event-subscription metadata. Manifest serialization must be deterministic.
- Contract validators for all phase-0 wire formats. Unknown object keys should be either consistently stripped or rejected per ADR; security envelopes should reject them.

Keep handler types parameterized by input/output and make `KernelContext` construction internal so consumers cannot forge transactional capabilities accidentally.

## Tests and success criteria

### Workspace tests

- A clean clone passes frozen install, lint, typecheck, unit tests, and build on the selected Node version.
- A consumer fixture imports only each package's public exports from built output and runs under Node ESM.
- CI package-boundary check fails a fixture that imports `@embody/core/src/...`.
- A deliberate TypeScript fixture proves invalid action input/handler types and invalid entity index keys fail compilation (`@ts-expect-error` assertions).

### Contract tests

- `definePlugin` infers action handler input and entity data, accepts every SPI section, and does not alter the caller's object.
- Every structured error maps to expected safe code/status; unknown errors map to `INTERNAL_ERROR` without leaking the original message in production mode.
- Target parser accepts canonical examples (`kanban.card.create`, `email.sendBatch`) and rejects empty segments, traversal/control characters, reserved prefixes, and collisions.
- Manifest snapshots include the five future CRUD schemas for a representative entity and preserve descriptions/defaults/enums/required fields in valid JSON Schema.
- Manifest output is byte-stable regardless of object insertion order.
- Protocol contract fixtures from phase 0 parse at both producer and consumer boundaries; invalid-version fixtures fail.

Phase 1 passes when all later packages can depend on built `@embody/core`, API Extractor/type snapshot review shows the intended public surface only, and P1-01/P1-02 evidence is recorded.