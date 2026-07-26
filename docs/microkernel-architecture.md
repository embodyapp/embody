# Microkernel Architecture in Embody

This document provides an in-depth explanation of the **Microkernel Architecture** in **Embody**, detailing why it was selected, how it works under the hood, and what capabilities it unlocks for developers and enterprises.

---

## 🎯 Overview

At the heart of Embody is **`@embody/kernel`**, a lightweight, zero-business-logic microkernel engine. The kernel serves as the foundational coordinator of the entire system: it manages plugin lifecycles, enforces capability sandboxing, orchestrates dependency injection (DI), maintains hook and middleware pipelines, dispatches domain events, and provides a unified execution context across all transports.

```text
┌─────────────────────────────────────────────────────────────┐
│                    @embody/host (HTTP Server)               │
├─────────────────────────────────────────────────────────────┤
│                    @embody/kernel (Microkernel Engine)      │
│   (Lifecycle, Capability Sandboxing, DI Registry, Hooks)    │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
               ▼                               ▼
    ┌────────────────────┐          ┌────────────────────┐
    │  @embody/core      │          │  @embody/crm       │
    │  (Shared Plugin)   │◄─────────┤  (App Plugin)      │
    └────────────────────┘          └────────────────────┘
```

---

## ❓ 1. Why Was Microkernel Architecture Selected?

### The Architectural Dilemma in Headless Business Systems
Building an open-source, extensible business operating system presents a classic architectural trade-off:

* **Monolithic Frameworks**: Traditional SaaS and CRM monoliths hardcode domain entities (deals, accounts, invoices, tickets) directly into core application controllers and models. Customizing behavior forces developers to fork the codebase. When upstream framework updates arrive, merging them causes severe merge conflicts ("fork and diverge" trap).
* **Microservices Architecture**: Splitting features into autonomous network services introduces extreme DevOps overhead, high network latency, complex distributed transactions, split-brain data models, and broken cross-domain queryability (e.g. running a unified query across CRM, support, and billing).
* **The Microkernel Solution**: Embody selects a **microkernel pattern** (`@embody/kernel`) to combine monolithic operational simplicity and high performance with total modular isolation and zero-fork extensibility.

### Core Rationale & Strategic Benefits

1. **Zero Business Logic in Core**
   The kernel contains no knowledge of CRM, ERP, finance, or users. All business logic is encapsulated in plugins (`@embody/core`, `@embody/crm`, third-party or custom app plugins). First-party plugins use the exact same Service Provider Interface (SPI) as custom plugins written by end-user developers.

2. **Customization Without Forking (Design Decision D8)**
   An enterprise deploying Embody installs core packages from npm (`@embody/kernel`, `@embody/crm`). Custom rules (e.g. HIPAA restrictions, custom fields, validation gates) are implemented via separate local plugins or custom fields without editing code inside `node_modules`. Upgrades are simply `npm update`, not a complex git merge.

3. **Enforced System-Wide Safety Guarantees**
   Rather than relying on developer discipline in every plugin, the microkernel systematically enforces critical platform rules across all plugins:
   * **Multi-Tenancy (D1)**: PostgreSQL Row-Level Security (`org_id`) applied at the database transaction layer.
   * **Central Authorization (D4)**: Permission evaluation (`ctx.can`) checked before execution.
   * **Capability Sandboxing (D7)**: Every plugin declares a `CapabilityManifest`; the kernel rejects unauthorized service calls, entity access, or event triggers at boot time.

4. **Unified Transport Execution**
   AI agents (over MCP), developer CLI scripts, and web UI dashboards (over the `/api` tool bridge) all pass through a single kernel executor. One action registration automatically powers all interfaces.

---

## ⚙️ 2. How Does the Microkernel Work?

### Architecture & Components of `@embody/kernel`

The `@embody/kernel` package exposes several core abstractions that coordinate runtime execution:

