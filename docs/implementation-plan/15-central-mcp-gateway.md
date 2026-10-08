# Phase 15 — Central MCP gateway

**Design:** [central MCP gateway plan](../plans/central-mcp-gateway.md); ADR 0006 (written in P15-00). **Status:** proposed; blocked on D-07. **Depends on:** P7-01–P7-03, P8-01–P8-03, P10-03.

## Objective

Make the Embody gateway the one MCP endpoint a customer org connects to from Claude, Codex, ChatGPT, Cursor and other MCP clients, with:

- per-org tenancy (registry, credentials, identity, limits, audit);
- a stateless gateway process (any instance serves any request);
- one codebase for shared multi-tenant and dedicated single-org deployments;
- the fastest path to a working release: three milestones, each shippable.

| Milestone | Items | Releasable result |
|---|---|---|
| M0 | P15-00 | Decision approved, client behavior known |
| M1 | P15-01 – P15-06 | Dedicated gateway works in token-capable chat clients |
| M2 | P15-07 | Dedicated gateway works in Claude web/desktop connectors and ChatGPT (OAuth) |
| M3 | P15-08 – P15-11 | Shared multi-tenant gateway |

P15-08 (PostgreSQL store) has no M2 dependency and may start once P15-05 is done; it is needed by any deployment running more than one gateway instance.

## Non-goals

Do not build in this phase (see design plan §8): `tools/list_changed` notifications, MCP sessions or per-session state, shared rate-limit store, transparent stdio bridge, `embody login`, MCP in `embody dev`, a development authorization server, per-org hostnames, app icons, MCP tasks, app-declared prompts/resources, multi-org registration from one app host, chat GenUI.

## Conventions for every item

- One PR per item unless noted. Branch `feat/p15-xx-<slug>`.
- Public type changes update the API report (`pnpm api-report`) in the same PR.
- Every user-visible change has docs and a changeset.
- Item is `DONE` only when its tests pass and `pnpm verify` passes from the root, recorded in STATUS.
- No sleeps in tests; inject clocks, timers and fetch as existing gateway/host tests do.
- Wire formats (registration body, gateway JWT claims, MCP payloads) change atomically with contract tests.

---

## P15-00: ADR and client spike

### Deliverables

1. `docs/adr/0006-central-mcp-gateway.md`: the decisions in design plan §4 (central MCP in gateway, org tenancy, org in URL, stateless MCP, compact discovery, delegated agent principal, asymmetric org-bound host tokens, OAuth resource server only). Add D-07 to STATUS as `DONE` when approved.
2. Spike server in `scripts/spikes/mcp-clients/` (not published, not in the workspace build): a single-file Node server using the official SDK in stateless mode with 120 generated tools, two discovery tools, annotations, an `outputSchema` tool, server instructions, and OAuth protected-resource metadata pointing at a test identity provider.
3. `docs/guides/mcp-client-support.md`: one row per client/version tested (Claude Desktop, Claude web, Claude Code, Codex, ChatGPT, Cursor, MCP Inspector) with columns:

| Column | Question |
|---|---|
| Stateless | Lists and calls tools with no `Mcp-Session-Id`? |
| Token header | Can send a static bearer token? |
| OAuth | Discovers resource metadata; registration method used (client ID metadata document / dynamic registration / pre-registered); honors `insufficient_scope`; refreshes tokens |
| Tool count | Behavior with 120 tools (works / warns / truncates / fails) |
| Annotations | Read-only or destructive hints change approval prompts? |
| Structured | `structuredContent` shown or used? `instructions` used? |

### Decisions recorded from results

- Default compact threshold (starting value 40).
- Whether any must-have client needs session mode. If yes, P15-04 keeps a `sticky` mode for that client; otherwise session code is deleted.
- Identity provider(s) for M2 docs and CI.

### Success criteria

ADR approved; matrix committed with dates and versions; the three decisions above written into this file's P15-03, P15-04 and P15-07 sections.

---

## M1 — works in chat

### P15-01: shared dispatch pipeline, real errors, audit on every surface

**Packages:** `@embody/gateway`, `@embody/mcp`.

#### Changes

New `packages/gateway/src/dispatch.ts`:

