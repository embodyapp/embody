# Central MCP gateway: one connection to every Embody app

**Status: proposal, not implemented.** Written 2026-10-08 against `main` at `3f44ab7`. Proposed phase IDs use `P15-xx`; nothing is claimed in [STATUS.md](../implementation-plan/STATUS.md) until the ADR in P15-00 is approved.

**Related:** [ADR 0001](../adr/0001-phase-1-stack-and-package-boundaries.md) (package boundaries), [ADR 0005](../adr/0005-generative-ui-presentation.md) (GenUI), [Phase 7](../implementation-plan/07-gateway.md), [Phase 8](../implementation-plan/08-mcp-and-cli.md), [Spec 04](../specs/04-pluggable-auth-identity.md), [Spec 05](../specs/05-client-surfaces-cli-mcp.md), [self-hosting](../production/07-self-hosting-the-gateway.md). A companion plan for chat UI ("Plan B: chat GenUI") builds on this one; see [§9](#9-relationship-to-the-chat-genui-plan-and-phase-14).

---

## 1. Summary

An organization running ten Embody apps should connect Claude Desktop, Claude web, Claude Code, Codex, ChatGPT, Cursor or any MCP client **once**, to the Embody gateway, and be able to discover, use and safely change every app it is authorized for. New apps should appear without client changes, redeploys should not break open sessions, the agent should get actionable errors, and guardrails written for agents must still apply when a human connects through a chat product.

The gateway already aggregates apps behind `/mcp`. This plan turns that aggregate endpoint into a product-quality central MCP server by fixing gaps at every layer of the framework, not just the MCP adapter:

| Layer | Main change |
|---|---|
| `@embody/core` | App display metadata, action effect metadata, delegated principal |
| `@embody/host` | Publish new metadata, carry delegation into handlers and audit |
| `@embody/gateway` | One dispatch pipeline (auth, scope, limit, audit, errors) for HTTP, stream and MCP; registry change feed; OAuth resource server |
| `@embody/mcp` | Progressive discovery, tool annotations, structured results, list-change notifications, session store and limits |
| `@embody/cli` | Transparent stdio bridge, OAuth-aware login, single-app MCP in `embody dev` |
| Docs / scaffolder | Per-client connection guides, generated metadata defaults |

Nothing here changes how an app's business logic is written. Every call still goes through ordinary Embody execution with the same validation, hooks, events and tenant isolation.

---

## 2. Goal and definition of done

### User journeys

1. **Connect once.** A user adds one URL (`https://gateway.example.com/mcp`) to their client. Chat products complete an OAuth sign-in; developer tools may instead use a token. No per-app configuration.
2. **Discover.** The user asks "what can you do in Embody?" The agent lists the apps the user can access, with human-readable names and descriptions, without loading hundreds of tool schemas.
3. **Use.** The user asks for something in one app. The agent loads that app's tools and calls them. Reads do not trigger approval prompts on clients that honor annotations; destructive actions do.
4. **Recover from a rule.** A guardrail vetoes a change. The agent sees the guardrail's message and validation details, not "Tool execution failed", and can ask the user for what is missing.
5. **Change underneath.** An app is deployed, redeployed or goes unhealthy during a session. The client is notified, the tool list updates, and calls to an unavailable app get a clear "temporarily unavailable" answer.
6. **Stay governed.** Every MCP call is authenticated, scope-checked, rate-limited and audited exactly like an HTTP call, with both the human and the client recorded.
7. **Develop locally.** An app developer can point Claude Code or Codex at `embody dev` and try the app in chat without running a gateway.

### Done means

- The journeys above pass in an automated multi-app E2E suite with official MCP SDK clients that declare different capability combinations.
- A dated support matrix records which journeys were manually verified on which client product and version. As in Phase 14, no client support is inferred from its name.
- Existing HTTP, CLI, event and workflow behavior is unchanged except where this plan explicitly fixes a defect (audit and error mapping).

---

## 3. Decision: the gateway is the central MCP server

### Options considered

| Option | Verdict |
|---|---|
| **A. One MCP server per app** (each app host exposes its own `/mcp`) | Rejected as the default. Ten client entries and ten OAuth consents per client product; no cross-app requests; duplicates auth, audit and limits in every host; per-app UI drifts. Still useful as a filtered view (below). |
| **B. A separate "MCP edge" service** in front of the gateway | Rejected for now. It would duplicate the registry, catalog, auth and dispatch or call back into the gateway for each, adding a network hop and a second auth boundary. Keep the option open by keeping MCP logic in `@embody/mcp`. |
| **C. Client-side aggregation** (the CLI bridge merges per-app servers) | Rejected. Only works for local stdio clients; chat products connect to remote URLs. |
| **D. The existing gateway serves `/mcp` for all apps** | **Chosen.** The gateway already owns the registry, health, authentication, scopes, the token exchange to app hosts, progress relay, audit and rate limits. |

### Boundaries that keep the gateway generic

1. **Domain code never runs in the gateway.** Descriptions, schemas and (later) presentation documents come from app hosts. The gateway routes, authorizes, relays and records.
2. **MCP and session logic live in `@embody/mcp`.** The gateway supplies collaborators (catalog, dispatch, session store, change feed). `McpHttpHandler` already takes `catalog` and `execute` as options; this plan extends that seam rather than growing `gateway/src/index.ts`.
3. **The gateway is an OAuth resource server, not an authorization server.** Production sign-in stays with the identity provider it already trusts through `oidcProvider`. Only local development gets a small built-in authorization server.
4. **`/mcp/:appId` remains as a filtered view of the same server.** It shares auth, sessions and behavior. Access is still limited by scopes on the token, not by URL. This matches the existing self-hosting guidance: "An app-scoped MCP URL reduces catalog size but does not replace scope enforcement."

---

## 4. Current state on `main`

### What already works

- `GET/POST/DELETE /mcp` and `/mcp/:appId` on the official SDK's Streamable HTTP transport, sessions pinned to `orgId:actorId` and endpoint ([gateway/src/index.ts:486](../../packages/gateway/src/index.ts), [mcp/src/index.ts:108](../../packages/mcp/src/index.ts)).
- Catalog of healthy apps with deterministic `app__target` names, collision rejection at registration, and per-principal filtering through `scopeAllows`.
- Execution through `/execute/stream` with a short-lived audience-bound gateway JWT. The client token is never passed through to app hosts, which is what the MCP authorization spec requires.
- Progress relayed to `notifications/progress`; cancellation propagated.
- `tools/list` is recomputed per request, so new apps appear on the next list.

### Gaps, by layer

**Execution and results**

| # | Gap | Evidence | Effect |
|---|---|---|---|
| E1 | All app errors become `"Tool execution failed"`. | `remoteEvents` yields a fixed message for every `error` frame and for non-OK responses. | Hook vetoes and validation details never reach the agent. [Connecting Claude Desktop](../agent-integrations/02-claude-desktop.md) promises the agent will read the veto message; today it cannot. |
| E2 | MCP calls bypass audit and rate limiting. | Only `POST /api/execute/:appId/:target` calls `audit.append` and `options.limiter`. `/api/execute/stream` and MCP do neither. | The busiest agent surface is ungoverned. Contradicts the audit requirements in self-hosting docs. |
| E3 | Results are JSON text only. | `mcpResult` returns `JSON.stringify(value)`; tools have no `outputSchema`; no `structuredContent`. | Clients cannot validate or display structured output; every result costs tokens as escaped JSON. |
| E4 | An unhealthy app disappears from the list; calls fail generically. | `catalogFor` filters `status === "healthy"`. | Agents cannot tell "gone" from "temporarily down". |

**Catalog and discovery**

| # | Gap | Evidence | Effect |
|---|---|---|---|
| C1 | Every authorized tool of every app is listed at once. | `createMcpCatalog` without a scope. | Ten apps at 10–20 tools each is 100–200 schemas in context before the user says anything. Tool selection quality drops and some clients cap tool counts. |
| C2 | No app-level metadata. | `AppManifest` has plugins, entities, actions, workflows, subscriptions; no title, description, icon or usage notes. | Nothing to build an app list, server instructions or a launcher from. |
| C3 | No action effect metadata, so no tool annotations. | `ActionManifest` has no read/write/destructive signal. | Clients cannot distinguish reads from deletes; approval prompts fire for everything or "always allow" covers destructive actions. |
| C4 | `listChanged: true` is advertised but never sent. | No `sendToolListChanged` anywhere. | Clients that cache tool lists stay stale until reconnect. |
| C5 | No server `instructions`, no tool titles or icons. | `new Server({ name: "embody", version: "0.0.0" })`. | Clients get no guidance about Embody conventions (prefixes, discovery, errors). |

**Identity and authorization**

| # | Gap | Evidence | Effect |
|---|---|---|---|
| A1 | No MCP authorization discovery. | Bearer token only; no protected-resource metadata, no `WWW-Authenticate` challenge. | Claude web/desktop custom connectors and ChatGPT cannot connect; only clients that can send a static header (Claude Code, Codex, Cursor, CLI bridge) can. |
| A2 | No delegation in the principal. | `Principal` is `{ orgId, actorId, actorType, roles, scopes, metadata? }`. | When a human signs in through a chat product, the token says `actorType: "human"` while a model is choosing the calls. Agent-only guardrails, such as Kanban's PR rule (`context.principal.actorType === "agent"`), would silently stop applying. This is the most important framework-level issue in this plan. |
| A3 | Scopes are internal strings only. | `app:target`, `app:*`, `*`. | There is no mapping from OAuth scopes a client requests to Embody scopes, and no step-up when a call needs more. |

**Sessions and operations**

| # | Gap | Evidence | Effect |
|---|---|---|---|
| S1 | MCP sessions are process memory. | `McpHttpHandler.sessions` map. | More than one gateway instance requires sticky routing on `mcp-session-id`; restarts drop sessions. |
| S2 | No limits on sessions or open streams. | No caps or idle expiry. | One principal can exhaust memory or sockets. |
| S3 | The registry is process-local. | `GatewayRegistry` holds a map; HA is left to operators ([self-hosting](../production/07-self-hosting-the-gateway.md)). | With several instances, each sees only the apps that heartbeat to it, so catalogs differ by instance. A central MCP endpoint makes this visible to every user. |

**Clients and developer experience**

| # | Gap | Evidence | Effect |
|---|---|---|---|
| D1 | The stdio bridge forwards only `tools/list` and `tools/call`. | [cli/src/mcp-bridge.ts](../../packages/cli/src/mcp-bridge.ts) | Resources, prompts, list-change notifications, elicitation and client capabilities are dropped. Claude Desktop through the documented bridge gets less than a direct connection would. |
| D2 | Only Claude Desktop, Cursor/Cline and custom agents are documented. | [docs/agent-integrations](../agent-integrations/) | No guides for Claude Code, Codex, Claude web or ChatGPT. |
| D3 | `embody dev` has no MCP endpoint. | Inspector exposes JSON manifest/execute only. | App developers must run the full gateway stack to try their app in a chat client. |
| D4 | Long-running workflows are plain tool calls. | Workflow controls are ordinary generated actions. | Acceptable now; MCP tasks are a later improvement ([§8.6](#86-later-not-in-this-plan)). |

---

## 5. Target design

### 5.1 Request path

```text
MCP client (Claude, Codex, ChatGPT, Cursor, CLI bridge)
   │  Streamable HTTP + OAuth access token or API key
   ▼
Gateway
   ├─ Authenticate → Principal (+ delegation)          @embody/gateway  (auth chain)
   ├─ MCP session (identity-pinned, store-backed)       @embody/mcp      (McpHttpHandler)
   │    ├─ discovery tools / app tools / list changes   @embody/mcp      (catalog view)
   │    └─ tools/call ───────────────┐
   └─ Dispatch pipeline  ◀───────────┘  shared with /api/execute and /api/execute/stream
        scope check → rate limit → gateway JWT → app host /execute/stream
        → progress relay → result/error mapping → audit
   ▼
App host (ordinary kernel execution: validation, hooks, storage, events)
```

### 5.2 Responsibilities by package

| Package | Owns | Must not own |
|---|---|---|
| `@embody/core` | Manifest types and compiler (new metadata fields), `Principal` incl. delegation, error envelope | Transport or MCP concepts |
| `@embody/host` | Publishing metadata at registration; verifying gateway JWT incl. delegation claims; exposing `context.principal.delegation` to handlers and audit | Client-facing auth |
| `@embody/gateway` | Registry + change feed, auth chain + OAuth resource server, dispatch pipeline, audit, limits, composition of `@embody/mcp` | MCP protocol details, domain logic |
| `@embody/mcp` | MCP sessions, catalog views, discovery tools, annotations, result/error mapping to MCP, list-change emission, session limits | Authentication decisions, registry storage |
| `@embody/cli` | Transparent stdio bridge, `embody login`, `embody dev` MCP endpoint | Separate catalog logic (reuse `@embody/mcp`) |
| `@embody/auth` | Unchanged API; delegation-aware principal helpers if needed | |

### 5.3 Manifest additions (core)

All fields are optional and additive, so manifest `protocolVersion` stays `1` and old hosts keep registering.

```ts
// App level (new optional `app` block in AppManifest)
interface AppPresentationMetadata {
  readonly title?: string;          // "Kanban"; default: appId in title case
  readonly description?: string;    // ≤ 500 chars, plain text
  readonly instructions?: string;   // ≤ 2 KiB, usage notes for agents
  readonly icon?: { readonly src: string; readonly mimeType: string }; // https or data: URI, size-bounded
}

// Action level (ActionManifest)
type ActionEffect = "read" | "write" | "destructive";
interface ActionManifest {
  // ...existing fields
  readonly title?: string;
  readonly effect?: ActionEffect;    // generated CRUD sets this; custom actions declare it
  readonly idempotent?: boolean;
}
```

Rules:

- Generated entity actions set effects automatically: `get`/`list` → `read`; `create` → `write`; `update` → `write` + `idempotent`; `delete` → `destructive`. Workflow controls: `status` → `read`, `start`/`retry` → `write`, `cancel` → `destructive`.
- Custom actions without `effect` are treated as `write` (not read-only) everywhere. This is the safe default.
- `defineApp` / `createAppHost` accept `title`, `description`, `instructions`, `icon`. `create-embody-app` scaffolds them.
- Registration validates sizes and plain-text content. Icons are size-bounded and must be `https:` or `data:` with an allowed image MIME type.
- Instructions are app-authored trusted text but are still bounded and stripped of control characters, because they are placed into model context.

### 5.4 Catalog views and progressive discovery (mcp)

Each MCP session has a **catalog view**: which apps' tools it currently lists.

**Exposure modes**

| Mode | Lists | Default for |
|---|---|---|
| `full` | Every authorized tool (today's behavior) | `/mcp/:appId`; `/mcp` when the authorized tool count is at or below a threshold (default 40) |
| `progressive` | Discovery tools plus tools of *activated* apps | `/mcp` above the threshold |

Overrides: `?tools=full|progressive` on the URL, and `?apps=kanban,email` to pre-activate apps (a convenience filter, not a permission boundary). The threshold is a gateway option.

**Discovery tools** (always present on `/mcp`, reserved `embody_` prefix; registration rejects an app ID of `embody`):

| Tool | Annotations | Input | Output |
|---|---|---|---|
| `embody_apps` | read-only | `{}` | Authorized apps: `appId`, `title`, `description`, `status` (healthy/unavailable), tool count, whether active in this session |
| `embody_use_app` | read-only, idempotent | `{ appId }` | Activates the app for this session, emits `notifications/tools/list_changed`, returns the app's tool names, titles, effects and instructions |
| `embody_describe` | read-only | `{ appId, target? }` | Input/output schemas and descriptions for one app or one target, for clients that ignore list changes |
| `embody_read` | read-only | `{ appId, target, input }` | Dispatches a target whose effect is `read`; rejects anything else |
| `embody_write` | destructive | `{ appId, target, input }` | Dispatches a `write` or `destructive` target |

Why two generic call tools: clients approve per tool name. A single `embody_call` would let one "always allow" cover deletes. Splitting by effect keeps approvals meaningful. Both go through the same dispatch pipeline and scope checks as named tools.

**Why both list changes and generic calls:** MCP clients do not declare whether they honor `tools/list_changed`, so the server cannot know. Clients that refresh get real named tools with annotations after `embody_use_app`; clients that do not can still complete the task with `embody_describe` plus `embody_read`/`embody_write`. The P15-00 spike records which clients do what.

**Names are stable across modes.** An activated app's tools have the same `app__target` names they have in `full` mode, so prompts, approvals and docs do not depend on the mode.

**Budgets.** `tools/list` responses are bounded (default 256 KiB). If `full` mode would exceed the budget, the session falls back to `progressive` and says so in `instructions`.

### 5.5 Tool metadata and results (mcp)

- `title` from action `title` or a humanized target; `description` from the manifest; `icons` from app metadata.
- `annotations`: `readOnlyHint` for `read`; `destructiveHint` for `destructive`; `idempotentHint` from `idempotent`; `openWorldHint: false` unless the action declares otherwise.
- `outputSchema` from `ActionManifest.outputSchema` when it is an object schema. Results then carry `structuredContent` plus a short text `content` (compact JSON, or later a GenUI text rendering from Plan B).
- Server `instructions` at initialize: a fixed Embody section (naming, discovery tools, how errors look) followed by bounded per-app `instructions` for apps active in the session.

### 5.6 Error mapping (gateway + mcp)

The app host already produces a sanitized public envelope through `toErrorEnvelope`. The gateway should relay it instead of replacing it.

| Code | MCP result | Text shown to the agent |
|---|---|---|
| `VALIDATION_ERROR` | `isError: true`, `structuredContent.error` with `details` | Message plus each issue path and message |
| `HOOK_VETO` | `isError: true` | The hook's message (written for agents by the app author) |
| `FORBIDDEN` / `UNAUTHENTICATED` | `isError: true` | "Not authorized for `<app>.<target>`" |
| `NOT_FOUND` | `isError: true` | Message from the envelope |
| `CONFLICT` | `isError: true` | Message from the envelope |
| `RATE_LIMITED` | `isError: true`, `retryAfterSeconds` | "Rate limited; retry after N s" |
| `UNAVAILABLE` (app down) | `isError: true` | "`<app>` is temporarily unavailable" |
| `INTERNAL` / unknown / malformed stream | `isError: true` | "Tool execution failed (request `<id>`)" |
| Cancelled | `isError: true` | "Cancelled" |

Every error carries `_meta["embody/errorCode"]` and `_meta["embody/requestId"]`. Messages are length-bounded and control characters stripped. Internal details stay hidden in production, as today.

### 5.7 Delegation and actor semantics (core + host + gateway)

**Problem.** Today the token decides `actorType`. A person signing into Claude produces a human token, but the model chooses which tools to call. Agent-only guardrails stop applying.

**Rule.** *A call that arrives through an MCP session is an agent call made on behalf of the signed-in subject*, unless a future, separately verified mechanism proves a direct human interaction (Plan B's UI clicks are an open question there, not solved here).

```ts
interface Principal {
  // ...existing fields
  readonly delegation?: {
    readonly subjectId: string;               // the human or service the token was issued to
    readonly subjectType: "human" | "system";
    readonly client?: string;                 // OAuth client_id / client name, bounded
  };
}
```

- For MCP sessions authenticated with a human or system token, the gateway sets `actorType: "agent"`, `actorId: "<client>:<subjectId>"` (bounded), and `delegation` with the original subject. Scopes are the subject's scopes, never broader.
- Tokens that already say `actorType: "agent"` (API keys for agents) pass through unchanged.
- The gateway JWT to app hosts carries `delegation`; the host verifier validates and exposes it as `context.principal.delegation`. Hooks keep checking `actorType === "agent"` and now also work for chat users. Hooks that need the human (for example, "assign to me") read `delegation.subjectId`.
- Audit records both actor and subject plus client.
- The non-MCP HTTP routes are unchanged: a human calling `/api/execute` with their own token is still a human.
- Gateways configure this with `mcp.delegation: "agent-on-behalf" | "token"`, default `agent-on-behalf`. `token` exists only for operators who knowingly want old behavior.

This is a contract change in core and needs the ADR in P15-00.

### 5.8 Authentication: OAuth resource server (gateway)

Follow the MCP authorization specification (protocol `2025-11-25`, already pinned as `MCP_PROTOCOL_VERSION`):

1. Serve protected-resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, naming the configured authorization server(s) and supported scopes.
2. Unauthenticated `/mcp` requests get `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.
3. Validate tokens through the existing `oidcProvider`, adding an audience check for the gateway's MCP resource URL (resource indicators, RFC 8707). Keep `mapClaims` for providers whose claims do not match Embody's principal shape.
4. **Scope mapping.** OAuth scopes requested by clients are coarse and human-readable: `embody:read`, `embody:write`, `app:<appId>` (and optionally `app:<appId>:read`). The gateway maps granted scopes plus the identity provider's roles to Embody's internal `app:target` scopes through a configurable policy. When a call needs more, return `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` so clients that support step-up can ask again.
5. API keys and existing OIDC tokens keep working for Claude Code, Codex, Cursor, the CLI and CI.
6. **Development:** `pnpm gateway:dev` and `embody dev` ship a minimal loopback-only authorization server (authorization code + PKCE, client ID metadata documents or dynamic registration as required by the spike results) issuing short-lived tokens for seeded test users. It refuses to start in production mode or on non-loopback addresses.

Client registration support (client ID metadata documents versus dynamic client registration) varies by identity provider and client. P15-00 records which combinations work; the gateway does not implement registration itself in production.

### 5.9 Registry change feed and session coherence (gateway + mcp)

- `GatewayRegistry` emits `changed` events (`registered`, `generation-changed`, `became-unhealthy`, `became-healthy`, `removed`) with app ID and generation. Health transitions are detected on read today (`expire()`); add a periodic sweep (default every 10 s) so transitions are emitted even without traffic.
- `McpHttpHandler` subscribes. For each live session whose visible catalog changed, send `notifications/tools/list_changed` (debounced, default 500 ms; at most one pending per session).
- Sessions compute their catalog from the current registry on every request, as today. They store only the activated-app set and a catalog fingerprint for change detection, not a frozen catalog.
- An unhealthy app keeps appearing in `embody_apps` with `status: "unavailable"` for a grace period (default 10 minutes) and its named tools are removed from `tools/list`. A call to one of its tools returns `UNAVAILABLE`, not "not found".
- When an app's generation changes, an in-flight call finishes against the endpoint it started with; new calls use the new generation.

### 5.10 One dispatch pipeline (gateway)

Extract a single internal `dispatch(principal, appId, target, input, { stream, signal, requestId, surface })` used by `/api/execute`, `/api/execute/stream` and MCP:

1. Registry lookup and health → `UNAVAILABLE`.
2. Target advertised → `NOT_FOUND`.
3. `scopeAllows` → `FORBIDDEN`.
4. Rate limit, keyed by `orgId:actorId:appId:target` (and by subject for delegated calls) → `RATE_LIMITED`.
5. Issue gateway JWT (with delegation), call the host.
6. Relay progress; parse terminal result or error envelope.
7. Audit: request ID, surface (`http` / `stream` / `mcp`), app, target, actor, subject, client, outcome, duration.

The three routes become thin adapters. This also fixes E2 for `/api/execute/stream`, which the CLI uses.

### 5.11 Sessions, limits and high availability (mcp + gateway)

- `McpSessionStore` interface: `get`, `set`, `delete`, `touch`, `listByPrincipal`. Default in-memory implementation. Session state is small (identity, scoped app, exposure mode, activated apps, fingerprint), so a shared store is feasible later.
- Limits (gateway options with defaults): sessions per principal (20), total sessions (10,000), idle expiry (30 min), maximum open SSE streams per session (2), maximum concurrent tool calls per session (8).
- Shutdown: stop accepting new sessions, let in-flight calls finish up to a deadline (default 10 s), then cancel them and close transports. Today's `onClose` hook closes servers but does not drain.
- **Multiple instances:** documented requirement for this phase is sticky routing on `mcp-session-id` plus one of the existing registry HA strategies. A transport-level SSE stream cannot move between instances anyway; the store interface is for session recovery after reconnect, not live migration.
- **Registry HA** is a pre-existing gap (S3) that this plan does not solve. It adds a `GatewayRegistryStore` seam so operators can provide a shared store and propagate change events across instances, and it documents that a central MCP endpoint with an inconsistent registry shows different apps per instance.

### 5.12 Clients

**Transparent stdio bridge** (`embody mcp`): proxy the full protocol rather than re-implementing handlers.

- Forward the local client's `initialize` capabilities (including extensions) upstream, and the upstream server's capabilities and `instructions` back.
- Forward requests and notifications in both directions: tools, resources, prompts, list changes, progress, cancellation, elicitation, logging.
- Keep authentication local: `EMBODY_TOKEN`, a stored profile token, or `embody login`.

**`embody login`**: OAuth authorization code + PKCE through the system browser with a loopback redirect, storing a refreshable token in the existing protected CLI profile. Used by the bridge and the CLI.

**Connection guides** (new or updated in `docs/agent-integrations/`). Exact steps are verified in P15-00 and recorded with product versions:

| Client | Expected connection |
|---|---|
| Claude web / Claude Desktop | Custom connector with the gateway URL, OAuth sign-in |
| Claude Desktop (local) | `embody mcp` through stdio, for gateways that are not reachable from the vendor's cloud |
| Claude Code | `claude mcp add --transport http embody <url>` with OAuth, or a header with a token |
| Codex | `[mcp_servers.embody]` with `url`, using OAuth login or `bearer_token_env_var` |
| ChatGPT | Connector with OAuth |
| Cursor / VS Code | Remote URL with OAuth or headers |

### 5.13 Local development (cli)

`embody dev` gains a loopback-only MCP endpoint (`http://127.0.0.1:<port>/mcp`) that reuses `McpHttpHandler` with an in-process catalog of the single dev app, dispatching through the dev kernel. It has no authentication, refuses non-loopback binding, and uses a fixed development principal with `actorType: "agent"` so agent guardrails behave as in production. It is the fastest way for app authors to test their app in Claude Code or Codex.

---

## 6. Why this should work

- **It builds on what the gateway already is.** The registry, scopes, token exchange, progress relay and session pinning are in place and tested (P7, P8, P10-03). The work is mostly connecting existing pieces correctly.
- **It uses only published MCP features**: Streamable HTTP, OAuth protected-resource metadata, tool annotations, output schemas, structured content, list-change notifications and server instructions. Nothing depends on a specific vendor.
- **It degrades safely.** Clients that ignore annotations still get correct behavior; clients that ignore list changes still finish tasks through `embody_describe` and the effect-split generic tools; clients without OAuth still use tokens.
- **Security does not regress; it improves.** All calls, including MCP, go through one audited, rate-limited, scope-checked pipeline. Delegation keeps agent guardrails working for chat users. Tokens remain audience-bound and are never passed to app hosts.
- **App authors do almost nothing.** Effects for generated CRUD are automatic; titles and descriptions are optional with sensible defaults. Existing apps keep working unchanged and get a better experience after redeploying with the new framework version.
- **It scales with the number of apps.** Progressive discovery keeps the initial context small whether an organization runs two apps or forty.

---

## 7. Implementation steps

Dependency order:

```text
P15-00 ─┬─ P15-01 ─┬─ P15-03 ─┬─ P15-05 ─┐
        │          │          │          ├─ P15-09
        ├─ P15-02 ─┘          │          │
        │                     ├─ P15-04 ─┤
        ├─ P15-06 ────────────┘          │
        ├─ P15-07 ───────────────────────┤
        └─ P15-08 (bridge part after P15-03; dev MCP after P15-01)
```

Each step lands as its own PR with tests, an API report update where public types change, docs, and a changeset.

### P15-00: ADR, host spike and support matrix

**Scope**

- Write **ADR 0006: central MCP gateway and delegated agent principal**, covering §3 decision, §5.7 delegation rule, §5.4 progressive discovery, and the boundary that the gateway is a resource server only.
- Spike with a throwaway server exposing ~120 dummy tools, discovery tools, annotations, structured results and OAuth metadata against: Claude Desktop, Claude web, Claude Code (CLI and desktop), Codex (CLI and desktop), ChatGPT, Cursor, and the MCP Inspector.

**Record per client and version**

- OAuth: protected-resource discovery, client registration method, step-up on `insufficient_scope`, token refresh.
- Whether `tools/list_changed` is honored mid-conversation.
- Behavior and limits with 120+ tools.
- Whether annotations change approval prompts.
- How `structuredContent`, `outputSchema`, `instructions`, titles and icons are shown.
- Whether the stdio path passes capabilities and notifications.

**Exit criteria:** ADR approved (decision gate D-07 added to STATUS); dated support matrix committed as `docs/guides/mcp-client-support.md`; defaults in §5.4 (threshold, modes) confirmed or adjusted from evidence.

### P15-01: one dispatch pipeline, error relay and audit

**Files:** `packages/gateway/src/index.ts` (extract `dispatch.ts`), `packages/mcp/src/index.ts`, `packages/core/src/errors.ts` (shared envelope parsing helper if needed).

**Steps**

1. Extract `dispatch()` per §5.10 with an injectable audit sink and limiter. Convert `/api/execute`, `/api/execute/stream` and the MCP `execute` collaborator into adapters.
2. Parse the host's `error` frame and non-OK JSON bodies with a bounded parser into `{ code, message, details, requestId }`; reject unknown codes to `INTERNAL`.
3. Change `McpExecutionEvent`'s error variant to carry `code`, `message`, `details?`, `requestId`; map per §5.6 in `@embody/mcp`.
4. Add `surface` to `AuditRecord`.

**Tests**

- Contract: HOOK_VETO, VALIDATION_ERROR (with details), FORBIDDEN, NOT_FOUND, CONFLICT, RATE_LIMITED, UNAVAILABLE and INTERNAL each produce the documented MCP result through an official SDK client.
- MCP and stream calls appear in audit with the right surface; rate limiting applies to MCP and stream.
- Malformed, oversized and truncated error frames map to `INTERNAL` without leaking content.
- Kanban E2E: the agent PR veto message reaches an MCP client verbatim.

**Exit criteria:** E1 and E2 fixed; existing HTTP/CLI E2E unchanged.

### P15-02: manifest metadata

**Files:** `packages/core/src/manifest.ts`, `packages/core/src/entities.ts` / kernel generation of CRUD actions, `packages/core/src/workflows.ts`, `packages/host/src/index.ts` (`defineApp`, registration), `packages/gateway/src/index.ts` (`validateRegistration`), `packages/create-embody-app` templates, example apps.

**Steps**

1. Add `app` metadata block and action `title` / `effect` / `idempotent` (§5.3).
2. Set effects for generated CRUD and workflow controls.
3. Allow plugin action definitions to declare `effect`, `title`, `idempotent`; type-check values.
4. Validate sizes, character sets and icon rules at registration; reserve app ID `embody`.
5. Fill metadata for Kanban and Email; scaffold defaults in `create-embody-app`.

**Tests:** manifest compiler golden files; old manifests (without fields) still register; invalid metadata rejected with value-free errors; API report updated.

**Exit criteria:** every reference app action has an effect; registration rejects bad metadata.

### P15-03: MCP tool metadata and structured results

**Files:** `packages/mcp/src/index.ts`.

**Steps**

1. Emit `title`, `annotations`, `outputSchema`, `icons` from manifests (§5.5).
2. Return `structuredContent` when an action has an object `outputSchema` and the value validates against it; otherwise text only. Keep a compact text `content`.
3. Server `instructions` with the fixed Embody section; per-app instructions for active apps (wired fully in P15-05).
4. Server name and version from package metadata instead of `0.0.0`.

**Tests:** `tools/list` snapshots for Kanban and Email; JSON Schema meta-schema validation of `outputSchema`; structured result validates against it; tools without output schema still return text.

**Exit criteria:** C3 and C5 fixed; E3 fixed for actions with output schemas.

### P15-04: registry change feed and list changes

**Files:** `packages/gateway/src/index.ts` (registry), `packages/mcp/src/index.ts`.

**Steps**

1. Typed `changed` event emitter on `GatewayRegistry`; periodic health sweep with injectable clock and timer.
2. `McpHttpHandler.notifyCatalogChanged(filter)`; per-session fingerprint of the visible catalog; debounced `notifications/tools/list_changed`.
3. Unavailable-app grace period and `UNAVAILABLE` mapping for its tools (§5.9).

**Tests**

- With an official SDK client: register a second app mid-session → one notification → new tools listed.
- Redeploy (generation change) → notification; in-flight call completes.
- Heartbeat expiry → notification, tools removed, call returns `UNAVAILABLE`, `embody_apps` shows `unavailable`; recovery restores tools.
- Burst of 50 registry changes → at most one notification per debounce window per session.
- Sessions of a principal without scope for the changed app get no notification.

**Exit criteria:** C4 and E4 fixed.

### P15-05: progressive discovery

**Files:** `packages/mcp/src/index.ts` (catalog view, discovery tools), `packages/gateway/src/index.ts` (options: threshold, budget).

**Steps**

1. Catalog view per session: exposure mode, activated apps, URL overrides (`?tools=`, `?apps=`) validated and bounded.
2. Discovery tools `embody_apps`, `embody_use_app`, `embody_describe`, `embody_read`, `embody_write` (§5.4), each dispatching through `dispatch()`.
3. `embody_read` rejects non-`read` targets; `embody_write` accepts `write` and `destructive`; both re-check scope.
4. `tools/list` byte budget and automatic fallback.
5. Session `instructions` include active apps' instructions.

**Tests**

- 10-app synthetic fixture (≈150 tools): initial list contains only discovery tools; `embody_use_app` activates and notifies; activated names equal `full` names.
- A client that never re-lists completes create/read/update/delete through `embody_describe` + generic tools.
- `embody_read` cannot reach a write action; unauthorized apps never appear in any discovery output.
- Mode thresholds and URL overrides behave as specified; budget fallback triggers.

**Exit criteria:** C1 fixed; P15-00 matrix shows a working path on every tested client.

### P15-06: OAuth resource server and delegation

**Files:** `packages/core/src/contracts.ts`, `packages/core/src/protocol.ts` (principal schema), `packages/host/src/index.ts` (gateway JWT verifier), `packages/gateway/src/index.ts` (auth, metadata routes, token issuance), `apps/gateway`, `docs/specs/04-pluggable-auth-identity.md`.

**Steps**

1. Add `Principal.delegation`; extend principal validation in protocol, gateway JWT claims and host verifier; expose to handlers and kernel audit.
2. MCP delegation mode (§5.7) applied when the MCP route builds the session principal.
3. Protected-resource metadata routes and `401` challenge on `/mcp*`.
4. Audience check for the MCP resource URL in `oidcProvider` (configurable list).
5. Scope-mapping policy interface and default implementation; `403 insufficient_scope` challenge.
6. Development authorization server for `pnpm gateway:dev` and `embody dev` (loopback only, refuses production).

**Tests**

- Delegated principal reaches the Kanban hook; agent PR rule fires for a human-signed-in MCP session; `delegation.subjectId` equals the human.
- Same human via `/api/execute` is still `human`.
- Tokens with wrong audience, expired, or missing scopes are rejected with correct challenges.
- Metadata documents validate; dev authorization server refuses to start in production or on non-loopback hosts.
- MCP Inspector (and, manually, at least one chat client from P15-00) completes OAuth against the dev stack.

**Exit criteria:** A1–A3 fixed; ADR 0006 delegation rule implemented; Spec 04 updated.

### P15-07: session store, limits and shutdown

**Files:** `packages/mcp/src/index.ts`, `packages/gateway/src/index.ts`, `docs/production/07-self-hosting-the-gateway.md`.

**Steps**

1. `McpSessionStore` interface + in-memory default; idle expiry sweep.
2. Limits in §5.11 with clear MCP errors when exceeded.
3. Draining shutdown with deadline.
4. `GatewayRegistryStore` seam (in-memory default) and documentation of sticky routing and registry HA requirements for MCP.

**Tests:** limits enforced and released; idle sessions expire; shutdown drains then cancels with `Cancelled` results; a 1,000-session soak stays within a documented memory budget.

**Exit criteria:** S1 and S2 addressed; S3 documented with a seam.

### P15-08: clients and developer experience

**Files:** `packages/cli/src/mcp-bridge.ts`, `packages/cli/src/index.ts` (`login`), `packages/cli/src/dev.ts`, `docs/agent-integrations/*`.

**Steps**

1. Transparent bridge (§5.12) using SDK client/server pairs that forward all request and notification types, including capabilities and `instructions`.
2. `embody login` with PKCE and loopback redirect; token refresh; profile storage.
3. Loopback MCP in `embody dev` (§5.13).
4. Connection guides per client from the P15-00 matrix; update the Claude Desktop guide's veto example to match P15-01 behavior.

**Tests:** bridge conformance (every message type round-trips; client capabilities reach the gateway); spawned-binary login against the dev authorization server; `embody dev` MCP lists and calls the dev app's tools and refuses non-loopback binding.

**Exit criteria:** D1–D3 fixed.

### P15-09: end-to-end evidence and release

**Steps**

1. Extend the distributed Compose E2E (P10-03) with a 10-app synthetic fixture next to Kanban and Email.
2. Automated journeys from §2 with SDK clients in three profiles: full-featured, no list-change handling, token-only auth.
3. Manual verification on the client matrix with screenshots and versions; update `docs/guides/mcp-client-support.md`.
4. Update Spec 05, Phase 8 notes, self-hosting, security and troubleshooting docs; changesets for `core`, `host`, `gateway`, `mcp`, `cli`, `create-embody-app`.

**Exit criteria:** all §2 journeys pass automatically; matrix published; STATUS updated.

---

## 8. Cross-cutting concerns

### 8.1 Compatibility

- Manifest fields are optional; `protocolVersion` stays `1`. Older hosts register; their custom actions are treated as `write`.
- Tool names do not change. `full` mode reproduces today's list (plus metadata).
- Error text changes from a fixed string to informative messages. This is intended; release notes call it out.
- Delegation changes the actor seen by app hosts for MCP sessions authenticated with human tokens. This is a deliberate behavior change; `mcp.delegation: "token"` restores the old behavior for one release with a deprecation warning.

### 8.2 Security

- Threat-model additions: confused deputy through chat clients (addressed by delegation and audience checks), tool-description injection via app metadata (bounded, plain text, app-registered only), discovery leaking app existence (discovery output is scope-filtered), list-change notification storms (debounce and per-session caps), generic call tools as a permission bypass (same scope checks, effect-split approvals).
- No change to: token passthrough prohibition, gateway JWT audience binding, endpoint policy, tenant isolation.

### 8.3 Observability

- Audit gains `surface`, `subjectId`, `client`.
- Metrics: sessions (active, created, expired, rejected by limit), list-change notifications sent, discovery tool usage, errors by code and surface, OAuth challenges issued.

### 8.4 Performance

- `tools/list` is computed per request today; with many apps, cache the compiled catalog per registry fingerprint and filter per principal.
- Budgets to record in the performance baseline: `tools/list` latency at 10 and 40 apps, discovery call latency, memory per idle session.

### 8.5 Documentation

New: ADR 0006, `docs/guides/mcp-client-support.md`, per-client guides. Updated: Spec 04, Spec 05, Phase 8, `docs/agent-integrations/01`–`04`, self-hosting, security, troubleshooting, `create-embody-app` README.

### 8.6 Later, not in this plan

- **MCP tasks for durable workflows**: map workflow start/status/cancel to the protocol's task support once client support is confirmed.
- **App-declared prompts and resources**: plugins could declare prompts (surfaced as slash commands in some clients) and readable resources (docs, entity snapshots).
- **Event notifications to chat**: surfacing app events (for example "PR merged") to connected sessions.
- **Persistent per-user preferences**: remembered active apps or default exposure mode across sessions.

---

## 9. Relationship to the chat GenUI plan and Phase 14

- **Plan B (chat GenUI)** adds server-built presentation documents, view sessions, an `embody_act` tool, elicitation and a generic MCP Apps view. It plugs into this plan's seams: discovery tools gain `embody_open`, the session store holds view sessions, the dispatch pipeline executes view actions, and delegation decides how UI-initiated calls are attributed. Plan B can start before this plan finishes; if it does, it must take P15-03's annotations, the transparent bridge from P15-08, and generation-aware catalogs from P15-04 with it, and it should use global `embody_`-prefixed tool names so nothing is renamed later.
- **Phase 14 is not on `main`.** Commit `ec7ca78` ("Complete Phase 14 GenUI implementations…") on `docs/genui-incremental-plan` substantially changes `packages/mcp/src/index.ts` (view metadata, MCP Apps capability check, per-session catalog snapshot, error-code metadata) and the gateway's MCP collaborators. Merge or rebase that work before P15-01 and P15-03, or land those steps first and rebase Phase 14. Two points need reconciliation: Phase 14's per-session catalog snapshot conflicts with §5.9 (catalogs computed from the current registry with generation checks), and Phase 14's limited error-code passthrough is superseded by §5.6.

---

## 10. Risks and open questions

| Risk / question | Mitigation or decision needed |
|---|---|
| Clients differ in OAuth details (registration method, step-up, refresh) | P15-00 matrix; keep token auth as the universal fallback |
| Clients ignore `tools/list_changed` | Generic `embody_read` / `embody_write` path keeps tasks completable |
| Delegation changes behavior for existing human-token MCP users | One-release `token` mode with deprecation warning; release notes |
| Who is the actor when a person clicks inside a chat UI (Plan B)? | Out of scope here; default remains agent-on-behalf until a verified mechanism exists |
| Registry inconsistency across gateway instances | Documented requirement plus `GatewayRegistryStore` seam; full HA is separate work |
| Prompt injection through app descriptions or instructions | Bounded plain text, only from authenticated registrations, never from action results |
| Multi-tenant managed gateway: is the registry per organization? | The registry is global per gateway deployment today, and app data is partitioned by `orgId`. Confirm the managed-service tenancy model before advertising one central URL across customers |
| Phase 14 merge conflicts in `@embody/mcp` | Sequence explicitly (§9) |
