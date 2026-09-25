# Core Concepts

> Understand the mental model and architecture that powers Embody applications.

---

## 🧠 The Embody Mental Model

Building software for autonomous AI agents requires a different mental model than building software for human web browsers.

In traditional web apps, users click buttons, navigate forms, and occasionally make mistakes that are caught by front-end form validation.

In an **agent-native application**, multiple autonomous models query data, make inferences, and execute actions concurrently. Without deterministic boundaries, agents can easily hallucinate parameters, overwrite concurrent changes, or execute unintended actions.

Embody organizes your backend into eight core abstractions:

```
┌─────────────────────────────────────────────────────────────┐
│                    1. Application (App)                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                 2. Plugins & Microkernel              │  │
│  │  ┌───────────────────────┐   ┌─────────────────────┐  │  │
│  │  │  3. Dynamic Entities  │   │  4. Typed Actions   │  │  │
│  │  └───────────┬───────────┘   └──────────┬──────────┘  │  │
│  │              │                          │             │  │
│  │  ┌───────────▼──────────────────────────▼──────────┐  │  │
│  │  │        5. Mechanical Safety Guardrails          │  │  │
│  │  │        (Pre-commit Hooks & Veto Shield)         │  │  │
│  │  └───────────────────────┬─────────────────────────┘  │  │
│  │                          │                            │  │
│  │  ┌───────────────────────▼─────────────────────────┐  │  │
│  │  │        6. Transactional Outbox & Events         │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────┐       ┌───────────────────────┐  │
│  │ 7. Principal & Identity│      │  8. Gateway & MCP Hub │  │
│  └───────────────────────┘       └───────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. Applications (`defineApp`)

An **Application** is the deployable unit in Embody. It has a unique `appId`, a semantic `version`, and a collection of **plugins**:

```typescript
import { defineApp } from "@embody/host";
import { kanbanPlugin } from "./kanban.js";
import { notificationsPlugin } from "./notifications.js";

export default defineApp({
  appId: "workspace",
  version: "1.0.0",
  plugins: [kanbanPlugin, notificationsPlugin],
});
```

When an application starts, Embody generates an **App Manifest**. The manifest compiles all entities, actions, and schemas into standard JSON Schema descriptions that AI agents can inspect dynamically.

---

## 2. Plugins & The Microkernel (`definePlugin`)

Applications are modular. Functionality is organized into **plugins** using `definePlugin`:

```typescript
import { definePlugin, z } from "@embody/core";