```ts
export type DispatchSurface = "http" | "stream" | "mcp";

export interface PublicError {
  readonly code: EmbodyErrorCode;
  readonly message: string;            // bounded to 2,000 chars, control chars stripped
  readonly requestId: string;
  readonly details?: readonly ValidationIssue[]; // bounded to 50 issues
  readonly retryAfterSeconds?: number;
}

export interface DispatchContext {
  readonly principal: Principal;
  readonly appId: string;
  readonly target: string;
  readonly requestId: string;
  readonly surface: DispatchSurface;
  readonly signal: AbortSignal;
}

export interface PreparedDispatch {
  readonly endpoint: URL;
  readonly headers: Readonly<Record<string, string>>; // includes x-gateway-auth
  finish(outcome: { readonly code?: EmbodyErrorCode; readonly ok: boolean }): void; // writes audit once
}

/** Lookup, health, advertised target, scope, rate limit, token. Throws EmbodyError. */
export function prepareDispatch(ctx: DispatchContext, deps: DispatchDeps): Promise<PreparedDispatch>;

/** Bounded SSE parser shared by MCP and audit tapping. */
export function parseExecutionStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<
  | { type: "progress"; update: ProgressUpdate }
  | { type: "result"; value: unknown }
  | { type: "error"; error: PublicError }
>;

/** Parses a host ErrorEnvelope; anything malformed or unknown becomes INTERNAL. */
export function parseErrorEnvelope(value: unknown, requestId: string): PublicError;
```

- `AuditSink` interface in `packages/gateway/src/audit.ts`: `append(record: AuditRecord): void`. `MemoryAuditLog` implements it. New `jsonLineAuditSink(write = (line) => process.stdout.write(line))`.
- `AuditRecord` gains `surface`, `orgId`, `errorCode?`, and (after P15-06) `subjectId?`, `client?`.
- `GatewayOptions.audit` type becomes `AuditSink`.
- Rate-limit key: `${orgId}:${actorId}:${appId}:${target}`.
- Routes:
  - `POST /api/execute/:appId/:target`: `prepareDispatch` → host `/execute` → `finish`.
  - `POST /api/execute/stream/:appId/:target`: `prepareDispatch` → pipe host bytes unchanged while a tap parses frames to find the terminal event → `finish`. (Fixes missing audit and rate limit.)
  - MCP `execute` collaborator: `prepareDispatch` → host `/execute/stream` → `parseExecutionStream` → yield events → `finish`.
- `@embody/mcp`: `McpExecutionEvent` error variant becomes `{ type: "error"; error: PublicError }` (re-declare the shape in `@embody/mcp` to avoid a gateway dependency). New `mcpErrorResult(error)`:
  - `content`: one text block — message, then `- <path>: <message>` per validation issue, then `Retry after N s` when present;
  - `isError: true`;
  - `_meta`: `{ "embody/errorCode", "embody/requestId" }`.
- Unavailable app: message `"<appId> is temporarily unavailable"`, code `UNAVAILABLE`.

#### Tests

`packages/gateway/test/dispatch.test.ts`:

- Each code (`VALIDATION_ERROR` with details, `HOOK_VETO`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `UNAVAILABLE`, `INTERNAL`) from a fake host produces the expected `PublicError`.
- Malformed JSON, missing fields, unknown code, oversized message, 64 KiB+ frame, truncated stream → `INTERNAL`, no host text leaked.
- One audit record per call on all three surfaces, with the right `surface` and outcome; cancelled calls audited as `cancelled`.
- Rate limit applies to stream and MCP.

`packages/mcp/test/mcp.test.ts`: official SDK client receives `isError`, text and `_meta` for a veto and a validation error.

E2E journey (`test/fixtures/distributed-e2e/journey.mjs`): the MCP step that triggers Kanban's PR guardrail asserts the veto message text reaches the client.

#### Success criteria

All surfaces audited and rate-limited; agents receive actionable errors; existing HTTP and CLI E2E unchanged.

---

### P15-02: action effects and app metadata

**Packages:** `@embody/core`, `@embody/host`, `@embody/gateway` (validation), `create-embody-app`, examples.

#### Changes

