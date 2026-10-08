# Phase 15 — Central MCP gateway

**Design:** [central MCP gateway plan](../plans/central-mcp-gateway.md); [ADR 0006](../adr/0006-central-mcp-gateway.md) with Amendment 1. **Status:** accepted (D-07). **Depends on:** P7-01–P7-03, P8-01–P8-03, P10-03. **Coordinates with:** the Embody Cloud hosting plan (`docs/hosting/`, ADR 0007, ADR 0008); see design plan §8 for ownership.

## Objective

Make the Embody gateway the one MCP endpoint people in a company connect to from Claude, Codex, ChatGPT, Cursor and other MCP clients, with:

- a multi-tenant gateway: each **workspace** (a company's account; `orgId` in code) has its own registry, credentials, identity, limits and audit;
- **teams** inside a workspace that own apps, without being a data boundary;
- **single-tenant app deployments**: each belongs to one workspace and is workspace-wide or team-owned;
- a stateless gateway and stateless app hosts;
- apps and the gateway that **sleep when idle** without user-visible errors;
- apps that call other apps inside their workspace;
- the fastest path to a working MVP.

## MVP stages

| Stage | Items | Result |
|---|---|---|
| 0 | P15-00 | Decisions recorded, plans aligned, client behavior known |
| 1. Gateway core | P15-01 – P15-06, P15-08 | Multi-tenant, multi-instance gateway works in token-capable chat clients |
| 2. Sleep | P15-14, P15-15 | Apps and gateway sleep and wake without user-visible errors |
| 3. Workspace safety | P15-09, P15-10, P15-12, P15-11 | Workspaces safely share one gateway |
| 4. Chat products | P15-07 | Claude web/desktop connectors and ChatGPT (OAuth per workspace) |
| 5. Apps call apps | P15-13 | Team apps automate company-wide apps |
| 6. Proof | P15-16 | MVP verified on real Cloud Run |

Stages 2–5 can overlap once stage 1's store (P15-05, P15-08) exists. Load testing and the operations runbook (parts of P15-11) may finish after the MVP.

## Non-goals

Do not build in this phase (see design plan §9): `tools/list_changed` notifications, MCP sessions or per-session state, shared rate-limit store, principal-level team membership, anything cross-workspace (shared deployments, calls or events), app template/plugin distribution, transparent stdio bridge, `embody login`, MCP in `embody dev`, a development authorization server, per-workspace hostnames, app icons, MCP tasks, app-declared prompts/resources, chat GenUI, and the hosting plan's provider-specific work (Cloud Tasks reconciler, version-pinned wake, restore fences, billing).

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

1. `docs/adr/0006-central-mcp-gateway.md`: the decisions in design plan §4 (central MCP in gateway, tenancy, workspace in URL, stateless MCP, compact discovery, delegated agent principal, asymmetric workspace-bound host tokens, OAuth resource server only). Accepted 2026-10-08 with Amendment 1 (workspaces, teams, single-tenant apps that can sleep). Also: align with the hosting plan (renumber its ADRs to 0007/0008, shared terms, ownership table in design plan §8).
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
- Identity provider(s) for stage 4 docs and CI.

### Success criteria

ADR approved; matrix committed with dates and versions; the three decisions above written into this file's P15-03, P15-04 and P15-07 sections.

---

## Stage 1 — gateway core

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

### P15-05: workspace store, routing, teams and app status

**Packages:** `@embody/gateway`, `@embody/host`, `@embody/cli`, `apps/gateway`.

#### Changes

New `packages/gateway/src/store.ts` (the code keeps `orgId` for the workspace):

```ts
export interface WorkspaceConfig {
  readonly orgId: string;
  readonly teams?: readonly { readonly id: string; readonly title?: string }[];
  readonly allowedOrigins?: readonly string[];
  readonly auth?: WorkspaceAuthConfig;  // used by P15-07
  readonly limits?: WorkspaceLimits;    // used by P15-10
}
export interface CredentialBinding {
  readonly orgId: string;
  readonly appId: string;
  readonly teamId?: string;     // set for team-owned apps
}
export interface StoredRegistration extends Registration {
  readonly orgId: string;
  readonly teamId?: string;
  readonly generation: string;
  readonly registeredAt: string;
  readonly lastSeen?: string;          // optional heartbeat timestamp
  readonly status: "ready" | "idle" | "unavailable";
  readonly statusChangedAt: string;
  readonly consecutiveFailures: number;
  readonly nextDueAt?: string;
}
export interface GatewayStore {
  getWorkspace(orgId: string): Promise<WorkspaceConfig | undefined>;
  /** Registration secrets are random and high-entropy; lookup by SHA-256 hash is sufficient. */
  findCredential(secretHash: string): Promise<CredentialBinding | undefined>;
  putRegistration(value: StoredRegistration): Promise<void>; // bumps workspace revision on new app or generation
  touch(orgId: string, appId: string, generation: string, at: string): Promise<"ok" | "missing" | "stale">;
  getRegistration(orgId: string, appId: string): Promise<StoredRegistration | undefined>;
  listRegistrations(orgId: string): Promise<{ revision: number; registrations: readonly StoredRegistration[] }>;
  removeRegistration(orgId: string, appId: string): Promise<void>;
  /** Rate-limited status/due-time update; returns false if the registration is gone. */
  recordOutcome(orgId: string, appId: string, outcome: AppOutcome): Promise<boolean>;
  /** Registrations whose nextDueAt <= now, across workspaces, oldest first, bounded. */
  listDue(now: string, limit: number): Promise<readonly StoredRegistration[]>;
}
export class MemoryGatewayStore implements GatewayStore { /* constructor({ workspaces, credentials, initial }) */ }
```

- `GatewayRegistry` becomes an async façade over a store: `register(body, secret)`, `heartbeat(body, secret)`, `snapshot(orgId)`, `get(orgId, appId)`, `destinations(event)` (filters by `event.orgId`).
- The registration's workspace and team come from the credential binding. An optional `orgId` in the body must match (`403` otherwise).
- **Registrations persist** until removed and do not depend on a running instance. Heartbeats are optional: `heartbeat()` still updates `lastSeen` for always-on hosts, but no status depends on it.
- **App status** is stored on the registration and derived from real calls (P15-14 writes it): `ready` (recent success), `idle` (no recent traffic; the default after registration and after `idleAfter`, default 10 minutes), `unavailable` (three consecutive wake failures). Tools are listed for every status; `embody_apps` and `/api/catalog` show the status. A successful call or a new version restores `ready`.
- **Next due time** (`nextDueAt`) is stored on the registration for P15-14's wake sweep.
- Per-instance catalog cache keyed by workspace revision, at most 2 s old.
- All gateway reads use the principal's workspace: catalog, `/api/catalog`, MCP, dispatch, events.
- **Routing:** client routes (`/api/catalog`, `/api/execute*`, `/mcp`, `/mcp/:appId`) are registered under `/w/:workspace` as a Fastify plugin. `GatewayOptions.defaultWorkspace` also serves them unprefixed. Registration and heartbeat stay unprefixed (the credential decides the workspace). Unknown workspace → `404`; principal workspace ≠ URL workspace → `403`.
- **Teams:** registration metadata and an `embody_apps` / `/api/catalog` field (`team`). Access is still decided by scopes.
- **Legacy config:** `new GatewayRegistry({ credentials: Record<appId, secret> })` is accepted only together with `defaultWorkspace`, binding every credential to that workspace, for one release with a deprecation warning.
- Host: `GATEWAY_ORG_ID` sent in registration and heartbeat. Fix URL joining in `createRegistrationClient` so a `GATEWAY_URL` with a path prefix keeps it.
- CLI: same URL-joining fix for `/api/catalog` and `/api/execute*`, so `--base-url https://gw/w/acme` works.
- `apps/gateway`: build `MemoryGatewayStore` (or Postgres after P15-08) from env.

#### Tests

- Store conformance suite (`packages/gateway/test/store-conformance.ts`) against `MemoryGatewayStore` (Postgres in P15-08): put/get/touch/stale generation/revision bumps/remove.
- Two workspaces, each with `kanban` on different endpoints: each principal sees and calls only its own; the same app ID does not collide.
- A credential for workspace A cannot register into workspace B, including with a forged `orgId`; a team-bound credential cannot change its team.
- A registered app with no heartbeat stays listed as `idle`; three recorded wake failures make it `unavailable` but still listed; a success restores `ready`.
- Routing: `/w/<workspace>` works; unknown workspace and mismatched principal rejected; `defaultWorkspace` serves unprefixed routes.
- Events: `destinations` only returns the event's workspace.
- Legacy constructor works with `defaultWorkspace` and warns; rejected without it.
- Host and CLI URL joining with and without path prefixes.

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

### Stage 1 exit checklist

- P15-01 – P15-06 and P15-08 `DONE`.
- E2E topology: two workspaces, each with its own Kanban deployment, two gateway instances on the PostgreSQL store behind a round-robin proxy.
- E2E journey extended: MCP discovery (`embody_apps`), compact call path, veto message, delegated actor, workspace isolation of catalogs and calls.
- Manual verification in Claude Code and Codex with a token, recorded in `mcp-client-support.md`.
- Docs: `docs/agent-integrations/` guides for Claude Code, Codex, Cursor; Spec 05 updated (workspace URLs, compact discovery, stateless, error format).

---

## Stage 4 — chat products

### P15-07: OAuth resource server per workspace

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

  Principals from OAuth tokens: `orgId` = the URL's workspace (never from the token alone; the token's issuer must be that workspace's issuer), `actorType: "human"` (then delegated by P15-06 on MCP), scopes = union of `scopeMap` entries for granted scopes and roles.
- Effect-aware scope patterns: `scopeAllows(principal, appId, target, effect)` accepts `@read` (any read target, all apps) and `<app>:@read`. Before issuing the gateway token, the gateway **expands** effect patterns into concrete per-target scopes for the target app, so app hosts' kernels need no change.
- Routes:
  - `GET /.well-known/oauth-protected-resource/w/:workspace/mcp` (RFC 9728 path form) and, when `defaultWorkspace` is set, `GET /.well-known/oauth-protected-resource/mcp`: `{ resource, authorization_servers: [issuer], scopes_supported, bearer_methods_supported: ["header"] }`.
  - MCP routes: missing or invalid token → `401` with `WWW-Authenticate: Bearer resource_metadata="<url>", scope="<supported>"`. Insufficient scope on a call → MCP tool error **and**, for the HTTP request, `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<needed>"` when the whole request is unauthorized.
  - Audience check: token `aud` must contain the org's audience.
- The auth chain per workspace: OAuth provider for that workspace first, then API keys (unchanged).
- `apps/gateway`: env `GATEWAY_PUBLIC_URL`, `GATEWAY_OIDC_ISSUER`, `GATEWAY_OIDC_AUDIENCE`, `GATEWAY_OIDC_SCOPE_MAP` (JSON).

#### Tests

- Metadata JSON matches RFC 9728 fields; URLs absolute and correct behind a `publicUrl` with a path.
- Challenges: no token, malformed token, wrong issuer, wrong audience, expired, another workspace's issuer → `401` with header; under-scoped → `403` with `insufficient_scope`.
- `@read` permits list/get, denies create/update/delete; expanded scopes accepted by the real Kanban host kernel.
- CI: a local test identity provider (choice from P15-00, e.g. a containerized OIDC server) issues tokens; MCP Inspector CLI or SDK client completes the authorization code + PKCE flow in the E2E stack.

#### Stage 4 exit checklist

Claude web/desktop custom connector and ChatGPT connector verified against the gateway with OAuth, recorded in the support matrix; setup guide for the chosen identity provider; agent-integration guides for both products.

---

## Stage 2 — sleep

### P15-14: sleep-safe gateway

**Packages:** `@embody/gateway`, `@embody/mcp`, `apps/gateway`, docs.

#### Changes

- **Wake-tolerant dispatch** around the host call in the shared dispatch pipeline:
  - `wakeBudgetMs` per workspace or app (default 30,000).
  - **Not-delivered** failures: `ECONNREFUSED`, `ENOTFOUND`/`EAI_AGAIN`, a socket reset before any request bytes were written, or a platform `503`/`429` without an Embody error envelope. Retry with backoff (250 ms doubling, max 5 s) until the budget ends.
  - **Ambiguous** failures (after request bytes were sent): retry only when `actionEffect(action) === "read"` or `action.idempotent === true`. Otherwise return `UNAVAILABLE` with "Outcome unknown: <app> may or may not have completed this. Check before retrying." and `_meta["embody/outcome"] = "unknown"`.
  - When the client supplied a progress token, emit "Starting <app title>…" on the first retry and every 5 s, so MCP clients that reset timeouts on progress keep waiting.
  - Budget exhausted: `UNAVAILABLE`, "<app title> did not start. Try again in a minute."
- **Status recording** through `GatewayStore.recordOutcome` (rate-limited per app): success → `ready`, `consecutiveFailures = 0`; wake failure → `consecutiveFailures + 1`, `unavailable` at 3; `ready` → `idle` is computed on read after `idleAfter`. Tools are never removed for status.
- **Next due time:** read `x-embody-next-due` (ISO timestamp or `none`) from every host response and wake response; store as `nextDueAt`.
- **Wake sweep:** `POST /internal/wake-due`, authenticated with a dedicated scheduler credential (not a user token), unprefixed, not exposed through MCP. It lists due registrations (`listDue`, bounded batch, default 50), calls each app's `POST /embody/wake` with a 60-second system token for that app (`actorType: "system"`, `actorId: "embody:scheduler"`) with bounded concurrency (default 10), and records outcomes. Idempotent and safe to run concurrently (per-registration lease in the store, 2 minutes).
- **Daily safety wake:** the same endpoint with `?safety=1` wakes every registration with a successful call in the last 30 days and no wake in the last 24 hours, bounding the impact of a lost due-time hint.
- **Cold-start-safe gateway:** startup reads configuration only; catalog and registrations load lazily per request; a store failure returns `UNAVAILABLE` ("Embody is temporarily unavailable"), never an empty or permissive catalog. No gateway-owned timers in sleep-capable deployments; the optional durable relay (P7-04) is disabled or driven by the same scheduler.
- `apps/gateway`: `GATEWAY_SCHEDULER_TOKEN`, `GATEWAY_WAKE_BUDGET_MS`; docs for Cloud Scheduler (cron elsewhere) calling `/internal/wake-due` every minute and `?safety=1` daily.

#### Tests

- Fake host that refuses connections for N seconds then succeeds: the call succeeds within budget; progress notifications emitted; status `ready`.
- Not-delivered vs ambiguous: a write whose connection drops after sending is **not** retried and returns "outcome unknown"; the same failure on a `read` or `idempotent` action is retried and succeeds. An effect ledger shows exactly one write.
- Budget exhausted: clear message; three in a row → `unavailable`, still listed; next success → `ready`.
- `tools/list`, `embody_apps` and `embody_describe` against a workspace whose hosts are all stopped make **no** host requests.
- Wake sweep: due apps called once even with two concurrent sweeps; non-due apps not called; `nextDueAt` updated from responses; the safety wake covers an app whose hint was lost.
- Gateway process replaced between list and call (same store): the call succeeds. Store outage: fail closed.

### P15-15: host sleep mode

**Packages:** `@embody/host`, `@embody/core` (outbox/workflow worker APIs), `@embody/cli`, `@embody/testing`, `create-embody-app`, examples, docs.

#### Changes

- `EMBODY_RUNTIME=sleep|always-on` (`createAppHost` option `runtime`). Default `always-on` locally and self-hosted; hosted templates set `sleep`.
- **Sleep mode:** `start()` launches no heartbeat, outbox, delivery or workflow intervals. Registration at startup is idempotent and non-blocking (retried on the next cold start, or done by deploy-time `embody register`). No migrations or business work at startup.
- **Events before response:** after a request's transaction commits, run a bounded `drainOutbox({ deadlineMs: 2_000, maxItems: 50 })` for that request's events and attempt their deliveries before sending the response. Undelivered items stay in the database with their retry time.
- **Bounded work API:** `tickEvents()`/`tickWorkflows()` gain `{ deadlineMs, maxItems, signal }` and return `{ processed, nextDueAt }`, using the existing database leases.
- **Wake endpoint:** `POST /embody/wake`, gateway-token authenticated and limited to the scheduler system principal. Runs bounded due work (outbox, deliveries, workflow steps) within 50 s and returns `{ nextDueAt }` plus the `x-embody-next-due` header.
- **Next due header** on every response in sleep mode: the earliest pending outbox, delivery retry or workflow step time, from one indexed query.
- **Readiness check:** in sleep mode, `createAppHost` fails fast with an explanation if the app uses SQLite, declares custom intervals, or a plugin sets `requiresAlwaysOn: true`.
- `embody register` CLI command for deploy pipelines.
- Testing: `@embody/testing` gains `harness.sleep()` / `harness.wake()` helpers that drop process state and run the wake path.

#### Tests

- Sleep mode schedules no timers (fake timers assert none); always-on behavior unchanged.
- A request that publishes an event delivers it before responding; with the receiver down, the event stays due and `x-embody-next-due` reports its retry time.
- The wake endpoint processes due outbox items, deliveries and workflow steps within budget and reports the next due time; it rejects calls without the scheduler principal.
- Process killed after commit and before the response: the next wake finds the work; it runs under the existing at-least-once and idempotency contract.
- Readiness check rejects SQLite and always-on plugins with clear messages.

## Stage 6 — proof

### P15-16: MVP proof on Cloud Run

**Packages:** `scripts/cloud-proof/`, docs. Uses the hosting plan's Cloud Run baseline in its simplest form; does not implement hosting provisioning.

#### Deliverables

1. Deploy the gateway (min instances 0) and two workspaces' Kanban and Email (sleep mode, min instances 0) on Cloud Run with Cloud SQL, and Cloud Scheduler calling `/internal/wake-due` every minute and `?safety=1` daily.
2. Record from Cloud Run metrics that every service reaches zero instances without traffic, and that the scheduler wakes only apps with due work.
3. From a real MCP client: discovery with all apps asleep wakes nothing; a call wakes only its app; gateway-only cold and gateway+app cold latency (p50/p95 over 20 runs); a Kanban event wakes Email; a delayed workflow step runs within two minutes while every service is asleep.
4. Failure checks: an app stopped permanently gives a clear error and becomes `unavailable` after three tries; killing the gateway mid-call gives a clear client error and no duplicate write.
5. Record results and measured defaults (wake budget, sweep interval) in `docs/guides/mcp-client-support.md` and the design plan.

---

## Store, tokens and workspace safety (stages 1 and 3)

### P15-08: PostgreSQL `GatewayStore` (stage 1)

**Packages:** `@embody/gateway` (subpath export `@embody/gateway/postgres`, `pg` as optional peer dependency), `apps/gateway`.

#### Changes

Migrations (own table `embody_gateway_migrations`, same pattern as `@embody/storage`):

```sql
CREATE TABLE gateway_workspaces (
  org_id TEXT PRIMARY KEY,                 -- the workspace (tenant)
  config JSONB NOT NULL,                   -- identity, scope policy, limits, teams, origins
  revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE gateway_app_credentials (
  secret_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES gateway_workspaces(org_id),
  app_id TEXT NOT NULL,
  team_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE TABLE gateway_registrations (
  org_id TEXT NOT NULL REFERENCES gateway_workspaces(org_id),
  app_id TEXT NOT NULL,
  team_id TEXT,
  version TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  health_check_url TEXT NOT NULL,
  manifest JSONB NOT NULL,
  generation TEXT NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ,                   -- optional heartbeat
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('ready', 'idle', 'unavailable')),
  status_changed_at TIMESTAMPTZ NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  next_due_at TIMESTAMPTZ,
  last_wake_at TIMESTAMPTZ,
  wake_lease_until TIMESTAMPTZ,
  PRIMARY KEY (org_id, app_id)
);
CREATE INDEX gateway_registrations_due ON gateway_registrations (next_due_at)
  WHERE next_due_at IS NOT NULL;
```

- `putRegistration`: upsert in one transaction; increment `gateway_workspaces.revision` when the app is new or `generation` changed; a new generation resets status to `ready` and failures to 0.
- `touch` (optional heartbeat): `UPDATE … SET last_seen = $at WHERE org_id = $1 AND app_id = $2 AND generation = $3`; zero rows → check existence to return `missing` or `stale`.
- `recordOutcome`: single-row update; skips the write when nothing changed and the last write is under a minute old.
- `listDue`: `SELECT … WHERE next_due_at <= now() AND (wake_lease_until IS NULL OR wake_lease_until < now()) ORDER BY next_due_at LIMIT $n FOR UPDATE SKIP LOCKED`, then set `wake_lease_until`, so concurrent sweeps never wake the same app twice.
- `listRegistrations`: one query joining revision.
- Admin script `apps/gateway/src/admin.ts` (`pnpm --filter @embody/app-gateway admin …`): `workspace create <id>`, `workspace set-auth <id> <json>`, `credential issue <workspace> <appId> [--team <team>]` (prints the secret once), `credential revoke <workspace> <appId>`. Uses the database directly; never exposed over HTTP.
- `apps/gateway`: `GATEWAY_STORE=postgres` + `GATEWAY_DATABASE_URL`.

#### Tests

- Store conformance suite against real PostgreSQL 16 (enabled like existing PostgreSQL tests).
- Two gateway processes on one database: registration on one is visible on the other within the cache window; restart loses nothing.
- Revoked credential cannot register or heartbeat.
- Two concurrent `listDue` sweeps lease disjoint registrations; an expired lease becomes due again.

---

### P15-09: asymmetric, workspace-bound gateway tokens (stage 3)

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
- Gateway refuses HS256 unless it serves a single workspace (`defaultWorkspace` set and no other workspaces); then it logs a deprecation warning.
- `apps/gateway`: `GATEWAY_SIGNING_KEYS` (JSON array of `{ kid, privateKeyPem, active }`), loaded at startup; documented KMS/secret-manager integration.

#### Tests

- Host rejects: other workspace, other app, unknown `kid`, HS256 when configured for JWKS, expired, wrong issuer.
- Rotation: add key B inactive → publish → flip active → remove A after max token lifetime; calls succeed throughout.
- E2E compose switches to ES256 + JWKS.

---

### P15-10: endpoint safety and per-workspace limits (stage 3)

**Packages:** `@embody/gateway`, `apps/gateway`.

#### Changes

- Safe fetch: `createSafeFetch({ allowPrivate })` using an undici `Agent` with a `connect.lookup` that resolves, rejects any blocked address (reuse `blockedHost` rules for IPv4/IPv6, plus IPv4-mapped IPv6), and connects only to the validated address. Use it for dispatch and health checks. Redirects disabled (`redirect: "error"`). Multi-tenant gateways force `allowPrivate: false` unless an operator allows private endpoints for a specific workspace (for example one whose apps run in a private network the gateway can reach); registration also validates DNS.
- Per-workspace allowed origins from `WorkspaceConfig.allowedOrigins`.
- `WorkspaceLimits` with defaults: `maxApps: 200`, `maxCatalogTools: 1,000`, `requestsPerMinute: 600` (per workspace per instance), `requestsPerMinutePerActor: 120`, `maxConcurrentCalls: 50` (per workspace per instance). Exceeding → `RATE_LIMITED` / registration `409` with clear messages.
- Durable event relay (P7-04) and direct delivery use workspace-filtered `destinations` (from P15-05); add a workspace check to the relay path.

#### Tests

- DNS rebinding fixture (resolver returns public then private address) blocked at connect; private IP and `localhost` registration rejected unless allowed for that workspace; redirects refused.
- Workspace A at its limits does not affect workspace B's calls.
- Events from workspace A never reach workspace B's subscriber with the same app ID.

---

### P15-11: isolation gate and production readiness (stage 3; load test and runbook may follow the MVP)

**Packages:** test fixtures, docs, `apps/gateway`.

#### Deliverables

1. **Cross-workspace suite** `test/fixtures/distributed-e2e/isolation.mjs` (release-blocking, runs in `pnpm test:e2e`) with two orgs, both running Kanban:
   - workspace A token on workspace B URL (HTTP and MCP) → rejected;
   - guessed app IDs and targets via `embody_describe`, `embody_read`, `/api/catalog` → no leakage, identical not-found responses;
   - workspace A registration credential against workspace B → rejected;
   - host of workspace B rejects a validly signed token for workspace A;
   - events stay within org;
   - audit records carry the correct org;
   - catalog cache never serves one org's catalog to another (alternating requests under load).
2. **Load test** (`scripts/load/gateway-mcp.mjs`): 100 orgs × 10 apps × 15 tools on PostgreSQL store, two instances; record p50/p95 for `tools/list` (compact and full) and calls in `docs/production/06-performance-baseline.md`.
3. **Operations:** runbook entries in `docs/production/04-operations-runbook.md` (org provisioning, credential issue/revoke, signing key rotation, draining an instance, identity provider outage); metrics (requests/errors by org, surface, code; OAuth challenges; registrations; heartbeat lag; catalog cache hit rate) exposed through the existing observability approach; suggested alerts.
4. **Docs:** self-hosting guide gains workspaces and teams, sleep mode, stateless scaling, PostgreSQL store, JWKS setup, upgrade path from HS256 and app-keyed credentials; security doc gains the tenancy threat model; Spec 04/05 and SPEC-TRACEABILITY updated.

#### Stage 3 exit checklist

Isolation suite green in CI, including workspaces whose apps are asleep. Load numbers and runbook may follow the MVP.

---

## Single-tenant hosts (stage 3) and app-to-app calls (stage 5)

### P15-12: stateless, single-tenant app hosts (stage 3)

**Packages:** `@embody/host`, `@embody/auth`, examples, E2E fixtures, docs.

#### Changes

- Production hosts require `GATEWAY_ORG_ID`; the gateway token verifier rejects tokens whose `orgId` differs (`UNAUTHENTICATED`, value-free message). Development keeps working without it.
- Registration from N replicas (or repeated cold starts) is idempotent: same `PUBLIC_URL`, same generation. Document that `PUBLIC_URL` must be the load-balanced URL, never a per-pod address.
- Confirm no request depends on in-process state: worker leases in the database (already), SSE streams per request (already); add a check that production refuses SQLite (already) and document the stateless contract for plugin authors (no module-level caches of workspace data).
- E2E: replace "two workspaces share one Kanban deployment" with one Kanban deployment per workspace; run one of them with two replicas.
- Docs: deployment guide section "one deployment per workspace, many replicas".

#### Tests

- Host rejects a valid token for another workspace; accepts its own.
- Two host replicas register against one gateway store without conflicts; killing one replica, or both (asleep), keeps the app listed and callable.
- E2E passes on the new topology.

### P15-13: app-to-app calls within a workspace (stage 5)

**Packages:** `@embody/core` (context API), `@embody/host`, `@embody/gateway`, docs, a reference example.

#### Changes

- Each registration gets an **app identity**: a system principal `{ actorType: "system", actorId: "app:<appId>" }` in its workspace, with scopes granted per app by the workspace's configuration (for example `crm:crm.task.create`).
- Handlers call other apps through a typed context API, for example `context.apps.call("crm", "crm.task.create", input, { signal })`, which goes to the gateway with the host's registration credential and request context; the gateway authenticates the app, applies the shared dispatch pipeline (workspace check, scopes, rate limit, wake handling from P15-14, audit with `surface: "app"`), and issues a normal gateway token to the target host. A sleeping target is woken like any other call.
- Calls never leave the workspace. Delegation is preserved when an agent's call triggers the automation (`delegation` from the originating request is carried, `actorType` stays `system`).
- Loop protection: a bounded call depth (default 4) carried in the request context.
- Reference: a small automation app that subscribes to a CRM-like event and calls back into it.

#### Tests

- Allowed call succeeds and is audited with surface and both app identities; unscoped call → `FORBIDDEN`; cross-workspace target → `NOT_FOUND`.
- Target hooks see the calling app identity.
- Call depth limit enforced; cancellation propagates.

---

## Test strategy summary

| Level | Where | What |
|---|---|---|
| Unit | `packages/*/test` | Dispatch, error parsing, catalog view, discovery tools, effect/scope expansion, delegation, store conformance, wake/retry classification, token signing/verification, safe fetch |
| Contract | `packages/mcp/test`, `packages/gateway/test` | Official MCP SDK client against `createGateway` with fake hosts, including stopped and slow-starting hosts |
| Integration | PostgreSQL-enabled tests | Postgres store conformance, multi-instance visibility, due-work leases |
| E2E | `test/fixtures/distributed-e2e` | Journey extended (stage 1); sleep simulator in which app containers are stopped and a test proxy starts them on first connection (stage 2); isolation suite (stage 3); OAuth flow (stage 4); app-to-app automation (stage 5) |
| Cloud | `scripts/cloud-proof/` | P15-16 on real Cloud Run |
| Manual | `docs/guides/mcp-client-support.md` | Dated client/product verification |

## MVP success criteria

The MVP is complete when stages 1–6 pass their tests, P15-16's Cloud Run proof is recorded, the support matrix lists each target client with a verified connection path, and STATUS records `pnpm verify`, PostgreSQL tests and `pnpm test:e2e` results for the final state.
