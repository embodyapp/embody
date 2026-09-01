# ADR 0001: Phase 1 stack and package boundaries

- Status: Accepted
- Date: 2026-09-01

## Decision

Use a strict ESM TypeScript monorepo managed by pnpm. Public runtime validation uses Zod 4, tests use Vitest, linting uses ESLint, formatting uses Prettier, and public API changes are reviewed through API Extractor reports.

The package boundaries are `core`, `storage`, `host`, `auth`, `gateway`, `mcp`, `cli`, `testing`, and the unscoped `create-embody-app`. Imports from another package's `src` tree are forbidden. `@embody/core` remains independent of HTTP and database drivers.

Use plain pnpm recursive scripts initially instead of Turborepo; add orchestration only when measured build cost justifies it.

## Consequences

Packages expose ESM and declarations through explicit `exports`. Strict TypeScript settings, including unchecked-index and exact-optional checks, apply workspace-wide. Zod schemas are the source for transport-neutral JSON Schema.