- `ActionManifest` (`packages/core/src/manifest.ts`) and its zod schema in `protocol.ts` gain optional `title` (≤ 80), `effect: "read" | "write" | "destructive"`, `idempotent: boolean`.
- `AppManifest` gains optional `app: { title?: string; description?: string; instructions?: string }` (≤ 80 / 500 / 2,048 chars, no control characters except `\n`).
- Plugin action definitions accept `effect`, `title`, `idempotent`; values flow into the compiled manifest.
- Generated CRUD actions set: `get`, `list` → `read`; `create` → `write`; `update` → `write`, `idempotent: true`; `delete` → `destructive`. Workflow controls: `status` → `read`; `start`, `retry` → `write`; `cancel` → `destructive`.
- `defineApp` / `createAppHost` accept `title`, `description`, `instructions` and place them in `manifest.app`.
- Helper `actionEffect(action: ActionManifest): ActionEffect` returns `action.effect ?? "write"`. Export from core; use it everywhere instead of reading the field directly.
- Gateway `validateRegistration`: enforce limits and characters; reject app ID `embody`.
- Kanban: `kanban.board` → `read`; `kanban.bulkMove` → `write`; titles and app metadata. Email: `sendBatch` → `write`; app metadata.
- `create-embody-app` template: app `title`/`description` placeholders and `effect` on the sample action.

#### Compatibility

Fields are optional and `protocolVersion` stays `1`. The gateway does not strictly parse unknown manifest fields today, so new hosts register with old gateways. Old hosts register with new gateways; their custom actions resolve to `write`.

#### Tests

- Core: manifest golden snapshots for generated CRUD and workflow effects; schema accepts and rejects boundary lengths; `actionEffect` default.
- Gateway: registration rejects oversize/control-character metadata and app ID `embody` with value-free messages; manifest without new fields registers.
- Examples: Kanban/Email manifest snapshots.

---

### P15-03: MCP tool metadata, structured results, compact discovery

**Packages:** `@embody/mcp`, `@embody/gateway` (options).

#### Changes

`McpCatalogEntry` carries what tools need:

```ts
export interface McpCatalogEntry {
  readonly appId: string;
  readonly target: string;
  readonly effect: ActionEffect;
  readonly tool: McpTool; // name, title, description, inputSchema, outputSchema?, annotations
}
export interface McpAppSummary {
  readonly appId: string;
  readonly title: string;          // app.title ?? appId
  readonly description?: string;
  readonly instructions?: string;
  readonly status: "healthy" | "unavailable";
  readonly toolCount: number;
}
```

- `tool()` sets `title`, `annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false }` from the effect, and `outputSchema` only when the action's output schema has `type: "object"`.
- Results: when the entry has `outputSchema` and the value is a plain object, return `structuredContent: value` plus `content` text = `JSON.stringify(value)`; otherwise text only. Hosts already validate outputs against the action's Zod schema, so the gateway does not re-validate.
- Server: name `embody`, version from `package.json`; `instructions` built by `buildInstructions(apps)`: fixed text (≤ 1 KiB) explaining tool naming, the discovery tools and error format, then `- <title> (<appId>): <description>` per authorized app; total ≤ 8 KiB, truncated by whole lines.
- Catalog view:

```ts
export interface McpCatalogViewOptions {
  readonly scopedAppId?: string;              // /mcp/:appId → always full, no discovery tools
  readonly mode?: "auto" | "full" | "compact"; // from ?tools=
  readonly selectedApps?: readonly string[];   // from ?apps=, ≤ 20 IDs, validated
  readonly threshold: number;                  // default 40 (P15-00)
  readonly budgetBytes: number;                // default 256 KiB
}
export function createCatalogView(
  entries: readonly McpCatalogEntry[],
  apps: readonly McpAppSummary[],
  options: McpCatalogViewOptions,
): { readonly mode: "full" | "compact"; readonly tools: readonly McpTool[] };
```

  `auto` resolves to `full` when entries ≤ threshold and serialized tools ≤ budget, otherwise `compact`. `compact` = discovery tools + entries of `selectedApps`.
- Discovery tools (handled inside `@embody/mcp`, dispatching through the same `execute` collaborator):

