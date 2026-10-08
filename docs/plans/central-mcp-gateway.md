# Central MCP gateway: production plan

**Status: accepted.** [ADR 0006](../adr/0006-central-mcp-gateway.md), amended 2026-10-08 (Amendment 1: workspaces, teams, single-tenant apps that can sleep). Written against `main` at `3f44ab7`.

**Implementation plan:** [Phase 15](../implementation-plan/15-central-mcp-gateway.md) holds the work items, interfaces and tests. This document holds the model and the reasoning.

**Hosting plan:** Embody Cloud hosting on Cloud Run ([hosting plan](../hosting/PLAN.md), ADR 0007 and ADR 0008 on the `docs/cloud-run-hosting-plan` branch) owns everything provider-specific. This plan owns the framework and gateway code both rely on. [§8](#8-relationship-to-the-hosting-plan) lists who owns what.

**Related:** [ADR 0001](../adr/0001-phase-1-stack-and-package-boundaries.md), [ADR 0003](../adr/0003-durable-workflows.md), [ADR 0004](../adr/0004-cross-app-event-delivery.md), [ADR 0005](../adr/0005-generative-ui-presentation.md), [Phase 8](../implementation-plan/08-mcp-and-cli.md), [Spec 04](../specs/04-pluggable-auth-identity.md), [Spec 05](../specs/05-client-surfaces-cli-mcp.md).

---

## 1. Goal

Embody lets a company run many small, highly customized apps. People in that company connect Claude Desktop, Claude web, Claude Code, Codex, ChatGPT or Cursor **once**, to their workspace's gateway address, and use every Embody app they are allowed to use, from company-wide systems such as a CRM to small apps a team built to automate its own process.

**Constraints from product direction:**

1. **The gateway is multi-tenant.** One gateway deployment serves many workspaces (companies). Nothing crosses between workspaces.
2. **Every app deployment belongs to exactly one workspace.** Apps are single-tenant.
3. **The gateway and the apps are stateless.** Any instance can be added, killed or restarted; state lives in shared storage.
4. **Apps and the gateway can sleep when idle** to reduce cost, and users never see errors because something was asleep.
5. **Keep it simple and reach a working MVP fast** ([§7](#7-mvp-and-fastest-path)).

---

## 2. The model

### 2.1 Terms

| Term | Meaning | Example | Boundary |
|---|---|---|---|
| **Workspace** | A customer company's account. In code this is the tenant: `orgId` (`principal.orgId`, storage row-level security, event routing, gateway registry). | Acme | **Hard.** Data, identity provider, credentials, billing. Nothing crosses workspaces. |
| **Team** | A unit inside a workspace that owns and manages apps, such as a department. | Acme Sales EMEA | **Soft.** Ownership and grouping of apps; not a data boundary. |
| **App definition** | Code: a base app plus the plugins chosen for it. | CRM base + forecasting plugin | — |
| **App** | An app ID within one workspace, served by one deployment. Either **workspace-wide** or **owned by a team**. | Acme's `crm`; Sales EMEA's `deal-nudger` | App IDs are unique within a workspace. |
| **Deployment** | Stateless instances of one app for one workspace, possibly zero while asleep. | `crm.acme…`, 0–3 instances | Belongs to exactly one workspace. |
| **Registration** | The gateway's saved record of an app: workspace, app ID, owning team (optional), address, manifest, status, next due time. | (Acme, `crm`) → address + manifest | Kept until removed; does not depend on a running instance. |
| **Registration credential** | The secret a deployment or deploy pipeline registers with. Bound to one `(workspace, appId)` and optionally a team. | — | Issued by an operator or the hosting control plane. |

"Tenant" remains the technical word for a workspace where code and protocols are discussed. The code keeps the name `orgId`.

### 2.2 The CRM example

- Acme's **CRM** is workspace-wide: one deployment, one copy of the data, used by every team granted access through scopes.
- Sales EMEA's **Deal Nudger** is owned by that team. It listens for CRM events (works today, [ADR 0004](../adr/0004-cross-app-event-delivery.md)) and calls CRM actions with its own identity (P15-13).
- Maya, in Sales EMEA, connects Claude to `…/w/acme/mcp` and sees the CRM and the apps her scopes allow, including Sales EMEA's. Team membership shapes the list through scopes; it is not a data wall. If the CRM needs per-team visibility of records, the CRM enforces it.
- Globex running the same CRM code runs its own deployment with its own data. Sharing a customized app between teams or workspaces means sharing code (templates, plugin packages), a separate distribution track.

---

## 3. Current state on `main` (short)

**Works:** `/mcp` and `/mcp/:appId` on the official SDK; catalog aggregated from healthy apps with collision checks; per-principal scopes; audience-bound gateway JWT to app hosts; progress and cancellation. App hosts in production already require PostgreSQL, register a shared `PUBLIC_URL`, and claim background work through database leases.

**Blocks this goal:**

| # | Problem | Fixed by |
|---|---|---|
| 1 | Every app error reaches the agent as "Tool execution failed" | P15-01 |
| 2 | MCP and streaming execution skip audit and rate limits | P15-01 |
| 3 | No action effect metadata, app title or description | P15-02 |
| 4 | Every tool of every app listed at once; results JSON text only | P15-03 |
| 5 | MCP sessions in process memory | P15-04 |
| 6 | A person's credential used through a chat client is `human`, so agent-only guardrails stop applying | P15-06 |
| 7 | No OAuth discovery; chat products cannot connect | P15-07 |
| 8 | Registry global, in memory, keyed by app ID; credentials a static `appId → secret` map | P15-05, P15-08 |
| 9 | Shared HS256 secret on every app host; hosts accept any workspace's tokens | P15-09, P15-12 |
| 10 | `assertPublicDns` never called | P15-10 |
| 11 | **An app is "alive" only while it heartbeats every 30 s; after 90 s silent its tools vanish and calls are refused. The heartbeat itself keeps apps awake.** | P15-05, P15-14 |
| 12 | **Hosts run background timers (heartbeat, outbox, event delivery, workflow polling) that assume the process keeps running** | P15-15 |
| 13 | Apps cannot call other apps' actions | P15-13 |

---

## 4. Design decisions

### 4.1 The gateway is the central MCP server

It already owns the registry, auth, scopes, token exchange, progress relay, audit and limits. `/w/<workspace>/mcp/<appId>` stays as a filtered view of the same server. Domain code never runs in the gateway; MCP logic stays in `@embody/mcp`.

### 4.2 Workspaces and teams

- **Registry key:** `(workspace, appId)`. Two workspaces may each have a `crm` with different plugins, addresses and versions.
- **Registration credentials** are bound to one `(workspace, appId)` and optionally a team; the registration's workspace and team come from the credential.
- **Every read path** (catalog, MCP, dispatch, events, CLI) filters by the caller's workspace. Nothing is cross-workspace.
- **Teams** are registration metadata (owner) and a grouping in discovery. Access is decided by scopes, which identity providers can map from team groups (P15-07). Principal-level team membership is deferred.
- **One-workspace gateways** keep today's unprefixed `/mcp` and `/api/...` via `defaultWorkspace`.

### 4.3 Workspace in the URL

OAuth discovery happens before the client has a token, so the URL names the workspace: `https://gateway.example.com/w/<workspace>/mcp` (also `/w/<workspace>/mcp/<appId>`, `/w/<workspace>/api/...`). The authenticated principal's workspace must equal the URL's (`403` otherwise).

### 4.4 Stateless gateway

| State | Where it lives |
|---|---|
| Registrations, credentials, workspace configuration, app status and next due times | `GatewayStore`: in-memory for development and tests, **PostgreSQL** for any real deployment |
| MCP sessions | **None.** Stateless Streamable HTTP |
| Rate limits | Per instance until load data shows a need for a shared limiter |
| Audit | `AuditSink` (JSON lines by default) |
| Caches | Per instance, per workspace, seconds, keyed by registry revision; disposable |

Startup loads only configuration; everything else is read lazily per request, so a cold gateway instance serves correctly. If the store cannot be read, requests fail closed with a clear "temporarily unavailable" error, never an empty or permissive catalog.

### 4.5 Compact discovery

Companies run many small apps, so compact discovery is the normal case. Above a tool-count threshold (default 40), `/mcp` lists `embody_apps`, `embody_describe`, `embody_read` (read-only) and `embody_write` (destructive), plus named tools of apps selected with `?apps=`. Clients approve per tool name, so an "always allow" on reads never covers a delete. **Listing tools never wakes an app:** everything comes from the saved registration.

### 4.6 Delegated agent principal

A call that arrives through MCP is an **agent** call made **on behalf of** the credential's subject (`actorType: "agent"`, `delegation: { subjectId, subjectType, client? }`). Agent credentials and the HTTP API are unchanged. Implemented in P15-06.

### 4.7 Gateway → app tokens: asymmetric and workspace-bound

ES256 with a published JWKS and `kid` rotation; app hosts hold no signing secret and reject tokens for any other workspace. HS256 only on one-workspace gateways, for one release. (Hosting decision HD05 is the same decision; Phase 15 implements it.)

### 4.8 OAuth resource server

Per-workspace protected-resource metadata, `401` challenges, tokens validated by the workspace's identity provider with the workspace MCP URL as audience, a per-workspace scope policy (OAuth scopes, roles or team groups → Embody scopes), `insufficient_scope` step-up. API keys keep working for developer tools and CI.

### 4.9 Apps and the gateway can sleep

#### What "asleep" means

A deployment with zero running instances. The hosting platform (Cloud Run) stops it when idle and starts it when a request arrives. Embody's job is to never need a running instance to *know* about an app, never keep an app awake by itself, and always wake an app when there is work for it.

#### Registration without heartbeats

- An app is registered **once per version**: by the deploy pipeline (`embody register`) or at startup. Re-registering the same version is a cheap no-op.
- Registrations are saved until removed. Heartbeats become **optional** (`GATEWAY_HEARTBEAT=off` is the default in sleep mode); always-on, self-hosted apps may keep them.
- The gateway never polls or pings apps.

#### Status from real calls

| Status | Meaning | Tools listed? | Calls |
|---|---|---|---|
| `ready` | The last call succeeded recently | Yes | Routed |
| `idle` | No recent traffic; normally asleep | **Yes** | Routed; the call wakes it |
| `unavailable` | Several consecutive calls failed even after waiting for wake-up | Yes, marked unavailable in `embody_apps` | Routed (to detect recovery); clear error if it still fails |

Tools are never removed because of status, so a chat client's tool list never changes under the user. A successful call restores `ready`. Status writes are rate-limited (at most one write per app per minute while nothing changes) so busy apps do not hammer the store.

#### No errors because something was asleep

1. **Wake-tolerant calls.** The gateway allows a configurable wake budget (default 30 s) for the first connection and sends an MCP progress message ("Starting Deal Nudger…") when the client supplied a progress token, so clients keep waiting.
2. **Safe retries only.** During the wake budget the gateway retries when the request provably never reached the app (connection refused, DNS failure, platform `503`/`429` before any response). It also retries after an ambiguous failure only for `read` or `idempotent` actions. Other writes are never retried blindly; an ambiguous outcome returns "outcome unknown, check before retrying" with the request ID.
3. **Clear failure.** If an app does not wake within the budget: "Deal Nudger did not start. Try again in a minute." Never a generic failure. After three consecutive wake failures the app shows `unavailable` until a call succeeds or a new version registers.
4. **Discovery never wakes apps** (§4.5), and an idle MCP client keeps nothing open to apps.
5. **Events wake their receiver.** Delivering an event is an ordinary request to the receiving app. Failed deliveries stay in the sender's database and are retried as due work.
6. **Due work wakes its app.** See below.

#### Work that happens without a user

Apps also have work nobody is waiting for: events to publish, delivery retries, delayed workflow steps.

- **During a request** (sleep mode): after the transaction commits, the host publishes and delivers the events that request created **before responding**, within a time budget. Anything left (for example a receiver that is down) stays in the database as due work.
- **Next due time.** Every response from an app in sleep mode carries its earliest pending due time (`x-embody-next-due`), and the wake endpoint returns it too. The gateway saves it on the registration.
- **Wake sweep.** A platform scheduler (Cloud Scheduler on Cloud Run, cron elsewhere) calls the gateway's protected `/internal/wake-due` once a minute. The gateway calls `POST /embody/wake` on every app whose due time has passed, with a short-lived system token. The app runs a bounded batch of due work (outbox, deliveries, workflow steps) under its existing leases, then reports the next due time.
- **Lost hints are not lost work.** If an app crashes between committing work and reporting its due time, the work is still in its database. It runs the next time the app wakes for any reason, and a **daily safety wake** of every app with activity in the last 30 days guarantees an upper bound.
- This is deliberately simpler than the hosting plan's full due-work reconciler with Cloud Tasks (hosting CH9-02/CH9-03), which can replace the sweep later behind the same `/embody/wake` contract when stronger timing and scale guarantees are needed.

#### Sleep mode for app hosts

`EMBODY_RUNTIME=sleep` (the default for hosted deployments; `always-on` stays the default for local and self-hosted):

- no heartbeat, outbox, delivery or workflow timers;
- startup does no business work and no migrations;
- registration at startup is idempotent and does not delay serving requests;
- the wake endpoint runs bounded due work;
- events created by a request are sent before responding;
- apps that declare always-running needs (custom intervals, local files) fail the sleep-mode readiness check with an explanation.

#### The gateway sleeps too

With nothing in memory and no heartbeats, a quiet gateway can scale to zero. The scheduler's once-a-minute call wakes it briefly. Hosting may still keep one warm instance for latency; that is a cost choice, never needed for correctness. (Hosting ADR 0008 requires the min-zero capability; Phase 15 makes the code capable of it.)

### 4.10 App-to-app calls

An app calls another app **in the same workspace** through the gateway with its own **system** identity and scopes granted to that app, through the same dispatch pipeline (scope checks, rate limits, audit, wake handling). The target's hooks see which app is calling. Calls never leave the workspace. Part of the MVP (P15-13).

---

## 5. Trade-offs of sleeping

| Trade-off | What users notice | Mitigation |
|---|---|---|
| Cold start | First request after a quiet period takes ~1–5 s, longer if the gateway also slept | "Starting…" progress message; optional warm gateway |
| Events sent before responding | Actions that publish events respond slightly later | Bounded budget; only for event-producing actions |
| Due-work timing | Delayed steps and retries run within about a minute of their due time | One-minute sweep; hosting reconciler later for tighter timing |
| Interrupted writes | Rarely, "outcome unknown, check before retrying" | Automatic retry only when provably safe |
| Tool list changes | New apps appear in a new conversation | — |
| Unsupported patterns | Apps needing always-running loops or local files cannot use sleep mode | Readiness check explains why; always-on mode remains for self-hosting |
| Cost floor | Database, scheduler and logging do not sleep | Shared across all apps |
| Two runtime modes | `sleep` and `always-on` both need tests | Shared conformance suite |

---

## 6. Compatibility and upgrade

| Change | Existing deployments |
|---|---|
| Informative errors; delegated agent on MCP | Release notes; `mcp.actor: "token"` for one release |
| Workspace-keyed registry and credentials | Old `appId → secret` config accepted with `defaultWorkspace` for one release |
| Two workspaces sharing one app deployment | Not supported; each workspace gets its own deployment |
| Asymmetric gateway tokens | HS256 only on one-workspace gateways, for one release |
| Heartbeats | Optional; still accepted from always-on hosts |
| Host runtime mode | `always-on` default locally and self-hosted; `sleep` for hosted |
| `/mcp`, `/api/...` | Unchanged with `defaultWorkspace`; `/w/<workspace>/...` otherwise |

---

## 7. MVP and fastest path

**MVP:** people in several companies use their own single-tenant apps from Claude Desktop, Claude web, Claude Code, Codex, ChatGPT and Cursor through one multi-tenant gateway, with workspaces and teams, agent rules enforced, a complete audit log, apps calling each other inside a workspace, and apps and the gateway sleeping when idle without user-visible errors.

| Stage | Items | Rough size |
|---|---|---|
| 0. Align plans | ADR numbering, terms and ownership with the hosting plan (this change) | 1–2 days |
| 1. Gateway core | P15-01, P15-02, P15-06 (open PRs) · P15-03 MCP metadata and compact discovery · P15-04 stateless MCP · P15-05 workspace store, routing, teams and status · P15-08 PostgreSQL store | ~2.5 weeks |
| 2. Sleep | P15-14 sleep-safe gateway (wake-tolerant calls, safe retries, due-time sweep) · P15-15 host sleep mode (no timers, events before response, wake endpoint, readiness check) | ~2 weeks |
| 3. Workspace safety | P15-09 workspace-bound tokens · P15-12 single-tenant hosts · P15-10 endpoint safety and limits · P15-11 isolation suite | ~1.5 weeks |
| 4. Chat products | P15-07 OAuth per workspace | ~1 week |
| 5. Apps call apps | P15-13 app-to-app calls | ~1.5 weeks |
| 6. Prove on Cloud Run | P15-16 MVP proof: reference apps and the gateway reach zero and wake on calls, events and due work | ~1 week |
| **Total** | | **~10 weeks, one engineer** |

After the MVP, the hosting plan's remaining sleep work (full due-work reconciler with Cloud Tasks, version-pinned wake, restore fences, launch evidence) builds on the same contracts.

---

## 8. Relationship to the hosting plan

| Topic | Owner | Notes |
|---|---|---|
| Gateway code: catalog, MCP, dispatch, store, status, wake-tolerant calls, due-time sweep | **Phase 15** | Hosting CH9-04 and CH9-07 framework parts are delivered here |
| Workspace-bound asymmetric tokens | **Phase 15** (P15-09) | = hosting HD05 |
| Persistent registry and gateway sessions | **Phase 15** (P15-04, P15-05, P15-08) | = hosting HD15 registry/session parts; MCP is stateless |
| Host sleep mode, wake endpoint, bounded due work | **Phase 15** (P15-15) | First slice of hosting CH9-01 |
| Cloud Run services, min-zero profiles, Cloud Scheduler wiring, deploy-time registration | **Hosting** | P15-16 uses a minimal version as MVP proof |
| Full due-work reconciler, Cloud Tasks, dispatcher, version-pinned wake, restore fences | **Hosting** (CH9-02, CH9-03, CH9-05) | Replaces the MVP sweep behind the same wake contract |
| Launch evidence V19–V22, cost model | **Hosting** (CH9-06, CH9-07 evidence) | — |
| Accounts, invitations, billing, previews, builds | **Hosting** | Workspace = the hosting plan's workspace |

---

## 9. Explicitly deferred

- `tools/list_changed` notifications, MCP sessions, per-session app activation.
- Shared rate-limit store; principal-level team membership.
- Anything cross-workspace.
- Distribution of customized apps (templates, plugin catalog).
- Transparent stdio bridge, `embody login`, MCP in `embody dev`, development authorization server.
- Per-workspace hostnames, app icons, MCP tasks, app-declared prompts and resources, event notifications to chat, chat GenUI.

## 10. Open questions

| Question | Needed by |
|---|---|
| Which identity provider(s) first, and which client registration methods chat clients use with them | P15-07 (M0 spike) |
| Where the gateway signing key lives (cloud KMS choice) | P15-09 |
| Do any target clients require MCP sessions? | P15-04 (M0 spike) |
| Default wake budget and sweep interval on real Cloud Run | P15-16 measurements |

## 11. Phase 14 note

Commit `ec7ca78` (Phase 14 GenUI, on `docs/genui-incremental-plan`) is not on `main` and rewrites `packages/mcp/src/index.ts`. Its per-session catalog snapshot does not survive stateless MCP and should become a per-request generation check when rebased onto Phase 15.
