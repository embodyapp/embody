# Central MCP gateway: production plan

**Status: accepted.** [ADR 0006](../adr/0006-central-mcp-gateway.md), amended 2026-10-08 with the tenant/workspace model below. Written against `main` at `3f44ab7`.

**Implementation plan:** [Phase 15](../implementation-plan/15-central-mcp-gateway.md) holds the work items, interfaces and tests. This document holds the model and the reasoning.

**Related:** [ADR 0001](../adr/0001-phase-1-stack-and-package-boundaries.md), [ADR 0004](../adr/0004-cross-app-event-delivery.md), [ADR 0005](../adr/0005-generative-ui-presentation.md), [Phase 7](../implementation-plan/07-gateway.md), [Phase 8](../implementation-plan/08-mcp-and-cli.md), [Spec 04](../specs/04-pluggable-auth-identity.md), [Spec 05](../specs/05-client-surfaces-cli-mcp.md), [self-hosting](../production/07-self-hosting-the-gateway.md).

---

## 1. Goal

Embody's purpose is to let a company run many small, highly customized applications. People in that company should connect Claude Desktop, Claude web, Claude Code, Codex, ChatGPT or Cursor **once**, to their company's gateway URL, and use every Embody app they are allowed to use, from company-wide systems such as a CRM to small apps a single team built to automate its own process.

**Constraints from product direction:**