| Name | Annotations | Input schema | Behavior |
|---|---|---|---|
| `embody_apps` | readOnly | `{}` | Returns `McpAppSummary[]` as structured content |
| `embody_describe` | readOnly | `{ appId: string, target?: string }` | Returns tool name, title, description, effect, input and output schemas for one target or all of an app's targets (bounded by budget; paginated by `cursor` if exceeded) |
| `embody_read` | readOnly | `{ appId: string, target: string, input: object }` | Rejects unless `actionEffect` is `read`; then dispatches |
| `embody_write` | destructive | `{ appId: string, target: string, input: object }` | Rejects `read` targets (use `embody_read`); dispatches `write`/`destructive` |

  Unknown or unauthorized app/target returns the same `NOT_FOUND` result, so discovery cannot probe for apps.
- Gateway: `GatewayOptions.mcp?: { threshold?: number; budgetBytes?: number }`; MCP route parses `?tools=` and `?apps=` (reject invalid values with `400`).

#### Tests

- `tools/list` snapshots: Kanban+Email full mode; synthetic 10-app (150 tools) compact mode; `?apps=kanban` adds exactly Kanban's tools with the same names as full mode; `/mcp/kanban` is full and has no discovery tools.
- Annotations per effect; `outputSchema` present only for object outputs; `structuredContent` equals the value.
- `embody_read` on a write target → error; `embody_write` on a read target → error; both enforce scopes; unauthorized and nonexistent targets give identical results.
- A scripted SDK client that never re-lists completes list → create → update → delete using only discovery tools.
- Instructions bounded and include only authorized apps.

---

### P15-04: stateless MCP transport

**Packages:** `@embody/mcp`, `@embody/gateway`.

#### Changes

- `McpHttpHandler.handle()` per request: authenticate (route), build `Server` with handlers bound to `(principal, org, view options)`, create `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, `connect`, `handleRequest`, and close both when the response finishes or the client aborts.
- `GET` and `DELETE` on MCP routes → `405 Method Not Allowed` with `Allow: POST`.
- Remove the session map, identity pinning and `Mcp-Session-Id` handling. If P15-00 requires session mode for a client, keep it behind `GatewayOptions.mcp.sessions: "sticky"` (off by default) with a documented sticky-routing requirement.
- Graceful shutdown in `createGateway`: on `preClose`, stop accepting MCP requests (`503`), wait for in-flight MCP calls up to `shutdownGraceMs` (default 10,000), then abort them. Track in-flight calls with a counter and `AbortController` set.

#### Tests

- SDK client initializes, lists and calls with no session header; repeated requests succeed.
- Two `createGateway` instances sharing one in-memory `GatewayStore` (P15-05) behind a test round-robin `fetch`: list on one, call on the other.
- Aborting the client request cancels the host call (existing cancellation tests pass).
- Shutdown with a slow in-flight call: completes within grace; past grace it is aborted and audited `cancelled`.
- Phase 8 progress ordering tests still pass.

---

### P15-05: org-keyed state behind `GatewayStore`

**Packages:** `@embody/gateway`, `@embody/host`, `@embody/cli`, `apps/gateway`.

#### Changes

New `packages/gateway/src/store.ts`:

```ts
export interface OrgConfig {
  readonly orgId: string;
  readonly allowedOrigins?: readonly string[];
  readonly auth?: OrgAuthConfig;    // used by P15-07
  readonly limits?: OrgLimits;      // used by P15-10
}
export interface StoredRegistration extends Registration {
  readonly orgId: string;
  readonly generation: string;
  readonly lastSeen: string;
}
export interface GatewayStore {
  getOrg(orgId: string): Promise<OrgConfig | undefined>;
  /** Credential secrets are random and high-entropy; lookup by SHA-256 hash is sufficient. */
  findCredential(secretHash: string): Promise<{ orgId: string; appId: string } | undefined>;
  putRegistration(value: StoredRegistration): Promise<void>;          // bumps org revision on new app or generation
  touch(orgId: string, appId: string, generation: string, at: string): Promise<"ok" | "missing" | "stale">;
  getRegistration(orgId: string, appId: string): Promise<StoredRegistration | undefined>;
  listRegistrations(orgId: string): Promise<{ revision: number; registrations: readonly StoredRegistration[] }>;
}
export class MemoryGatewayStore implements GatewayStore { /* constructor({ orgs, credentials, initial }) */ }
```

- `GatewayRegistry` becomes a façade over a store:
  - `new GatewayRegistry({ store, ttlMs?, clock?, allowPrivateEndpoints?, ... })`;
  - legacy constructor `{ credentials: Record<appId, secret>, initial? }` still accepted for one release: builds a `MemoryGatewayStore` with a single org from `GatewayOptions.defaultOrg` (required in that case) and logs a deprecation warning;
  - methods become async: `register(body, secret)`, `heartbeat(body, secret)`, `snapshot(orgId)`, `get(orgId, appId)`, `destinations(event)` (filters by `event.orgId`).
- Health derived on read: `status = lastSeen > now - ttl ? "healthy" : "unhealthy"`. Remove the mutating `expire()`.
- Per-instance catalog cache: `Map<orgId, { revision, healthyUntil, entries }>`, recomputed when revision changes or the earliest `lastSeen + ttl` passes; at most 2 s old.
- Registration body accepts optional `orgId`; when present it must equal the credential's org (`403` otherwise).
- All gateway reads use the principal's `orgId` (catalog, `/api/catalog`, MCP, dispatch).
- `GatewayOptions.defaultOrg?: string` = dedicated mode. Shared mode (no default org) arrives with routing in P15-10; until then `defaultOrg` is required.
- Host: optional `GATEWAY_ORG_ID`; registration and heartbeat include it when set. Fix URL joining in `createRegistrationClient` so a `GATEWAY_URL` with a path prefix keeps it (use `new URL("register", base.endsWith("/") ? base : base + "/")`).
- CLI: same URL-joining fix for `/api/catalog` and `/api/execute*` so `--base-url https://gw/o/acme` works.
- `apps/gateway`: build `MemoryGatewayStore` from env (`GATEWAY_ORG_ID`, existing per-app secrets).