* **`EmbodyKernel`**: The central orchestrator class. Manages plugin registration, capability validation, lifecycle execution, and context generation.
* **`PluginManager`**: Performs capability verification and dependency graph resolution using a **Topological Sort algorithm** (`topoSort`).
* **`ServiceRegistry`**: Manages Dependency Injection (DI). Plugins publish service implementations via `provides()` and retrieve typed services via `ctx.services.get()`.
* **`HookRegistry`**: Maintains synchronous, in-transaction, vetoable domain hooks (`beforeCreate`, `beforeDelete`, custom hooks).
* **`OrderedMiddlewarePipeline`**: Manages global and plugin-level HTTP request middleware execution order.
* **`CollectingMcpRegistrar` & `CollectingCliRegistrar`**: Collects Model Context Protocol (MCP) tools/resources and CLI subcommands registered by loaded plugins.
* **`EventBus` & Outbox**: Dispatches post-commit asynchronous domain events (`deal.created`, `invoice.paid`) backed by a durable PostgreSQL outbox table.

---

### The 13-Phase Boot Lifecycle

When `boot()` is invoked on `EmbodyKernel`, the system executes a strict 13-phase boot sequence:

```text
 1. Select Plugins       Read embodiment configuration (embody.config.ts)
 2. Topo-Sort            Order plugins topologically by dependsOn (core before crm)
 ─── For each plugin in topological order ───
 3. Validate Caps        Verify plugin capability manifest permissions
 4. Run Migrations       Delegate SQL schema migrations to database runner (runMigrations)
 5. Register Services    Publish DI service implementations into ServiceRegistry
 6. Init Phase           Execute plugin init(ctx) (safely consumes registered services)
 7. Register Middleware  Add HTTP middleware to OrderedMiddlewarePipeline
 8. Register Hooks       Wire synchronous, in-transaction domain hooks into HookRegistry
 9. Register Routes      Mount plugin HTTP endpoints onto Hono router
10. Register MCP         Register MCP AI tools & resources (used by AI, CLI, & UI bridge)
11. Register CLI         Mount CLI subcommands into CollectingCliRegistrar
12. Subscribe Events     Attach post-commit event listeners to EventBus outbox
 ─── Boot Complete ───
13. Ready & Serve        Start HTTP host server (/health, /api bridge) & stdio MCP server
```

#### Why Boot Order Matters:
* **Pass 1 (Migrations & Services)**: Dependencies load first so database schemas exist before initialization, and DI services are registered before any plugin's `init()` method executes.
* **Pass 2 (Init)**: `init(ctx)` allows plugins to safely retrieve dependent services (e.g. consuming `core.registry`).
* **Pass 3 (Middleware, Hooks, Routes, MCP, CLI)**: Middleware mounts *before* routes to wrap incoming requests. Tools and hooks register after full plugin construction.
* **Pass 4 (Event Subscriptions)**: Event handlers attach after all systems are online.

---

### Capability Sandboxing (`CapabilityManifest`)

Every plugin explicitly declares what resources it touches via a capability manifest:

```typescript
export const crmPlugin: EmbodyPlugin = {
  id: "crm",
  schema: "crm",
  dependsOn: ["core"],
  capabilities: {
    entities: ["crm.deal", "crm.contact_profile"],
    services: {
      provide: ["crm.pipeline"],
      consume: ["core.registry"],
    },
    hooks: ["crm.deal.beforeClose"],
    events: {
      publish: ["crm.deal.won"],
      subscribe: ["billing.invoice.paid"],
    },
  },
  // ...
};
```

When building a `KernelContext` (`#contextFor(plugin)`), the kernel creates scoped accessors (`ctx.services`, `ctx.hooks`). If a plugin attempts to consume an undeclared service or trigger an undeclared hook, the kernel throws a runtime security error.

---

### Unified Executor & Transport Abstraction

Every tool action in Embody executes through `@embody/host`'s `makeExecutor`:

1. Constructs a `RequestContext` bound to the caller's identity (`principal`) and active tenant (`org_id`).
2. Opens a PostgreSQL tenant transaction (`withTenant`) enforcing Row-Level Security (RLS).
3. Evaluates permissions (`ctx.can(action, resource)`).
4. Executes pre-write vetoable hooks.
5. Performs database updates & queues outbox events within the same transaction.