1. **The gateway is multi-tenant.** One gateway deployment serves many companies. Nothing crosses between companies.
2. **Every app deployment belongs to exactly one company.** Apps are single-tenant.
3. **The gateway and the apps are stateless.** Any instance can be added, killed or restarted; state lives in shared storage.
4. **Ship something working as soon as possible.** Each milestone is releasable on its own; anything not needed is deferred ([§8](#8-explicitly-deferred)).

---

## 2. The model

### 2.1 Terms

| Term | Meaning | Example | Boundary |
|---|---|---|---|
| **Tenant** | A customer company. In code this is `orgId` (`principal.orgId`, storage row-level security, event routing, gateway registry). | Acme | **Hard.** Data, identity provider, credentials, billing. Nothing crosses tenants. |
| **Workspace** | A unit inside a tenant that owns and manages apps, such as a department or team. | Acme Sales EMEA | **Soft.** Ownership and visibility of apps; not a data boundary. |
| **App definition** | Code: a base app plus the plugins chosen for it. | CRM base + forecasting plugin | — |
| **App** | An app ID within one tenant, served by one deployment. Either **tenant-wide** or **owned by a workspace**. | Acme's `crm` (tenant-wide); Sales EMEA's `stale-deal-followup` | App IDs are unique within a tenant. |
| **Deployment** | Running, stateless instances of one app for one tenant. | `crm.acme.internal`, 3 replicas | Belongs to exactly one tenant. |
| **Registration** | A deployment announcing itself to the gateway: tenant, app ID, owning workspace (optional), endpoint, manifest. | (Acme, `crm`) → URL + manifest | Persisted by the gateway. |
| **Registration credential** | The secret a deployment registers with. Bound to one `(tenant, appId)` and optionally a workspace. | — | Issued by an operator. |

The code keeps the name `orgId` for the tenant to avoid a breaking rename across storage, tokens and apps; docs call it the tenant. "Workspace" is the product word for what people may call an organization inside a company.

### 2.2 How the CRM example works

- Acme's **CRM** is a tenant-wide app: one deployment, one copy of the data, used by every workspace granted access through scopes.
- Sales EMEA deploys **stale-deal-followup**, owned by its workspace. It subscribes to CRM events (works today, [ADR 0004](../adr/0004-cross-app-event-delivery.md)) and needs to call CRM actions (new work: [§4.10](#410-app-to-app-calls-after-m1)).
- A person in Sales EMEA connects to `…/t/acme/mcp` and sees the CRM plus the apps their scopes allow, including Sales EMEA's apps. Workspace membership shapes the list through scopes; it is not a data wall. If the CRM needs per-workspace visibility of records, the CRM enforces it.
- Another company running the same CRM code runs its own deployment with its own data. Sharing a *customized version* of an app between workspaces or companies means sharing code (templates, plugin packages), which is a separate distribution track, not a gateway feature.

---

## 3. Current state on `main` (short)

**Works:** `/mcp` and `/mcp/:appId` on the official SDK; catalog aggregated from healthy apps with `app__target` names and collision checks; per-principal scope filtering; audience-bound gateway JWT to app hosts (client tokens are never passed through); progress and cancellation. App hosts are already close to stateless: production requires PostgreSQL, registers a shared `PUBLIC_URL`, and background workers claim work through database leases.

**Blocks this goal:**

| # | Problem | Where |
|---|---|---|
| 1 | Every app error reaches the agent as "Tool execution failed" | `remoteEvents` in the gateway (fixed by P15-01) |
| 2 | MCP and `/api/execute/stream` skip audit and rate limiting | gateway routes (fixed by P15-01) |
| 3 | No action effect metadata or app title/description; no server instructions | `ActionManifest`, `AppManifest` (P15-02, P15-03) |
| 4 | Every authorized tool of every app is listed at once | `createMcpCatalog` (P15-03) |
| 5 | Results are JSON text only | `mcpResult` (P15-03) |
| 6 | MCP sessions live in process memory | `McpHttpHandler.sessions` (P15-04) |
| 7 | A person's credential used through a chat client is `human`, so agent-only guardrails stop applying | `Principal` (P15-06) |
| 8 | No OAuth discovery; chat products cannot connect | bearer token only (P15-07) |
| 9 | Registry is global, in memory and keyed by app ID only; credentials are a static `appId → secret` map | `GatewayRegistry` (P15-05, P15-08) |
| 10 | Every app host verifies gateway tokens with one shared HS256 secret and checks only the app ID; any host could forge calls into another tenant's apps | `issueGatewayToken`, host verifier (P15-09) |
| 11 | App hosts accept tokens for any tenant | host verifier (P15-09, P15-12) |
| 12 | `assertPublicDns` exists but nothing calls it | gateway (P15-10) |
| 13 | Event destinations come from the global registry | `GatewayRegistry.destinations` (P15-05) |
| 14 | Apps cannot call other apps' actions | not implemented (P15-13) |

Because the gateway is multi-tenant from the first release, items 9–11 block M1, not just a later shared-hosting milestone.

---

## 4. Design decisions

### 4.1 The gateway is the central MCP server

It already owns the registry, auth, scopes, token exchange, progress relay, audit and limits. Per-app MCP servers would multiply connections and consents per client; a separate MCP service would duplicate all of the above. `/t/<tenant>/mcp/<appId>` stays as a filtered view of the same server. Domain code never runs in the gateway; MCP logic stays in `@embody/mcp`, with the gateway supplying collaborators.

### 4.2 Tenancy: tenants and workspaces

- **Registry key:** `(tenant, appId)`. Two tenants may each have a `crm` with different plugins, endpoints and versions.
- **Registration credential:** bound to one `(tenant, appId)` and optionally a `workspaceId`. The registration's tenant and workspace come from the credential, never from the request body alone.
- **Tenant configuration:** identity provider, scope policy, limits, allowed endpoint origins, workspaces.
- **Every read path** (catalog, MCP, dispatch, events, CLI) filters by the caller's tenant. There is no cross-tenant catalog, call or event.
- **Workspaces** are registration metadata (owner) and a grouping in discovery. Access to an app is decided by scopes, which identity providers can map from workspace groups (P15-07). A principal-level workspace membership field is deferred until a feature needs it.
- **A gateway with one tenant** is just a small deployment. An optional `defaultTenant` keeps today's unprefixed `/mcp` and `/api/...` URLs working.

### 4.3 Tenant in the URL

OAuth discovery happens before the client has a token, so the gateway must know which tenant's identity provider to advertise from the URL alone.

- `https://gateway.example.com/t/<tenant>/mcp` (also `/t/<tenant>/mcp/<appId>`, `/t/<tenant>/api/...`).
- With `defaultTenant` configured, the unprefixed routes serve that tenant.
- The authenticated principal's tenant must equal the URL's tenant, otherwise `403`, checked once in the route layer.
- Per-tenant hostnames can be added later without design changes.

### 4.4 Stateless gateway

| State | Where it lives |
|---|---|
| Registrations, credentials, tenant configuration | `GatewayStore` interface: in-memory for development and tests, **PostgreSQL in M1** for any multi-instance deployment. |
| MCP sessions | **None.** Stateless Streamable HTTP; each POST builds the server view from the authenticated principal and the current registry. |
| Rate limits | Per instance (limits divided by instance count in configuration) until load data shows a need for a shared limiter. |
| Audit | `AuditSink`: JSON lines on stdout by default; optional Postgres sink. |
| Catalog cache | Per instance, per tenant, a few seconds, keyed by registry revision. Disposable. |
| In-flight calls | The HTTP request itself. If an instance dies, the call is cancelled and its outcome is uncertain, as with any interrupted HTTP call. |

**Cost:** no server-initiated `tools/list_changed`; new or redeployed apps appear on the client's next tool listing. Features that need the server to ask the client something mid-call (chat GenUI elicitation) will need sticky routing or a message bus, decided in that plan.

### 4.5 Compact discovery

Companies are expected to run many small apps, so compact discovery is the normal case, not an edge case.

| Mode | Tools listed | When |
|---|---|---|
| `full` | All authorized tools | `/mcp/<appId>`; or `/mcp` when the authorized tool count ≤ threshold (default 40) |
| `compact` | `embody_apps`, `embody_describe`, `embody_read`, `embody_write`, plus named tools of apps selected with `?apps=a,b` | above the threshold; or `?tools=compact` |

- `embody_apps` (read-only): authorized apps with title, description, owning workspace, health and tool count.
- `embody_describe` (read-only): schemas and descriptions for an app or one target.
- `embody_read` (read-only): dispatches a `read` target; refuses anything else.
- `embody_write` (destructive): dispatches `write` or `destructive` targets.

Two generic call tools, because clients approve per tool name: an "always allow" on reads must never cover a delete. All go through the same dispatch pipeline and scope checks as named tools. Tool names are identical across modes. App ID `embody` is reserved. No server state is needed, and clients that never re-list tools still work.

### 4.6 Delegated agent principal

A call that arrives through MCP is an **agent** call made **on behalf of** the credential's subject: `actorType: "agent"`, `actorId: "<client|mcp>:<subject>"`, `delegation: { subjectId, subjectType, client? }`. Agent credentials are unchanged; the HTTP API and CLI are unchanged. The delegation reaches app hosts, handlers and audit. `mcp.actor: "token"` keeps the old attribution for one release. (Implemented in P15-06.)

### 4.7 Gateway → app tokens: asymmetric and tenant-bound (M1)

- The gateway signs with ES256 and publishes `/.well-known/jwks.json` with `kid` rotation. App hosts hold no signing secret, so a compromised host cannot forge calls.
- Hosts verify signature, `aud = appId`, and that the token's tenant equals their configured `GATEWAY_ORG_ID`.
- HS256 is accepted only when the gateway serves a single tenant, for one release, with a deprecation warning.

### 4.8 OAuth resource server (M2)

Per the MCP authorization specification (`2025-11-25`): per-tenant protected-resource metadata at `/.well-known/oauth-protected-resource/t/<tenant>/mcp`; `401` challenges; tokens validated by the tenant's identity provider with the tenant's MCP URL as audience; a per-tenant policy mapping OAuth scopes, roles or workspace groups to Embody scopes; `insufficient_scope` step-up. API keys keep working for developer tools and CI. The gateway never issues end-user tokens in production.

### 4.9 Stateless, single-tenant app deployments

- A deployment serves exactly one tenant: production hosts require `GATEWAY_ORG_ID` and reject gateway tokens for any other tenant.
- Replicas share one `PUBLIC_URL` and one manifest generation, so their registrations and heartbeats are idempotent.
- Production already requires PostgreSQL; workers already use database leases. P15-12 proves this with a multi-replica test and documents it.
- **Registrations persist** in the gateway store until removed. A deployment that stops heartbeating is shown as unavailable instead of disappearing.
- **Open question:** whether app deployments should scale to zero when idle. If yes, "no recent heartbeat" must become an *idle* state that is still routed so the platform can wake the app ([§9](#9-open-questions)).

### 4.10 App-to-app calls (after M1)

An app such as Sales EMEA's automation must call CRM actions. Today apps can only receive other apps' events. The new capability: an app calls another app **in the same tenant** through the gateway with its own **system** identity, with scopes granted to that app, through the same dispatch pipeline (scope checks, rate limits, audit). Target app hooks can tell that an automation is calling. Planned as P15-13 after M1.

---

## 5. Milestones

| Milestone | Who can use it | Items | Rough size |
|---|---|---|---|
| **M0: decide and verify** | — | P15-00 ADR and client spike | ~2 days |
| **M1: multi-tenant gateway works in chat** | Claude Code, Codex, Cursor, Claude Desktop via the CLI bridge (token auth), on a multi-tenant, multi-instance gateway | P15-01, 02, 06 (open PRs) · P15-03 MCP metadata and discovery · P15-04 stateless MCP · P15-05 tenant-keyed store, routing and workspaces · P15-08 Postgres store · P15-09 tenant-bound asymmetric tokens · P15-12 stateless single-tenant app hosts | ~4–5 weeks |
| **M2: chat products** | Adds Claude web/desktop connectors and ChatGPT | P15-07 OAuth per tenant | ~1 week |
| **M2.5: apps integrate** | App-to-app automation | P15-13 app-to-app calls | ~1–2 weeks |
| **M3: production gate** | Managed multi-tenant service | P15-10 endpoint safety and per-tenant limits · P15-11 isolation suite, load test, runbook | ~2 weeks |

Sizes are rough single-engineer estimates, not commitments. Details: [Phase 15](../implementation-plan/15-central-mcp-gateway.md).

---

## 6. Compatibility and upgrade

| Change | Existing deployments |
|---|---|
| Error messages become informative | Intended; release note |
| Delegated agent principal over MCP | Human credentials used over MCP hit agent-only hooks; `mcp.actor: "token"` for one release |
| Stateless MCP | Transparent to clients that support it (verified in M0) |
| Tenant-keyed registry and credentials | Old `appId → secret` config is accepted when the gateway serves a single tenant, mapped to `defaultTenant`, for one release |
| Two tenants sharing one app deployment (today's E2E topology) | Not supported: each tenant gets its own deployment. The E2E moves to one deployment per tenant. |
| Asymmetric gateway tokens | HS256 accepted only on single-tenant gateways for one release, with warning |
| Manifest metadata | Optional; old hosts register; custom actions default to `write` |
| `/mcp`, `/api/...` paths | Unchanged when `defaultTenant` is set; `/t/<tenant>/...` otherwise |

---

## 7. Why this should work

- **It reuses what exists.** Registry, auth chain, scopes, token exchange, progress relay, database-leased workers and E2E infrastructure are built and tested; most steps reshape them.
- **One hard boundary.** The tenant is the only isolation boundary, and it already is one in storage, events and tokens. Workspaces add ownership and visibility without a second data wall.
- **It is standard MCP only:** stateless Streamable HTTP, OAuth protected-resource metadata, annotations, output schemas, structured content, server instructions.
- **Statelessness removes the hardest operational problems.** No session affinity, store-backed registrations, idempotent app replicas.
- **Compact discovery scales with "many small apps"** on any client.
- **Tenant safety lands before the first release:** tenant-keyed registry, tenant-bound tokens and host checks are in M1, with an isolation suite as the production gate.

---

## 8. Explicitly deferred

- `tools/list_changed` notifications, MCP sessions, per-session app activation.
- Shared rate-limit store.
- Principal-level workspace membership (scopes decide access until a feature needs membership).
- Cross-tenant anything: shared deployments, cross-tenant calls or events.
- Distribution of customized apps (templates, plugin catalog) — separate track.
- Transparent stdio bridge, `embody login`, MCP in `embody dev`, development authorization server.
- Per-tenant hostnames, app icons, MCP tasks for workflows, app-declared prompts and resources, event notifications to chat.
- Chat GenUI (builds on this plan).

---

## 9. Open questions

| Question | Needed by |
|---|---|
| Should app deployments scale to zero when idle (idle state and wake-on-call)? | P15-05/P15-12 design |
| Which identity provider(s) will the managed service support first, and which client registration methods do chat clients use with them? | M2 (M0 spike) |
| Tenant provisioning: self-serve signup or operator-provisioned at first? | M3 |
| Where does the managed gateway's signing key live (cloud KMS choice)? | M1 (P15-09) |
| Do any target clients require MCP sessions? | M1 (M0 spike) |

---

## 10. Phase 14 note

Commit `ec7ca78` (Phase 14 GenUI, on `docs/genui-incremental-plan`) is not on `main` and rewrites `packages/mcp/src/index.ts`. Its per-session catalog snapshot does not survive stateless MCP and should become a per-request generation check when it is rebased onto Phase 15.