#### Tests

- Store conformance suite (`packages/gateway/test/store-conformance.ts`) run against `MemoryGatewayStore` (and later Postgres): put/get/touch/stale generation/revision bumps.
- Two orgs, each with `kanban` on different endpoints: each principal sees and calls only its own; same app ID does not collide.
- Credential for org A cannot register into org B, including with a forged `orgId` body.
- Events: `destinations` only returns the event's org.
- Legacy constructor works and warns.
- Host and CLI URL joining with and without path prefixes.
- Existing single-org E2E passes unchanged.

---

### P15-06: delegated agent principal

**Packages:** `@embody/core`, `@embody/auth`, `@embody/host`, `@embody/gateway`, `@embody/testing`, Kanban.

#### Changes

- `Principal.delegation?: { subjectId: string; subjectType: "human" | "system"; client?: string }` in `contracts.ts`; `principalSchema` and `Kernel.assertPrincipal` validate it (strings ≤ 200 chars).
- `@embody/auth` `principalFromClaims` parses and validates `delegation`.
- Gateway `issueGatewayToken` already spreads the principal; add a contract test that `delegation` round-trips.
- Gateway MCP route: `const effective = mcpPrincipal(principal, { mode: options.mcp?.actor ?? "agent-on-behalf", client })`:
  - `actorType === "agent"` → unchanged;
  - otherwise → `{ ...principal, actorType: "agent", actorId: truncate(`${client ?? "mcp"}:${principal.actorId}`, 200), delegation: { subjectId: principal.actorId, subjectType: principal.actorType, ...(client ? { client } : {}) } }`.
  - `client` comes only from verified token claims (`azp` or `client_id` for OIDC; API key record ID). The MCP `clientInfo` from the client is never used for identity.
  - `mode: "token"` keeps today's behavior and logs a deprecation warning once at startup.
- Audit (gateway and kernel) records `subjectId` and `client`.
- `@embody/testing`: add a `delegatedAgent(subject)` principal view.
- Spec 04 and the auth guide document the rule.

#### Tests

- Human API key over MCP → host receives `actorType: "agent"` with delegation; Kanban PR guardrail vetoes; audit has subject.
- Same key on `/api/execute` → `human`, guardrail not applied (unchanged).
- Agent key over MCP → unchanged, no delegation.
- Invalid `delegation` claims rejected by host verifier and kernel.
- `mode: "token"` restores old behavior.