export const billingPlugin = definePlugin(
  {
    id: "billing",
    version: "1.0.0",
    entities: { /* ... */ },
    services: () => ({
      stripeClient: new MockStripeClient(),
    }),
  },
  (define) => ({
    actions: { /* ... */ },
    hooks: [ /* ... */ ],
  })
);
```

Plugins provide:
- **Encapsulated Namespaces**: All entities and actions are namespaced to avoid naming collisions (e.g., `workspace.billing.invoice.create`).
- **Shared Services**: Plugins can expose singleton services (like payment adapters or mailers) accessible to other actions via `context.services`.
- **7-Phase Microkernel Lifecycle**: Embody boots deterministically through 7 phases (`init`, `register_entities`, `register_services`, `register_actions`, `register_hooks`, `start`, `ready`), preventing circular dependencies and race conditions.

---

## 3. Dynamic Entities

An **Entity** represents a business object persisted to your database. Instead of writing custom SQL tables and CRUD endpoints, you define an entity using a **Zod schema**:

```typescript
entities: {
  lead: {
    description: "Prospective sales customer identified by agents",
    schema: z.object({
      email: z.string().email(),
      company: z.string().min(1),
      score: z.number().int().min(0).max(100).default(50),
      status: z.enum(["new", "contacted", "qualified", "disqualified"]).default("new"),
    }),
    indexes: ["status", "score"],
  },
}
```

From this single declaration, Embody automatically provisions:
1. **Underlying Database Storage**: Managed table in SQLite or PostgreSQL with JSONB query acceleration and automatic schema migration.
2. **Auto-Generated CRUD Tools**:
   - `create`: Insert new records with schema validation.
   - `get`: Fetch by unique ID.
   - `list`: Filter, sort, and paginate by indexed attributes.
   - `update`: Apply partial patches with an internal optimistic commit check.
   - `delete`: Delete records.
   - Define a custom action around internal `getMany` or `updateMany` accessors when callers need an atomic batch operation.
3. **Agent MCP Tools**: Introspectable tools with parameter validation schemas.

---

## 4. Typed Actions

While entities handle CRUD operations, **Actions** represent business workflows, orchestrations, and multi-step tasks:

```typescript
actions: {
  qualifyLead: define.action({
    description: "Enrich lead data and calculate qualification score",
    input: z.object({
      leadId: z.string().uuid(),
    }),
    output: z.object({
      qualified: z.boolean(),
      score: z.number(),
    }),
    handler: async ({ leadId }, context) => {
      // 1. Fetch current lead
      const lead = await context.entities.lead.get(leadId);
      if (!lead) throw new NotFoundError(`Lead ${leadId} does not exist`);

      // 2. Stream progress back to the caller
      context.progress({ percent: 50, message: "Querying enrichment provider..." });

      // 3. Update entity
      const newScore = 85;
      await context.entities.lead.update(leadId, {
        score: newScore,
        status: "qualified",
      });

      // 4. Publish domain event
      await context.events.publish("crm.lead.qualified", { leadId, score: newScore });

      return { qualified: true, score: newScore };
    },
  }),
}
```

Every action receives a rich `KernelContext` containing:
- `context.principal`: Identity and role of the caller.
- `context.entities`: Typed entity accessors.
- `context.services`: Registered plugin services.
- `context.events`: Transactional outbox event publisher.
- `context.progress({ percent, message })`: Real-time SSE progress streaming.
- `context.signal`: `AbortSignal` to stop execution if the caller cancels.

---

## 5. Mechanical Safety Guardrails (The Policy Shield)

One of the most dangerous mistakes when building AI applications is relying on system prompts for safety. Prompts like `"You must never spend more than $50 without asking"` can be easily bypassed by prompt injection or model confusion.

Embody enforces **mechanical invariants** using pre-commit hooks:

```typescript
hooks: [
  // Before an entity update commits to the database
  define.beforeUpdate("lead", ({ current, patch }, context) => {
    if (
      context.principal.actorType === "agent" &&
      patch.status === "qualified" &&
      current.data.score < 70
    ) {
      throw new HookVetoError("Agents cannot qualify leads with a score under 70.");
    }
  }),
]
```

Use scopes to restrict custom-action invocation and validate action-specific business policy in the handler before mutation. Entity hooks still protect mutations made by custom actions.

### Why Vetoable Hooks Are Different
1. **Pre-Commit Execution**: Hooks run *inside* the storage transaction. If a hook throws a `HookVetoError`, the transaction rolls back completely.
2. **Actor-Aware**: Hooks know if the caller is an `agent`, `human`, or `system`. You can enforce stricter boundaries on agents while giving human administrators full flexibility.
3. **Deterministic**: Code runs in a V8 runtime, not inside an LLM's attention heads.

---

## 6. Transactional Outbox & Events

When an agent changes state and triggers downstream jobs (e.g., sending an email, kicking off a crawler, or notifying a supervisor), standard HTTP calls suffer from the **dual-write problem**: the database updates, but the API call fails, or vice versa.

Embody uses the **Transactional Outbox Pattern**:

```
[Agent Action] ──► BEGIN TRANSACTION
                     ├── Write Entity Mutation (e.g. status: "in_review")
                     └── Write Event to Outbox (kanban.card.ready_for_review)
                   COMMIT TRANSACTION
                     │
                     ▼
             [Outbox Worker]
                     ├── Durable Delivery (at-least-once)
                     └── Cross-Plugin Event Handlers
```

Events are committed atomically with your data. The built-in `OutboxWorker` guarantees reliable delivery, even if the server crashes or restarts.

---

## 7. Principals & Actor Scoping

Every request in Embody carries an authenticated **Principal**:

```typescript
interface Principal {
  readonly orgId: string;
  readonly actorId: string;
  readonly actorType: "agent" | "human" | "system";
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}
```

- **`actorType: "agent"`**: Autonomous AI models executing via MCP or CLI.
- **`actorType: "human"`**: Human operators using the web inspector, UI, or CLI with individual credentials.
- **`actorType: "system"`**: Background workers, schedulers, and cron jobs.

By making `actorType` a first-class citizen of every database query and action invocation, policies can effortlessly attenuate agent capabilities.

---

## 8. Gateway & MCP Hub

When you run multiple Embody applications (e.g., `crm`, `ops`, `billing`), the **Embody Gateway** acts as the central control plane:
- Aggregates all tools into a single `/mcp` endpoint for your agents.
- Provides app-scoped endpoints at `/mcp/:appId` for specialized agents.
- Handles centralized JWT authentication and reverse proxy routing.

---

## 🧭 Summary Table

| Concept | What It Is | Why It Matters |
| :--- | :--- | :--- |
| **App** | Top-level deployment container | Manages configuration and manifests. |
| **Plugin** | Modular unit of functionality | Encapsulates schemas, actions, and services. |
| **Entity** | Zod-typed business object | Provides zero-config CRUD tools and database storage. |
| **Action** | Executable business logic | Runs typed workflows with streaming progress. |
| **Safety Hook** | Pre-commit state validator | Mechanically vetoes unauthorized or dangerous agent mutations. |
| **Outbox** | Transactional event queue | Eliminates dual-write failures and lost events. |
| **Principal** | Actor identity & permissions | Distinguishes agents from humans for capability attenuation. |
| **Gateway** | Central MCP control plane | Aggregates multi-app tools for agent consumption. |

Next: **[Project Structure →](./04-project-structure.md)**
