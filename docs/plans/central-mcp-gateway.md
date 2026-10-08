# Central MCP gateway: production plan

**Status: proposal, not implemented.** Written 2026-10-08 against `main` at `3f44ab7`. Proposed IDs use `P15-xx`; nothing is claimed in [STATUS.md](../implementation-plan/STATUS.md) until the ADR in P15-00 is approved.

**Related:** [ADR 0001](../adr/0001-phase-1-stack-and-package-boundaries.md), [ADR 0004](../adr/0004-cross-app-event-delivery.md), [ADR 0005](../adr/0005-generative-ui-presentation.md), [Phase 7](../implementation-plan/07-gateway.md), [Phase 8](../implementation-plan/08-mcp-and-cli.md), [Spec 04](../specs/04-pluggable-auth-identity.md), [Spec 05](../specs/05-client-surfaces-cli-mcp.md), [self-hosting](../production/07-self-hosting-the-gateway.md).

---

## 1. Goal

A customer organization connects Claude Desktop, Claude web, Claude Code, Codex, ChatGPT or Cursor **once**, to its Embody gateway URL, and can safely use every Embody app it is authorized for.

**Constraints from product direction:**

1. **Every customer org is its own tenant.** Apps, registrations, catalogs, identity settings, limits and audit are per org.
2. **The gateway is stateless.** Any instance can serve any request; state lives in shared stores.
3. **One codebase, two deployment modes.** A *shared* multi-tenant gateway for the managed service, and a *dedicated* single-org gateway for self-hosting, private networks and compliance. Dedicated is the same code configured with one org.
4. **Ship something working as soon as possible.** Each milestone is releasable on its own. Anything not needed for a milestone is deferred ([§8](#8-explicitly-deferred)).

---

## 2. Milestones

| Milestone | Who can use it | What it adds | Size |
|---|---|---|---|
| **M0: decide and verify** | — | ADR, client spike | ~2 days |
| **M1: works in chat** | Dedicated gateways; Claude Code, Codex, Cursor, Claude Desktop via the CLI bridge (token auth) | Real errors, audit/limits on MCP, tool annotations, structured results, stateless MCP, compact discovery, delegated agent principal, org-keyed state | ~2 weeks |
| **M2: chat products** | Adds Claude web/desktop connectors and ChatGPT | OAuth resource server per org | ~1 week |
| **M3: shared multi-tenant** | Managed shared gateway | Postgres stores, org in URL, asymmetric org-bound tokens, endpoint safety, per-org limits and event routing, isolation test gate | ~2–3 weeks |

Sizes are rough single-engineer estimates for review, not commitments. M1 and M2 can overlap after P15-01.

---

## 3. Current state on `main` (short)

**Works:** `/mcp` and `/mcp/:appId` on the official SDK; catalog aggregated from healthy apps with `app__target` names and collision checks; per-principal scope filtering; audience-bound gateway JWT to app hosts (client tokens are never passed through); progress and cancellation.

**Blocks this goal:**

| # | Problem | Where |
|---|---|---|
| 1 | Every app error reaches the agent as "Tool execution failed"; hook veto messages and validation details are dropped | `remoteEvents` in [gateway/src/index.ts](../../packages/gateway/src/index.ts) |
| 2 | MCP and `/api/execute/stream` skip audit and rate limiting | only `POST /api/execute/:appId/:target` calls them |
| 3 | No action effect metadata, so no read/destructive annotations; no app title/description; no server instructions | `ActionManifest`, `AppManifest`, `new Server(...)` |
| 4 | Every authorized tool of every app is listed at once | `createMcpCatalog` |
| 5 | Results are JSON text only | `mcpResult` |
| 6 | MCP sessions live in process memory | `McpHttpHandler.sessions` |
| 7 | A human signing in through a chat client becomes `actorType: "human"`, so agent-only guardrails (e.g. Kanban's PR rule) stop applying | `Principal`; `examples/kanban/src/plugin.ts` |
| 8 | No OAuth discovery; chat products cannot connect | bearer token only |
| 9 | Registry is global and in memory, keyed by app ID only; registration credentials are a static `appId → secret` map | `GatewayRegistry` |
| 10 | Gateway → host tokens use one HS256 secret shared by every host, and hosts check only `aud = appId`. Any host holding the secret can mint calls to any app of any org | `issueGatewayToken`; host `gatewayJwtVerifier` with `algorithms: ["HS256"]` |
| 11 | `assertPublicDns` exists but nothing calls it; dispatch to registered endpoints is open to DNS rebinding | gateway |
| 12 | Event destinations come from the global registry, not filtered by org | `GatewayRegistry.destinations` |

Items 1–8 matter for every deployment. Items 9–12 are tolerable in a dedicated gateway trusted by one org, and **block the shared gateway**.

---

## 4. Design decisions

### 4.1 The gateway is the central MCP server

It already owns the registry, auth, scopes, token exchange, progress relay, audit and limits. Per-app MCP servers would multiply connections and consents per client; a separate MCP service would duplicate all of the above. `/mcp/:appId` stays as a filtered view of the same server. Domain code never runs in the gateway; MCP logic stays in `@embody/mcp`, with the gateway supplying collaborators.

### 4.2 Tenancy: everything is keyed by org

- **Registry key:** `(orgId, appId)`. Two orgs may each have a `kanban` app with different endpoints and versions.
- **Registration credential:** belongs to exactly one `(orgId, appId)`. An app host that serves several orgs registers once per org with each credential (usually there is only one).
- **Org configuration:** identity provider (issuer, audience, claim mapping), scope policy, limits, allowed endpoint origins.
- **Every read path** (catalog, MCP, dispatch, events, CLI) filters by the caller's org. There is no cross-org catalog.
- **Dedicated mode** is a gateway configured with one org. `/mcp` resolves to it. Existing single-org deployments upgrade without URL changes.

### 4.3 Tenant in the URL

OAuth discovery happens before the client has a token, so the gateway must know which org's identity provider to advertise from the URL alone.

- Shared mode: `https://gateway.example.com/o/<org>/mcp` (also `/o/<org>/mcp/<appId>`, `/o/<org>/api/...`). Per-org hostnames can be added later without design changes.
- Dedicated mode: `/mcp` and existing `/api/...` routes, plus `/o/<org>/...` for the configured org.
- The authenticated principal's `orgId` must equal the URL's org, otherwise `403`. This is checked once in the route layer.

### 4.4 Stateless gateway

| State | Where it lives |
|---|---|
| Registry, registration credentials, org configuration | `GatewayStore` interface. In-memory implementation for dev and tests; PostgreSQL implementation (M3) for production. |
| MCP sessions | **None.** Use the SDK's stateless Streamable HTTP mode (no `Mcp-Session-Id`). Each POST builds the server view from the authenticated principal and the current registry. |
| Rate limits | Per-instance fixed window in M1–M2 (limits divided by instance count in configuration). Shared limiter is deferred until load data shows a need. |
| Audit | `AuditSink` interface. Default: structured JSON log lines on stdout for the log pipeline. Optional Postgres sink in M3. |
| Catalog cache | Per-instance, per-org, a few seconds, keyed by registry revision. Disposable. |
| In-flight tool calls | The HTTP request itself. If an instance dies, the call is cancelled and the client sees a transport error; outcome is uncertain, as with any interrupted HTTP call. |

**What statelessness costs, and why that is acceptable now:** no server-initiated `tools/list_changed` notifications and no per-session state. New or redeployed apps appear on the client's next tool listing (typically a new conversation). Chat GenUI features that need the server to ask the client something mid-call (elicitation) will need sticky routing or a shared message bus; that is decided in the GenUI plan, not here.

### 4.5 Compact discovery without sessions

| Mode | Tools listed | When |
|---|---|---|
| `full` | All authorized tools | `/mcp/<appId>`; or `/mcp` when the org's authorized tool count ≤ threshold (default 40) |
| `compact` | `embody_apps`, `embody_describe`, `embody_read`, `embody_write`, plus named tools of apps selected with `?apps=a,b` | `/mcp` above the threshold; or `?tools=compact` |

- `embody_apps` (read-only): authorized apps with title, description, health and tool count.
- `embody_describe` (read-only): schemas and descriptions for an app or one target.
- `embody_read` (read-only): dispatch a target whose effect is `read`; refuses anything else.
- `embody_write` (destructive): dispatch a `write` or `destructive` target.

Two generic call tools instead of one, because clients approve per tool name: an "always allow" on `embody_read` must never cover a delete. All four go through the same dispatch pipeline and scope checks as named tools. `?apps=` is a convenience filter, not a permission. Tool names are identical across modes. App ID `embody` is reserved.

This needs no server state and works on clients that never re-list tools.

### 4.6 Delegated agent principal

**Rule:** a call that arrives through MCP is an **agent** call made **on behalf of** the token's subject.

```ts
interface Principal {
  // existing: orgId, actorId, actorType, roles, scopes, metadata?
  readonly delegation?: {
    readonly subjectId: string;
    readonly subjectType: "human" | "system";
    readonly client?: string; // OAuth client id or name, bounded
  };
}
```

- MCP with a human or system token → `actorType: "agent"`, `actorId: "<client|mcp>:<subjectId>"`, `delegation` set, scopes unchanged (never broader).
- Agent API keys pass through unchanged.
- `/api/execute` with a human token is still a human call.
- The gateway → host token carries `delegation`; hosts expose it as `context.principal.delegation`. Existing `actorType === "agent"` guardrails keep working; hooks that need the person read `delegation.subjectId`. Audit records actor, subject and client.
- Gateway option `mcp.actor: "agent-on-behalf" | "token"` (default `agent-on-behalf`). `token` is a one-release escape hatch with a deprecation warning.

### 4.7 Gateway → host tokens: asymmetric and org-bound (M3)

- Gateway signs with ES256 using a configured private key (KMS-backed in managed deployments) and publishes `/.well-known/jwks.json` with `kid` rotation.
- Claims add `org` (the tenant). Hosts verify via JWKS URL, check `aud = appId` and `org ∈` the orgs the host registered for.
- Hosts no longer hold any signing secret, so a compromised or malicious host cannot forge calls.
- Dedicated mode keeps HS256 for one release (with a deprecation warning) so existing deployments do not break; shared mode refuses to start with HS256.

### 4.8 OAuth resource server (M2)

Per the MCP authorization specification (`2025-11-25`, already pinned):

1. `/.well-known/oauth-protected-resource/o/<org>/mcp` (and the dedicated `/mcp` equivalent) names the org's authorization server and supported scopes.
2. Unauthenticated MCP requests get `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.
3. Tokens are validated by the existing `oidcProvider` configured per org, with the audience set to that org's MCP resource URL.
4. Scope mapping: tokens carry coarse scopes (`embody:read`, `embody:write`) or roles; a per-org policy maps them to Embody's `app:target` scopes. Missing scope → `403` with `error="insufficient_scope"`.
5. API keys keep working for Claude Code, Codex, Cursor, the CLI and CI.

The gateway never issues end-user tokens in production; it is a resource server only. Which identity providers and client registration methods work with which chat clients is recorded in M0.

---

## 5. Implementation steps

```text
M0  P15-00 ─┐
M1          ├─ P15-01 ─┬─ P15-03 ─┬─ P15-04
            ├─ P15-02 ─┘          │
            ├─ P15-05 ────────────┤
            └─ P15-06 ────────────┘
M2                        P15-07 (after P15-05, P15-06)
M3                        P15-08 ─ P15-09 ─ P15-10 ─ P15-11
```

Every step is one PR with tests, docs, API report updates and a changeset. Every step keeps existing HTTP, CLI, event and workflow behavior unchanged unless stated.

### M0: decide and verify

#### P15-00: ADR and client spike

- **ADR 0006** covering §4: gateway as central MCP, tenancy model, stateless mode, compact discovery, delegation rule, asymmetric tokens, resource-server-only OAuth. Add decision gate D-07 to STATUS.
- **Spike** with a throwaway stateless server (~120 dummy tools, annotations, structured results, OAuth metadata) against Claude Desktop, Claude web, Claude Code, Codex, ChatGPT, Cursor and MCP Inspector. Record per client and version:
  - stateless Streamable HTTP (no session ID) works;
  - OAuth discovery, client registration method, `insufficient_scope` handling, token refresh;
  - behavior with 120+ tools;
  - whether annotations affect approval prompts;
  - how `structuredContent` and `instructions` appear.
- **Output:** ADR approved; `docs/guides/mcp-client-support.md` with dated results; threshold default confirmed.
- **Fallback:** if a must-have client cannot use stateless mode, enable the SDK's session mode behind a flag with sticky routing on `Mcp-Session-Id` for that deployment. Session state stays minimal (identity only), so this does not change anything else in the plan.

### M1: works in chat

#### P15-01: one dispatch pipeline, real errors, audit everywhere

**Files:** `packages/gateway/src/index.ts` → new `dispatch.ts`; `packages/mcp/src/index.ts`.

1. Extract `dispatch(principal, appId, target, input, { stream, signal, requestId, surface })`: registry lookup and health → target advertised → `scopeAllows` → rate limit → gateway token → host call → progress relay → parse terminal result or error envelope → audit.
2. `/api/execute`, `/api/execute/stream` and MCP become thin adapters.
3. Parse the host's sanitized error envelope (already produced by `toErrorEnvelope`) with a bounded parser; unknown or malformed → `INTERNAL`.
4. MCP mapping: `isError: true` with the envelope message; validation `details` listed; `_meta["embody/errorCode"]` and `_meta["embody/requestId"]`; `RATE_LIMITED` includes retry-after; unavailable app → "`<app>` is temporarily unavailable". Messages bounded and control characters stripped.
5. `AuditSink` interface with stdout JSON default; records `surface`, org, app, target, actor, subject, client, outcome, duration, request ID.

**Tests:** each error code through an official SDK client; malformed/oversized frames → `INTERNAL` without leaking content; MCP and stream calls audited and rate-limited; Kanban PR veto message reaches the MCP client verbatim.

#### P15-02: action effects and app metadata

**Files:** `packages/core/src/manifest.ts` and CRUD/workflow generation, `packages/host/src/index.ts` (`defineApp`), `validateRegistration`, `create-embody-app` templates, Kanban and Email.

1. Optional `ActionManifest.effect: "read" | "write" | "destructive"`, `title`, `idempotent`.
2. Generated CRUD: `get`/`list` read, `create` write, `update` write + idempotent, `delete` destructive. Workflow controls: `status` read, `start`/`retry` write, `cancel` destructive. Custom actions without `effect` are treated as `write`.
3. Optional `AppManifest.app = { title?, description?, instructions? }` (plain text, bounded: 80 / 500 / 2,048 chars). Icons deferred.
4. Registration validates sizes and characters; reserves app ID `embody`. Manifest `protocolVersion` stays `1`; older manifests still register.

**Tests:** compiler golden files; old manifests register; invalid metadata rejected without echoing values.

#### P15-03: MCP metadata, structured results, compact discovery

**Files:** `packages/mcp/src/index.ts`, gateway options.

1. Tools get `title` and `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) from effects.
2. `outputSchema` when the action has an object output schema; results then include `structuredContent` (only if the value validates) plus compact JSON text.
3. Server `instructions`: a fixed Embody section (naming, discovery tools, error format) plus the org's app titles and descriptions, bounded to 8 KiB.
4. Compact discovery (§4.5), `?tools=` and `?apps=` parsing (bounded), threshold option, `tools/list` byte budget (default 256 KiB) with automatic compact fallback.
5. Server name and version from package metadata.

**Tests:** `tools/list` snapshots in both modes; `embody_read` refuses write targets; `embody_write` re-checks scope; unauthorized apps never appear in any discovery output; a client that never re-lists completes create/list/update/delete through compact tools; 10-app synthetic fixture stays within the budget.

#### P15-04: stateless MCP transport

**Files:** `packages/mcp/src/index.ts`, gateway MCP route.

1. Replace the session map with stateless Streamable HTTP: build a `Server` per request from `(principal, org, scopedApp, mode)`; no `Mcp-Session-Id`.
2. Respond `405` to standalone `GET` streams and `DELETE` per the stateless transport rules.
3. Keep progress and cancellation within the POST response stream.
4. Keep the session-mode code path behind `mcp.sessions: "stateless" | "sticky"` only if P15-00 found a client that needs it.
5. Drain on shutdown: stop accepting, let in-flight calls finish up to 10 s, then cancel.

**Tests:** two gateway instances behind a round-robin proxy in the E2E compose; list and call alternate instances successfully; killing an instance mid-call yields a clean client error and no duplicate execution; progress ordering and cancellation tests from Phase 8 still pass.

#### P15-05: org-keyed state behind `GatewayStore`

**Files:** `packages/gateway/src` (new `store.ts`), `apps/gateway`, host registration client.

1. `GatewayStore` interface: orgs (config), registrations keyed `(orgId, appId)`, credentials (hashed) keyed the same way, a per-org registry revision. In-memory implementation only in M1.
2. Registration and heartbeat resolve `(orgId, appId)` from the credential; registration body may include `orgId` and it must match.
3. Health is derived on read from `lastSeen` and TTL; no background sweep needed.
4. Catalog, MCP, dispatch and `/api/catalog` read the caller's org only. Per-instance catalog cache keyed by org revision.
5. Dedicated mode: a `defaultOrg` option; existing `credentials: Record<appId, secret>` config is accepted and mapped to the default org for one release.
6. Host: registration config accepts a list of `{ orgId?, secret }` (usually one).

**Tests:** two orgs each with a `kanban` app on different endpoints; each org sees and calls only its own; existing single-org E2E unchanged.

#### P15-06: delegated agent principal

**Files:** `packages/core/src/contracts.ts`, `packages/core/src/protocol.ts`, `packages/host/src/index.ts` (verifier), gateway MCP route and token issuance, Spec 04.

1. Add `Principal.delegation` and validation.
2. MCP route applies §4.6; gateway token includes `delegation`; host verifier validates and exposes it.
3. Audit includes subject and client.

**Tests:** a human token over MCP triggers Kanban's agent PR guardrail and records the human as subject; the same token on `/api/execute` stays human; agent API keys unchanged; `mcp.actor: "token"` restores old behavior with a warning.

**M1 exit:** Kanban and Email journeys (discover, read, guarded write with veto and correction) pass through an official SDK client against two stateless gateway instances; manually verified in Claude Code and Codex with token auth; docs: per-client connection guides for token-capable clients, updated Claude Desktop guide.

### M2: chat products

#### P15-07: OAuth resource server per org

**Files:** gateway routes and auth configuration, org config schema, `apps/gateway`, docs.

1. Per-org protected-resource metadata and `401` challenge (§4.8).
2. Per-org `oidcProvider` (issuer, JWKS, audience = org MCP resource URL, claim mapping).
3. Per-org scope policy and `insufficient_scope` challenge.
4. URL org must equal token org.
5. Docs: setup with at least one supported identity provider, chosen from the M0 results; connection guides for Claude web/desktop connectors and ChatGPT.

**Tests:** metadata documents validate; wrong audience, wrong org, expired and under-scoped tokens rejected with correct challenges; MCP Inspector completes OAuth against a test identity provider in CI; manual verification in Claude web and ChatGPT recorded in the support matrix.

**M2 exit:** a dedicated gateway is usable from Claude web/desktop and ChatGPT with OAuth sign-in.

### M3: shared multi-tenant

#### P15-08: PostgreSQL `GatewayStore`

1. Migrations for orgs, registrations, credentials (slow KDF hashes), registry revision; uses existing `@embody/storage` PostgreSQL conventions.
2. Heartbeats update `lastSeen` with a single-row upsert; revision increments only on registration or generation change.
3. Org provisioning API or CLI command for operators (create org, issue app registration credentials, set identity provider). Admin-authenticated, not exposed to tenants.
4. Optional Postgres `AuditSink`.

**Tests:** conformance suite shared with the in-memory store; two instances see the same registry immediately after registration; gateway restart loses nothing.

#### P15-09: asymmetric, org-bound gateway tokens

1. ES256 signing with `kid`; `/.well-known/jwks.json`; key rotation with overlap.
2. `org` claim; host verifier checks JWKS signature, `aud`, `org` and short expiry.
3. Shared mode refuses HS256; dedicated mode warns.
4. Host config: `GATEWAY_JWKS_URL` replaces `GATEWAY_JWT_SECRET`.

**Tests:** host rejects tokens for another org, another app, wrong `kid`, HS256 in shared mode; rotation keeps calls working.

#### P15-10: endpoint safety, per-org limits, org-scoped events

1. Shared mode forbids private endpoints; registration and every dispatch run `assertPublicDns`; dispatch connects to the resolved, validated address; redirects refused.
2. Per-org allowed endpoint origins.
3. Per-org limits: registered apps (default 50), tools per org catalog, request rate per org and per actor, concurrent calls per org.
4. `destinations(event)` filters registrations by `event.orgId`; durable relay (P7-04) does the same.
5. `/o/<org>/...` routing for all routes; dedicated mode keeps unprefixed routes.

**Tests:** DNS rebinding fixture blocked; private IP registration rejected in shared mode; one org exhausting limits does not affect another; events never reach another org's apps.

#### P15-11: isolation gate and production readiness

1. **Cross-tenant test suite (release-blocking):** token from org A on org B's URL; guessed app IDs; catalog, discovery and `embody_describe` leakage; registration credential reuse across orgs; forged host tokens; event routing; audit separation; cache poisoning across orgs.
2. Load test: 100 orgs × 10 apps, `tools/list` and call latency at p50/p95 recorded in the performance baseline.
3. Ops: runbook entries (key rotation, org provisioning, revoking credentials, draining instances), metrics (requests and errors by org/surface/code, OAuth challenges, registry size, heartbeat lag), alerts.
4. Docs: self-hosting (dedicated) vs managed (shared), security model, upgrade notes for HS256 → JWKS and org-keyed credentials.

**M3 exit:** isolation suite green; load numbers recorded; managed shared gateway deployable.

---

## 6. Compatibility and upgrade

| Change | Existing dedicated deployments |
|---|---|
| Error messages become informative | Intended; release note |
| Delegated agent principal over MCP | Behavior change for human tokens on MCP; `mcp.actor: "token"` for one release |
| Stateless MCP | Transparent to clients that support it (verified in M0) |
| Org-keyed registry and credentials | Old `appId → secret` config maps to the default org for one release |
| Asymmetric gateway tokens | HS256 still accepted in dedicated mode for one release, with warning |
| Manifest metadata | Optional; old hosts register; custom actions default to `write` |
| `/mcp`, `/api/...` paths | Unchanged in dedicated mode |

---

## 7. Why this should work

- **It reuses what exists.** Registry, auth chain, scopes, token exchange, progress relay and E2E infrastructure are already built and tested; most steps reshape them rather than add new systems.
- **It is standard MCP only:** stateless Streamable HTTP, OAuth protected-resource metadata, tool annotations, output schemas, structured content, server instructions.
- **Statelessness removes the hardest operational problem.** No session affinity, no session store, no notification fan-out. Instances can be added, removed or restarted freely.
- **Compact discovery degrades safely** on any client, because it needs neither list-change support nor server state.
- **Tenancy is designed in, not bolted on.** Dedicated mode is just one org, so self-hosted and managed deployments run the same code and tests.
- **Security improves at each step:** governed MCP calls in M1, standard OAuth in M2, forgery-proof host tokens and SSRF protection in M3, with an isolation suite as a release gate before any tenants share a gateway.

---

## 8. Explicitly deferred

Not needed for a working production system; revisit with evidence.

- `tools/list_changed` notifications, MCP sessions, per-session app activation.
- Shared rate-limit store (per-instance limits are enough until load data says otherwise).
- Transparent stdio bridge for resources, prompts and elicitation (needed by the chat GenUI plan, not here).
- `embody login` OAuth for the CLI; loopback MCP in `embody dev`; development authorization server.
- Per-org hostnames, app icons, MCP tasks for workflows, app-declared prompts and resources, event notifications to chat.
- Chat GenUI (server-built documents, elicitation, MCP Apps views). It builds on this plan; elicitation will require sticky routing or a message bus, decided there.

---

## 9. Phase 14 note

Commit `ec7ca78` (Phase 14 GenUI, on `docs/genui-incremental-plan`) is not on `main` and rewrites `packages/mcp/src/index.ts` (view metadata, MCP Apps checks, a per-session catalog snapshot, partial error-code passthrough). Sequence it explicitly: either merge Phase 14 before P15-01 and adapt it to stateless mode, or land P15-01/P15-03/P15-04 first and rebase Phase 14. Its per-session catalog snapshot does not survive stateless mode and should become a generation check per request.

---

## 10. Open questions

| Question | Needed by |
|---|---|
| Which identity provider(s) will the managed service support first, and do they support the client registration method chat clients use? | M2 (answered by M0 spike) |
| Org provisioning: self-serve signup or operator-provisioned at first? | M3 |
| Where does the managed gateway's signing key live (cloud KMS choice)? | M3 |
| Do any target clients require MCP sessions (stateless not supported)? | M1 (answered by M0 spike) |