### M1 exit checklist

- P15-01–P15-06 `DONE`.
- E2E journey extended: MCP discovery (`embody_apps`), compact call path, veto message, delegated actor.
- Manual verification in Claude Code and Codex with a token against a dedicated gateway, recorded in `mcp-client-support.md`.
- Docs: `docs/agent-integrations/` guides for Claude Code, Codex, Cursor; Claude Desktop guide's veto example matches real output; Spec 05 updated (compact discovery, stateless, error format).
- Release notes: informative errors, delegation behavior change, `mcp.actor: "token"` escape hatch.

---

## M2 — chat products

### P15-07: OAuth resource server per org

**Packages:** `@embody/gateway`, `apps/gateway`, docs.

#### Changes

- `GatewayOptions.publicUrl: string` (required when OAuth is configured) used to build absolute resource URLs behind proxies.
- `OrgAuthConfig`:

```ts
export interface OrgAuthConfig {
  readonly issuer: string;
  readonly jwksUrl?: string;
  readonly audience?: string;                 // default: `${publicUrl}${orgPrefix}/mcp`
  readonly algorithms?: readonly string[];    // default ["RS256", "ES256"]
  readonly claims?: {                          // defaults shown
    readonly actorId?: string;                 // "sub"
    readonly roles?: string;                   // "roles"
    readonly scopes?: string;                  // "scope" (space-delimited) or array claim
  };
  readonly scopeMap: Readonly<Record<string, readonly string[]>>; // OAuth scope or role → Embody scope patterns
  readonly supportedScopes?: readonly string[]; // advertised in metadata, default Object.keys(scopeMap)
}
```

  Principals from OAuth tokens: `orgId` = the URL's org (never from the token alone; the token's issuer must be that org's issuer), `actorType: "human"` (then delegated by P15-06 on MCP), scopes = union of `scopeMap` entries for granted scopes and roles.
- Effect-aware scope patterns: `scopeAllows(principal, appId, target, effect)` accepts `@read` (any read target, all apps) and `<app>:@read`. Before issuing the gateway token, the gateway **expands** effect patterns into concrete per-target scopes for the target app, so app hosts' kernels need no change.
- Routes:
  - `GET /.well-known/oauth-protected-resource` (dedicated `/mcp`) and `GET /.well-known/oauth-protected-resource/o/:org/mcp` (RFC 9728 path form; available once P15-10 adds `/o/:org`): `{ resource, authorization_servers: [issuer], scopes_supported, bearer_methods_supported: ["header"] }`.
  - MCP routes: missing or invalid token → `401` with `WWW-Authenticate: Bearer resource_metadata="<url>", scope="<supported>"`. Insufficient scope on a call → MCP tool error **and**, for the HTTP request, `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<needed>"` when the whole request is unauthorized.
  - Audience check: token `aud` must contain the org's audience.
- The auth chain per org: OAuth provider for that org first, then API keys (unchanged).
- `apps/gateway`: env `GATEWAY_PUBLIC_URL`, `GATEWAY_OIDC_ISSUER`, `GATEWAY_OIDC_AUDIENCE`, `GATEWAY_OIDC_SCOPE_MAP` (JSON).

#### Tests

- Metadata JSON matches RFC 9728 fields; URLs absolute and correct behind a `publicUrl` with a path.
- Challenges: no token, malformed token, wrong issuer, wrong audience, expired, other org's issuer → `401` with header; under-scoped → `403` with `insufficient_scope`.
- `@read` permits list/get, denies create/update/delete; expanded scopes accepted by the real Kanban host kernel.
- CI: a local test identity provider (choice from P15-00, e.g. a containerized OIDC server) issues tokens; MCP Inspector CLI or SDK client completes the authorization code + PKCE flow in the E2E stack.

#### M2 exit checklist

Claude web/desktop custom connector and ChatGPT connector verified against a dedicated gateway with OAuth, recorded in the support matrix; setup guide for the chosen identity provider; agent-integration guides for both products.

---

## M3 — shared multi-tenant

