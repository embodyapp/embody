# @embody/storage

Transactional storage ports plus SQLite and PostgreSQL adapters.

```sh
npm install @embody/storage
```

Requires Node.js 22 or 24 and uses ESM. `better-sqlite3` is a native dependency; use a supported Node release and platform toolchain when a prebuilt binary is unavailable.

`SqliteStorage` requires SQLite JSON1 and is intended for local/single-process use. `PostgresStorage` applies the same numbered infrastructure migrations and sets `app.current_org` with `SET LOCAL` semantics for every `transaction(orgId, ...)` callback.

## PostgreSQL deployment

Run `ensureSchema()` with a schema-owner role. Runtime connections must use a separate non-owner, non-superuser role with table privileges; PostgreSQL table owners bypass RLS unless `FORCE ROW LEVEL SECURITY` is explicitly configured. The runtime role must not have `BYPASSRLS`. This ensures the `embody_entities` and `embody_outbox` policies enforce the tenant set through `app.current_org`.

To run PostgreSQL integration tests, provide a disposable PostgreSQL 16+ database:

```sh
EMBODY_POSTGRES_URL=postgres://runtime:password@localhost:5432/embody pnpm --filter @embody/storage test:postgres
```

See the [storage guide](https://github.com/nimrod4278/embody/blob/main/docs/guides/02-entities-and-storage.md).

Licensed under the [Elastic License 2.0](./LICENSE).