Whether invoked by an AI agent over stdio MCP, a developer running `embody call`, or a user clicking a button in `@embody/react`, the execution path is identical.

---

## 🚀 3. What Does the Microkernel Allow?

### 1. Zero-Fork Enterprise Customization
* **Database Customization**: Extend entities without SQL migrations using GIN-indexed `custom_fields` (JSONB) or create dedicated custom plugins with separate Postgres schemas (`custom_app.*`).
* **Business Rule Enforcement**: Add custom validation logic (e.g., "deals > $100k require CFO approval") by attaching a `beforeCreate` or `beforeUpdate` hook in a custom plugin. The rule binds every transport (AI agent, CLI, web UI) identically.
* **Clean Upgrade Seam**: Core framework updates are applied via `npm update @embody/kernel @embody/crm`. Because zero framework code is edited locally, upgrades never conflict.

### 2. Deep Plugin Interoperability & Composition
Plugins don't just coexist; they actively compose:
* **Synchronous Vetoable Hooks**: Plugin B can intercept and abort an operation initiated by Plugin A in real-time. If a compliance check fails, throwing an error rolls back the entire database transaction.
* **Dependency Injection (DI)**: Plugins expose stable interfaces via `ctx.services.provide()`. Plugin A can call Plugin B's service without direct module coupling.
* **Per-App Facets on Shared Core**: Core entities (`core.parties`) are extended by app-specific profile tables (`crm.contact_profiles`, `billing.customer_profiles`). One central entity can have multiple app facets without data duplication.

### 3. Single-Definition, Multi-Transport Exposure
By registering an MCP tool in `registerMcpTools`, a plugin author automatically unlocks four distinct surfaces:
1. **AI Agent Tool**: Exposed over the MCP stdio server for Claude, Gemini, or custom LLM agents.
2. **CLI Subcommand**: Callable via `embody call tool_name`.
3. **HTTP API Bridge**: Automatically mounted under `POST /api/tools/:name`.
4. **React Frontend Hook**: `@embody/react` provides typed hooks (`useToolMutation("tool_name")`) that communicate over the HTTP bridge.

### 4. Robust Multi-Tenant Security & Isolation
* **Row-Level Security (RLS)**: Enforced by Postgres at the database transaction level using `app.current_org`. Even raw SQL queries executed by a plugin cannot leak data across tenants.
* **Sandboxed Capability Enforcement**: Plugins cannot quietly inspect or interfere with other plugins unless explicit permissions are declared in their `capabilities` manifest.

---

## 📊 Summary Comparison

| Architectural Metric | Traditional Monolith | Microservices Architecture | Embody Microkernel |
| :--- | :--- | :--- | :--- |
| **Domain Logic Location** | Hardcoded into application core | Fragmented across network services | Isolated inside plugins; zero in kernel |
| **Customization Method** | Source code modification / forking | Replacing or proxying services | Custom plugins, vetoable hooks, DI services |
| **Upgrades** | Complex git merges | Independent, but high API breaking risk | `npm update` (clean SPI seam) |
| **Data Isolation** | Application-level SQL `WHERE` clauses | Separate database per service | Postgres RLS (`org_id`) in unified DB |
| **Execution Path** | Disparate REST / GraphQL endpoints | Service mesh & API gateways | Single Unified Executor (MCP, CLI, UI bridge) |

---

## ➡️ Related Documentation

* [**Architecture Overview**](file:///Users/nimrodfeldman/playground/embody/docs/architecture-overview.md) — High-level architecture and core design decisions (D1–D8).
* [**Writing Plugins**](file:///Users/nimrodfeldman/playground/embody/docs/writing-plugins.md) — Step-by-step guide to building custom plugins.
* [**Middleware & Hooks**](file:///Users/nimrodfeldman/playground/embody/docs/middleware-and-hooks.md) — Deep dive into request pipelines and vetoable domain hooks.
* [**Security & Multi-Tenancy**](file:///Users/nimrodfeldman/playground/embody/docs/security-and-multitenancy.md) — RLS policies, tenant scoping, and authorization.