### P15-08: PostgreSQL `GatewayStore`

**Packages:** `@embody/gateway` (subpath export `@embody/gateway/postgres`, `pg` as optional peer dependency), `apps/gateway`.

#### Changes

Migrations (own table `embody_gateway_migrations`, same pattern as `@embody/storage`):

```sql
CREATE TABLE gateway_orgs (
  org_id TEXT PRIMARY KEY,
  config JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE gateway_app_credentials (
  secret_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES gateway_orgs(org_id),
  app_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE TABLE gateway_registrations (
  org_id TEXT NOT NULL REFERENCES gateway_orgs(org_id),
  app_id TEXT NOT NULL,
  version TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  health_check_url TEXT NOT NULL,
  manifest JSONB NOT NULL,
  generation TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, app_id)
);
```

- `putRegistration`: upsert in one transaction; increment `gateway_orgs.revision` when the app is new or `generation` changed.
- `touch`: `UPDATE … SET last_seen = $at WHERE org_id = $1 AND app_id = $2 AND generation = $3`; zero rows → check existence to return `missing` or `stale`.
- `listRegistrations`: one query joining revision.
- Admin script `apps/gateway/src/admin.ts` (`pnpm --filter @embody/app-gateway admin …`): `org create <orgId>`, `org set-auth <orgId> <json>`, `credential issue <orgId> <appId>` (prints the secret once), `credential revoke <orgId> <appId>`. Uses the database directly; never exposed over HTTP.
- `apps/gateway`: `GATEWAY_STORE=postgres` + `GATEWAY_DATABASE_URL`.

#### Tests

- Store conformance suite against real PostgreSQL 16 (enabled like existing PostgreSQL tests).
- Two gateway processes on one database: registration on one is visible on the other within the cache window; restart loses nothing.
- Revoked credential cannot register or heartbeat.

---

### P15-09: asymmetric, org-bound gateway tokens

**Packages:** `@embody/gateway`, `@embody/host`, `apps/gateway`, docs.

#### Changes

- `GatewayTokenOptions` becomes:

```ts
export type GatewayTokenOptions =
  | { readonly issuer: string; readonly algorithm: "ES256"; readonly keys: readonly SigningKey[]; readonly clock?: Clock }
  | { readonly issuer: string; readonly algorithm?: "HS256"; readonly key: Uint8Array; readonly kid?: string; readonly clock?: Clock }; // deprecated
export interface SigningKey { readonly kid: string; readonly privateKey: KeyLike; readonly active: boolean }
```

  Sign with the single `active` key; publish all keys' public parts at `GET /.well-known/jwks.json` (`cache-control: max-age=300`). Token lifetime reduced from 300 s to 60 s.
- Claims unchanged except they already include `orgId`; add standard `sub` = `actorId` for interoperability.
- Host (`createAppHost`): if `GATEWAY_JWKS_URL` is set, use `gatewayJwtVerifier({ jwksUrl, algorithms: ["ES256"], issuer, audience: appId })` (already supported by `@embody/auth`). New required-with-JWKS `GATEWAY_ORG_ID`: verifier rejects tokens whose `orgId` differs. `GATEWAY_JWT_SECRET` path keeps working with a deprecation warning.
- Gateway refuses to start in shared mode (no `defaultOrg`) with HS256.
- `apps/gateway`: `GATEWAY_SIGNING_KEYS` (JSON array of `{ kid, privateKeyPem, active }`), loaded at startup; documented KMS/secret-manager integration.

#### Tests

- Host rejects: other org, other app, unknown `kid`, HS256 when configured for JWKS, expired, wrong issuer.
- Rotation: add key B inactive → publish → flip active → remove A after max token lifetime; calls succeed throughout.
- E2E compose switches to ES256 + JWKS.

---

### P15-10: tenant routing, endpoint safety, per-org limits

**Packages:** `@embody/gateway`, `apps/gateway`.

#### Changes

