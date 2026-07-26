# Architecture Overview — How Embody Works

This document explains the core architecture of **Embody** in simple language. If you are new to the codebase or building custom features, start here!

---

## 🎯 The Core Philosophy: Microkernel Architecture

Most traditional enterprise web apps are built as a monolithic "all-in-one" app or a scattered web of microservices. Embody uses a **Microkernel Architecture**:

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

1. **The Kernel contains ZERO business logic**: `@embody/kernel` only manages plugin lifecycle, capability checking, service registration (DI), middleware pipelines, and event dispatches.
2. **First-party features are plugins**: Even core apps like CRM (`@embody/crm`) are written as plugins on the exact same framework you use to write your own custom plugins.

> [!NOTE]
> For an in-depth breakdown of why the microkernel pattern was selected, how it works under the hood, and what capabilities it unlocks, see the [**Microkernel Architecture Deep Dive**](file:///Users/nimrodfeldman/playground/embody/docs/microkernel-architecture.md).

---

## 🏛️ The Eight Core Design Decisions

Embody was built around **eight fundamental design decisions (D1–D8)**:

### D1. Multi-Tenant from Day One
- Every business table in Postgres contains an **`org_id`** column.
- PostgreSQL **Row-Level Security (RLS)** policies automatically hide rows belonging to other tenants. You can never accidentally leak customer data to another company because the database itself enforces isolation!

### D2. Relational-First Data + Thin Registry
- Plugins own real, typed Postgres tables (e.g. `crm.deals` with typed columns like `amount` numeric).
- On top sits a lightweight **Entity Registry** (`core.entities`). It is a pointer table (holding `source_schema`, `source_table`, `source_id`) used strictly for **global search**, **cross-app relationships**, and **audit logging**.

### D3. Shared Core Entities, Per-App Facets
- A single real-world entity (like a Person) shouldn't be duplicated across multiple apps.
- `@embody/core` owns the shared `parties` table.
- The CRM app attaches a **facet table** (`crm.contact_profiles(party_id -> core.parties.id)`).
- **One party, many app facets!**

```text
                 ┌─────────────────────────┐
                 │    core.parties         │
                 │ (Person: "Jane Smith")  │
                 └────────────┬────────────┘
                              │
               ┌──────────────┴──────────────┐
               ▼                             ▼
  ┌─────────────────────────┐   ┌─────────────────────────┐
  │  crm.contact_profiles   │   │  billing.customer_profile│
  │ (Title: "VP of Sales")  │   │  (Tax ID: "123-456")    │
  └─────────────────────────┘   └─────────────────────────┘
```

### D4. Centralized Authorization
- `core` owns `users`, `orgs`, and `memberships`.
- Authorization is checked centrally via `ctx.can(action, resource)`.
- **Every transport passes through the same security check** — an AI agent over MCP, a script over the CLI, and a browser over the `/api` tool bridge all reach a handler through the one executor. See [React Hooks & the HTTP Bridge](./react-hooks.md).

### D5. Durable Events & Outbox Pattern
- Domain events (e.g. `deal.created`) are written to a database outbox in the **same transaction** as the data change.
- Events survive server crashes and drive reliable background workflows.

### D6. Real Migrations & Schema Namespacing
- Database updates go through versioned Drizzle SQL migrations.
- Each plugin owns its own Postgres schema (`core.*`, `crm.*`, `custom_app.*`).
- Plugins declare dependencies (`dependsOn: ["core"]`), and the kernel **topologically sorts** them so core migrations run first.

### D7. Four Extension Surfaces
Plugins extend the system using 4 interception mechanisms:
1. **Middleware Pipeline**: Ordered HTTP request handlers.
2. **Domain Hooks**: Synchronous, in-transaction, **vetoable** hooks (e.g. `beforeCreate` can block a deal save).
3. **Service Registry (DI)**: Plugins publish typed services (`provides`) and consume others via `ctx.services.get()`.
4. **Contribution Points**: Named extension points for UI/logic composition.

> [!IMPORTANT]
> **Capability Manifests**: Every plugin declares what entities, services, hooks, and events it touches. The kernel sandboxes plugins and rejects unauthorized calls at boot time!

### D8. Customization Without Forking
- Companies can build their own plugins, in their own repository.
- Companies can also add dynamic fields to existing entities using GIN-indexed `custom_fields` (JSONB) without writing database migrations.
- Custom code stays separate from upstream code, allowing smooth version updates!

---

## 🔄 Plugin Lifecycle (Startup Sequence)

When Embody boots up, the kernel executes plugins in a strict sequence:

```text
 1. Select Plugins   ───► Reads configuration from embody.config.ts
 2. Topo-Sort        ───► Sorts plugins by dependsOn (e.g. core before crm)
 ─── For each plugin in order ───
 3. Validate Caps    ───► Check capability manifest permissions
 4. Migrate          ───► Run SQL schema migrations
 5. Register Services───► Publish DI services into registry
 6. Init             ───► Run setup logic (can consume other services)
 7. Register Middle. ───► Add HTTP middleware to pipeline
 8. Register Hooks   ───► Wire synchronous, vetoable domain hooks
 9. Register Routes  ───► Mount plugin HTTP routes (wrapped in authz & RLS)
10. Register MCP     ───► Mount AI tools and resources. These same tools are what the
                          CLI runs and what the /api bridge exposes to a UI.
11. Register CLI     ───► Mount CLI subcommands
12. Subscribe Events ───► Listen to post-commit domain events
 ─── Boot complete ───
13. Serve            ───► HTTP server starts: /health, then the /api tool bridge
```

---

## ➡️ Next Steps

- Read the detailed breakdown of the [**Microkernel Architecture**](file:///Users/nimrodfeldman/playground/embody/docs/microkernel-architecture.md).
- Explore the [**Directory Structure**](file:///Users/nimrodfeldman/playground/embody/docs/directory-structure.md) to locate where each package lives.
- Learn how to build your first plugin in [**Writing Plugins**](file:///Users/nimrodfeldman/playground/embody/docs/writing-plugins.md).
