# Durable workspace catalog and credentials (M04)

The hosted gateway uses `createWorkspaceGateway` and `PostgresGatewayStore`, not the heartbeat-based `GatewayRegistry`. The memory adapter exists for conformance tests. M04 implements catalog persistence and credential authorization. Subsequent [M05 identity](./IDENTITY.md) and [M06 stateless MCP/client](./MCP.md) evidence are tracked separately; catalog persistence alone does not prove either. M07 durable audit/quotas and M12 deployment transaction/enqueue controller remain open.

## Identity, routes and provisioning

Workspace IDs follow M02 `ws_[a-z0-9]{8,64}`; app identities follow `app_[a-z0-9]{8,64}`; release pointers follow `rel_[a-z0-9]{8,64}`. `CatalogApp.appId` is the immutable app identity. `registration.appId` is its command/MCP namespace (e.g. `kanban`), unique **within** a workspace, including tombstones. Two workspaces can each have `kanban` with different endpoints and permission bindings. HTTP catalogs expose the namespace as `appId` for CLI compatibility and the opaque identity as `catalogAppId`.

Hosted routes:

- `/w/<workspace-id>/api/catalog`
- `/w/<workspace-id>/api/execute/<app-name>/<target>` and `/api/execute/stream/<app-name>/<target>` under the same workspace prefix
- `/w/<workspace-id>/mcp`, optionally `/mcp/<app-name>` under that prefix
- `/health`: public **liveness only**, no catalog/count/readiness information or DB/app requests

Every catalog, execution and MCP request binds the bearer credential to the workspace in the URL. Missing, malformed, guessed, expired, revoked or mismatched credentials have the same unauthenticated response and reveal no catalog. There are no hosted public registration/heartbeat endpoints or unprefixed catalog/MCP/dispatch routes. Trusted deployment/provisioning code writes registrations to the store directly; management routes and deployment controllers arrive in later milestones.

CLI configuration must set `EMBODY_GATEWAY_URL=https://gateway.example/w/ws_workspace01` (with or without trailing slash). Reverse-proxy prefixes are preserved too. MCP uses the **full** URL: `embody mcp --url https://gateway.example/w/ws_workspace01/mcp --token <credential>`; prefer secure environment/profile handling rather than leaving tokens in shell history. Existing reference routes remain unchanged for local/distributed framework E2E, not as a hosted authorization fallback.

## Platform schema and least-privilege roles

Use a **separate platform database** for the gateway store. Tables: `embody_platform_workspaces`, `embody_platform_apps`, `embody_platform_credentials`. Keys/foreign keys and unique constraints bind records to workspace; names and credential hashes are unique per workspace. App runtimes cannot CONNECT to the platform DB; gateway runtime cannot CONNECT to app fixture DBs. The disposable SQL fixture actually checks these negatives, not just role labels.

Migrate using restricted maintenance credentials via `new PostgresGatewayStore(maintenanceUrl).migrate()`, then close that store. Runtime must have schema USAGE and SELECT/INSERT/UPDATE/DELETE on the three tables, **not** schema CREATE, ownership, superuser, BYPASSRLS, role/DB creation or maintenance-role membership. `migrate()` checks maintenance authority and wraps DDL in an advisory-locked transaction. Provisioning methods belong to trusted control-plane code, not an app or unauthenticated API. Platform runtime is trusted across workspaces; this is **not** RLS against a compromised gateway or production/provider containment proof.

For a runnable disposable fixture and migration/grants, use [TESTING.md](./TESTING.md), `scripts/prepare-platform.mjs` and `test/postgres/init.sql`. Never run fixture scripts against production/customer DBs. Production IAM, network policy and credential rotation are M05/M09 qualification work.

A provisioning example, run in a trusted Node process with runtime DML authority after maintenance migrations:

```js
import { readFile } from 'node:fs/promises';
import { PostgresGatewayStore, newCredential } from '@embody/gateway';
const store = new PostgresGatewayStore(process.env.GATEWAY_PLATFORM_DATABASE_URL);
try {
  const workspaceId = 'ws_workspace01';
  await store.createWorkspace(workspaceId); // conflict rather than overwrite
  const appId = 'app_kanban0001';
  const registration = JSON.parse(await readFile('validated-registration.json', 'utf8'));
  // registration contains protocolVersion, appId:'kanban', version, endpoint,
  // healthCheckUrl, manifest. Supply an admitted/qualified endpoint, not client input.
  await store.putApp({ workspaceId, appId, registration,
    activeRelease: 'rel_release0001', state: 'idle' }, null);
  const issued = newCredential({ workspaceId,
    principal: { orgId: workspaceId, actorId: 'alice', actorType: 'human',
      roles: [], scopes: ['kanban:*'] },
    grants: [{ workspaceId, appId, role: 'app-caller' }],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const record = await store.putCredential(issued.credential, null);
  // Deliver issued.token ONCE over a secure channel; do not log/store it here.
  // record stores only SHA-256, principal, exact app grants and expiry.
  // Later revoke using current authoritative record + expected revision:
  // await store.putCredential({ ...record, revoked: true }, record.revision);
} finally { await store.close(); }
```

Runtime startup: `GATEWAY_PROFILE=hosted`, `GATEWAY_PLATFORM_DATABASE_URL` (platform runtime URL), required `GATEWAY_JWT_ISSUER`, `GATEWAY_JWT_KID`, `GATEWAY_JWT_PRIVATE_KEY` (gateway-only ES256 PKCS#8 PEM), `GATEWAY_JWT_PUBLIC_JWKS` (public rotation keys), and `PORT`/`HOST`. Hosted startup never migrates or creates a bootstrap key. Unknown profiles fail. `reference` remains the default only for existing reference E2E compatibility; production deployment must explicitly choose hosted. Hosted public errors are always sanitized, even if a caller requests development error rendering. M05 adds asymmetric host-token verification and mandatory delegated MCP attribution; [configuration/rotation bounds](./IDENTITY.md). Provider IAM/private invocation qualification remains open.

## Atomicity, discovery, freshness and failures

- `null` expected revision means create only; a positive expected revision means exact CAS update. Invalid/stale revisions conflict without changing data.
- App writes atomically update registration/active release/state, app revision, promotion generation and workspace revision. Every app write advances generation (conservative invalidation; never decrement/reset). Credentials have separate revisions; successful credential writes also advance workspace revision.
- PostgreSQL locks the workspace row per mutation and commits all changes in one transaction. Duplicate identity/name/hash and stale CAS roll back, including the workspace revision. Snapshot reads use a single statement for a consistent workspace revision/catalog pair. Memory operations are atomic and clone input/output values.
- Tombstones persist; deleted entries leave discovery. Idle, ready, unavailable and disabled remain discoverable with explicit state. Only idle/ready are dispatchable, and they require an active release pointer. No instance count or heartbeat determines discovery; listing performs **zero app HTTP requests**.
- **Server positive-cache capacity is zero; TTL is zero.** Each new operation re-reads authoritative credentials and catalog. Promotion/grant/revocation changes become visible on the next request in another gateway or cold start, stronger than the 30-second target. No background timer/polling is introduced. Pool max is 5; connect/acquire/query/server statement timeouts are 5 seconds.
- Authentication snapshot is request-local via AsyncLocalStorage, so overlapping workspace requests cannot replace each other's catalog. In-flight operations admitted before mutation may finish; revocation is not retroactive cancellation. Credential expiry is checked at request start (`expiresAt <= now` denies).
- Hosted MCP is stateless per request: no session ID, initialization affinity or prior client-capability state is required. Every request authenticates and reads current workspace/app grants again; grant changes do not require a fresh initialize. The standalone MCP adapter retains a stateful default for compatibility. See the [hosted MCP contract](./MCP.md) for client versions, capability, cancellation and idle limitations.
- Hosted catalogs use `private, max-age=0, must-revalidate` and `Vary: authorization`; the reference gateway retains its 30-second metadata setting. ETag/304 is computed only **after live authentication**; cached tools/CLI metadata never authorize execution. CLI cache keys already include full base URL and bearer credential; authentication/network failures do not fall back to cache.
- An authoritative credential/catalog failure fails closed, with sanitized error, never a stale catalog or app dispatch. Read failures may return 500; clients must not treat liveness as readiness or retry authorization from stale metadata. No provider availability promise is inferred.

## Acceptance evidence

Shared memory/real PostgreSQL conformance plus separate-process persistence, actual hosted bootstrap, closed-pool fail-closed, SQL privilege negatives, independent connection pools/two gateway instances, real MCP clients and CLI binary prefix regressions implement M04.a–d. Mandatory `pnpm test:gateway-store` and `pnpm test:mvp` reject missing config, empty reports and **any required skip**. See the tracker and dated evidence for executed candidates; source-level tests alone are not completion evidence.