- Routing: register all client-facing routes (`/api/catalog`, `/api/execute*`, `/mcp`, `/mcp/:appId`) under `/o/:org` as a Fastify plugin. In dedicated mode also register them at the root for `defaultOrg`. Registration/heartbeat stay unprefixed (the credential decides the org) and are also available under `/o/:org`.
- Org resolution hook: unknown org → `404` with the same body as any not-found; after authentication, `principal.orgId !== urlOrg` → `403`.
- Safe fetch: `createSafeFetch({ allowPrivate })` using an undici `Agent` with a `connect.lookup` that resolves, rejects any blocked address (reuse `blockedHost` rules for IPv4/IPv6, plus IPv4-mapped IPv6), and connects only to the validated address. Use it for dispatch and health checks. Redirects disabled (`redirect: "error"`). Shared mode forces `allowPrivate: false`; registration also validates DNS at registration time.
- Per-org allowed origins from `OrgConfig.allowedOrigins`.
- `OrgLimits` with defaults: `maxApps: 50`, `maxCatalogTools: 1,000`, `requestsPerMinute: 600` (per org per instance), `requestsPerMinutePerActor: 120`, `maxConcurrentCalls: 50` (per org per instance). Exceeding → `RATE_LIMITED` / registration `409` with clear messages.
- Durable event relay (P7-04) and direct delivery use org-filtered `destinations` (from P15-05); add org check to relay path.

#### Tests

- Every client route reachable under `/o/<org>`; dedicated root routes still work; unknown org and mismatched token org rejected.
- DNS rebinding fixture (resolver returns public then private address) blocked at connect; private IP and `localhost` registration rejected in shared mode; redirects refused.
- Org A at its limits does not affect org B's calls.
- Events from org A never reach org B's subscriber with the same app ID.

---

### P15-11: isolation gate and production readiness

**Packages:** test fixtures, docs, `apps/gateway`.

#### Deliverables

1. **Cross-tenant suite** `test/fixtures/distributed-e2e/isolation.mjs` (release-blocking, runs in `pnpm test:e2e`) with two orgs, both running Kanban:
   - org A token on org B URL (HTTP and MCP) → rejected;
   - guessed app IDs and targets via `embody_describe`, `embody_read`, `/api/catalog` → no leakage, identical not-found responses;
   - org A registration credential against org B → rejected;
   - host of org B rejects a validly signed token for org A;
   - events stay within org;
   - audit records carry the correct org;
   - catalog cache never serves one org's catalog to another (alternating requests under load).
2. **Load test** (`scripts/load/gateway-mcp.mjs`): 100 orgs × 10 apps × 15 tools on PostgreSQL store, two instances; record p50/p95 for `tools/list` (compact and full) and calls in `docs/production/06-performance-baseline.md`.
3. **Operations:** runbook entries in `docs/production/04-operations-runbook.md` (org provisioning, credential issue/revoke, signing key rotation, draining an instance, identity provider outage); metrics (requests/errors by org, surface, code; OAuth challenges; registrations; heartbeat lag; catalog cache hit rate) exposed through the existing observability approach; suggested alerts.
4. **Docs:** self-hosting guide gains dedicated vs shared modes, stateless scaling, PostgreSQL store, JWKS setup, upgrade path from HS256 and app-keyed credentials; security doc gains the tenancy threat model; Spec 04/05 and SPEC-TRACEABILITY updated.

#### M3 exit checklist

Isolation suite green in CI; load numbers recorded; runbook reviewed; managed shared deployment configuration documented.

---

## Test strategy summary

| Level | Where | What |
|---|---|---|
| Unit | `packages/*/test` | Dispatch, error parsing, catalog view, discovery tools, effect/scope expansion, delegation, store conformance, token signing/verification, safe fetch |
| Contract | `packages/mcp/test`, `packages/gateway/test` | Official MCP SDK client against `createGateway` with fake hosts; HTTP route payloads |
| Integration | PostgreSQL-enabled tests | Postgres store conformance, multi-instance visibility |
| E2E | `test/fixtures/distributed-e2e` | Existing journey extended (M1), OAuth flow (M2), isolation suite (M3) |
| Manual | `docs/guides/mcp-client-support.md` | Dated client/product verification per milestone |

## Phase success criteria

Phase 15 is complete when M3's exit checklist passes, the support matrix lists each target client with a verified connection path, and STATUS records `pnpm verify`, PostgreSQL tests and `pnpm test:e2e` results for the final state.
