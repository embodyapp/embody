# ADR 0006: Central MCP gateway, org tenancy and delegated agent principal

- Status: Accepted, amended (Amendment 1)
- Date: 2026-10-08 (accepted 2026-10-08; Amendment 1 2026-10-08)
- Decision gate: D-07
- Plans: [design](../plans/central-mcp-gateway.md), [Phase 15](../implementation-plan/15-central-mcp-gateway.md)

## Context

Customers want to use every Embody app they run from chat clients (Claude web/desktop, Claude Code, Codex, ChatGPT, Cursor) through one connection. The gateway already aggregates apps behind `/mcp`, but on `main`:

- app errors are replaced by a fixed "Tool execution failed" message;
- MCP and streaming execution bypass audit and rate limiting;
- every authorized tool of every app is listed at once, without read/destructive hints;
- MCP sessions and the registry live in process memory, and the registry is keyed by app ID only;
- there is no OAuth discovery, so chat products cannot connect;
- a human signing in through a chat client produces `actorType: "human"` although a model chooses the calls, so agent-only guardrails stop applying;
- every app host verifies gateway tokens with one shared HS256 secret and checks only the app audience.

The product direction is: each customer org is its own tenant; the gateway is stateless where possible; one codebase serves a shared multi-tenant gateway and dedicated single-org gateways.

## Decision

1. **The gateway is the central MCP server.** `/mcp` is the default connection for all of an org's apps; `/mcp/:appId` is a filtered view of the same server. MCP protocol logic stays in `@embody/mcp`; the gateway supplies catalog, dispatch, store and auth collaborators. Domain code never runs in the gateway.
2. **Everything is keyed by org.** Registrations and registration credentials belong to one `(orgId, appId)`. Org configuration holds identity, scope policy, limits and allowed endpoint origins. Every read path filters by the caller's org. A dedicated gateway is a gateway configured with one default org.
3. **The org is in the URL** for shared deployments (`/o/<org>/mcp`, `/o/<org>/api/...`). The authenticated principal's org must equal the URL's org. Dedicated deployments keep unprefixed routes.
4. **The gateway process is stateless.** MCP uses stateless Streamable HTTP (no server sessions). Registry, credentials and org configuration live behind a `GatewayStore` interface (in-memory for development, PostgreSQL for production). Caches are per instance and disposable. Server-initiated MCP notifications are out of scope until there is a shared mechanism to route them.
5. **Compact discovery when catalogs are large.** Above a configurable tool-count threshold, `/mcp` lists discovery tools (`embody_apps`, `embody_describe`) and two generic call tools split by effect (`embody_read`, `embody_write`), plus named tools of apps selected with `?apps=`. Tool names are the same in every mode. App ID `embody` is reserved.
6. **Actions declare an effect** (`read`, `write`, `destructive`); generated CRUD and workflow controls set it automatically; custom actions default to `write`. MCP annotations and effect-aware scopes derive from it.
7. **MCP calls are agent calls on behalf of the token's subject.** The gateway sets `actorType: "agent"` and a `delegation` record (subject, subject type, verified client ID) for MCP calls authenticated with human or system tokens. Agent tokens are unchanged; non-MCP routes are unchanged. Hosts receive and audit the delegation.
8. **Gateway → host tokens become asymmetric and org-bound.** The gateway signs with ES256 and publishes a JWKS; hosts verify signature, app audience and their configured org, and hold no signing secret. HS256 remains for dedicated deployments for one release; shared deployments refuse it.
9. **The gateway is an OAuth resource server only.** It publishes protected-resource metadata per org, issues `401`/`403` challenges and validates tokens from the org's identity provider. It does not issue end-user tokens in production.
10. **Errors are relayed, not replaced.** The host's sanitized error envelope (code, message, validation details, request ID) reaches MCP and HTTP clients; anything malformed becomes `INTERNAL`.

## Amendment 1: workspaces, teams, single-tenant apps that can sleep (2026-10-08)

