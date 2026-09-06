# Compatibility, versioning, and upgrades

## Supported baseline

| Component | Supported |
|---|---|
| Node.js | 22.x and 24.x |
| PostgreSQL | 16 and newer major versions after CI qualification |
| SQLite | 3.45+ with JSON1; current `better-sqlite3` bundled SQLite is tested |
| TypeScript | 5.9 for source consumers; emitted declarations follow package engines |
| Wire/manifest | protocol version 1 |

Node 22/24 are tested in CI. PostgreSQL 16 is the release gate; a newer major is supported only after the same storage, RLS, concurrency, migration, and distributed tests pass. SQLite is a local/single-process adapter, not a horizontally scaled deployment.

## SemVer surfaces

After the first stable release, removing/narrowing exported TypeScript declarations, plugin SPI fields, manifest/protocol fields, documented CLI JSON fields or exit meanings is breaking. Additive optional fields are minor. Fixes that preserve contracts are patch. Human-oriented non-JSON CLI prose is not stable.

Protocol messages carry a protocol version. Receivers reject unsupported major versions; additive fields require tolerant readers or a minor capability flag. Workflow definitions have independent SemVer and every nonterminal instance remains pinned; old handlers must remain deployed until they drain. Storage migrations are numbered, transactional, additive where possible, and forward-only.

Deprecations are documented in changelogs and runtime/type docs for at least one minor release before removal in a major release. Every breaking release provides a migration guide and protocol/storage compatibility window.

## Upgrade procedure

1. Read package/protocol/schema changelogs and list pinned workflow versions.
2. Back up and complete a restore drill.
3. Pack and test the exact artifacts in staging with runtime RLS credentials.
4. Apply migrations, canary one app and gateway, and inspect readiness, auth denials, queue age, errors, and traces.
5. Roll forward; retain the previous image and old workflow definitions.
6. Roll application code back only if it supports the migrated schema. Otherwise restore to an isolated database and follow the incident plan.