Product direction clarified that Embody serves companies running many small, customized apps; that the gateway is multi-tenant; that every app deployment belongs to one company; and that apps and the gateway must be able to sleep when idle to reduce cost, without user-visible errors. This amendment replaces decisions 2 and 3, tightens 4, 5 and 8, and adds decisions on sleeping. Terms align with the Embody Cloud hosting plan (ADR 0007, ADR 0008).

- **Workspace = a customer company's account = the tenant = `orgId` in code.** It is the only hard isolation boundary (data, identity, credentials, billing). The code keeps the name `orgId`.
- **Teams** are units inside a workspace (for example "Sales EMEA") that own apps. They are registration metadata and a discovery grouping, not a data boundary; access is decided by scopes, which identity providers may map from team groups.
- **Apps are single-tenant.** Every app deployment belongs to exactly one workspace and is workspace-wide (for example a CRM) or team-owned. App IDs are unique within a workspace. A deployment never registers for more than one workspace.
- **Registrations** are keyed `(workspace, appId)`, carry an optional owning team, are bound to credentials for exactly that key, and are **saved until removed, independent of any running instance**.
- **URLs** are `/w/<workspace>/...`; `defaultWorkspace` keeps unprefixed routes for one-workspace gateways.
- **Heartbeats are optional.** Apps register once per version (deploy pipeline or startup). App status (`ready`, `idle`, `unavailable`) is derived from real calls; tools are never removed because of status, and discovery never wakes an app.
- **Calls tolerate sleeping apps:** a wake budget with progress messages; automatic retry only when the request provably never reached the app, or for `read`/`idempotent` actions; clear errors otherwise.
- **Work without a user wakes its app:** events created by a request are sent before the response; apps report their next due time; a scheduler-driven sweep wakes apps with due work through a protected wake endpoint; a daily safety wake bounds the impact of a lost hint. The hosting plan's full reconciler may replace the sweep behind the same contract.
- **App hosts have a `sleep` runtime mode** with no background timers, side-effect-free startup and a readiness check; `always-on` remains for local and self-hosted use.
- **The gateway can scale to zero:** no in-memory state, lazy loading, fail-closed when the store is unavailable.
- **Tenant safety is part of the MVP:** PostgreSQL store, workspace routing, asymmetric workspace-bound tokens and an isolation suite.
- **App-to-app calls** within a workspace, with the calling app's own system identity and scopes, are part of the MVP.
- **Superseded:** dedicated vs shared deployment modes; credentials covering several orgs; health from heartbeats; hiding tools of unhealthy apps.

## Consequences

- New optional manifest fields (action `effect`, `title`, `idempotent`; app `title`, `description`, `instructions`) keep `protocolVersion: 1`.
- `Principal` gains optional `delegation`; the principal schema, kernel validation, auth verifier and testing harness change atomically.
- `GatewayRegistry` becomes asynchronous over `GatewayStore`; the legacy constructor is accepted for one release.
- `@embody/gateway` gains a PostgreSQL store (subpath export, optional `pg` peer) and an operator admin script.
- Hosts gain `GATEWAY_ORG_ID` and `GATEWAY_JWKS_URL`; `GATEWAY_JWT_SECRET` is deprecated.
- MCP clients that cache tool lists see new apps on their next listing rather than through notifications.
- Behavior changes called out in release notes: informative errors; delegated agent actor for human tokens on MCP (escape hatch `mcp.actor: "token"` for one release).

## Alternatives considered

- **One MCP server per app:** multiplies client connections and OAuth consents, prevents cross-app requests and duplicates governance in every host. Rejected as the default; per-app URLs remain as filters.
- **Separate MCP edge service:** duplicates registry, auth and dispatch or adds a hop and a second auth boundary. Deferred; the `@embody/mcp` seam keeps it possible.
- **Stateful MCP sessions with sticky routing:** enables list-change notifications but requires affinity and a session store. Deferred until a feature needs server-initiated messages; available behind a flag if a required client cannot use stateless mode.
- **Keeping `actorType` from the token:** silently disables agent guardrails for chat users. Rejected.
- **Gateway as authorization server:** large security surface with little benefit over existing identity providers. Rejected for production.
