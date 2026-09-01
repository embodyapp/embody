# 02. Plugin Microkernel SPI Specification

## 1. Microkernel Design Principles

The Embody microkernel runtime (`@embody/core`) is built on three core tenets:
1. **Zero Core Business Logic**: The kernel contains zero application domain logic. All entities, workflows, actions, and services live in plugins.
2. **Deterministic Multi-Phase Boot**: Plugins are ordered topologically according to their dependency graph (`dependsOn`) and initialized deterministically.
3. **Synchronous Vetoable Guardrails**: Plugins can intercept operations triggered by agents before they reach the database and reject them synchronously.

---

## 2. Plugin Contract (`EmbodyPlugin`)

```typescript
import { z } from "zod";

export interface EmbodyPlugin<TConfig = unknown> {
  id: string;
  version: string;
  dependsOn?: string[];
  config?: TConfig;

  /**
   * Register dependency injection services for other plugins to consume.
   */
  services?: (ctx: KernelContext) => Record<string, unknown>;

  /**
   * Declarative entity definitions with auto-CRUD generation.
   */
  entities?: Record<string, EntityDefinition>;

  /**
   * Custom action tools (exposed as CLI commands and MCP tools).
   */
  actions?: Record<string, ActionDefinition>;

  /**
   * Synchronous, in-transaction vetoable domain hooks.
   */
  hooks?: Record<string, HookHandler>;

  /**
   * Multi-step durable workflows.
   */
  workflows?: Record<string, WorkflowDefinition>;

  /**
   * Post-commit asynchronous outbox event listeners.
   */
  events?: Record<string, EventHandler>;

  /**
   * Plugin initialization callback.
   */
  init?: (ctx: KernelContext) => Promise<void> | void;
}
```

---

## 3. Kernel Context (`KernelContext`)

Every action, hook, and service receives a typed `KernelContext` scoped to the current execution and tenant:

```typescript
export interface KernelContext {
  /**
   * Authenticated principal (human user or AI agent).
   */
  principal: Principal;

  /**
   * Active tenant / organization ID.
   */
  orgId: string;

  /**
   * Universal entity store accessors.
   */
  entities: Record<string, EntityStoreAccessor>;

  /**
   * Access to registered DI services.
   */
  services: {
    get<T = unknown>(serviceKey: string): T;
  };

  /**
   * Durable event publishing into the transactional outbox.
   */
  events: {
    publish<T = unknown>(eventName: string, payload: T): Promise<void>;
  };

  /**
   * Real-time progress reporter for long-running CLI/MCP tasks.
   */
  progress(update: { percent?: number; message: string }): void;

  /**
   * Permission check utility.
   */
  can(action: string, resource?: string): Promise<boolean> | boolean;
}
```

---

## 4. Boot Sequence & Lifecycle

When `app.boot()` or `app.listen()` is called on the host, the kernel runs a strict 7-phase sequence:

```text
1. Resolve & Topo-Sort Plugins (Check circular dependencies & validate dependsOn)
2. Run Database Migrations / Schema Ensure (Ensure embody_entities & embody_outbox tables)
3. Register Services into ServiceRegistry (Publish DI service singletons)
4. Execute Plugin init(ctx) (Allow plugins to consume dependent services)
5. Wire Hooks & Register Entity Auto-CRUD Actions
6. Mount MCP Tools & Register CLI Subcommands
7. Start Outbox Worker & Open HTTP/SSE Ingress
```

---

## 5. Vetoable Guardrails (Domain Hooks)

Guardrails allow organization policy and custom plugins to veto unsafe AI agent behavior in-flight:

```typescript
export const safetyPlugin = definePlugin({
  id: "safety-guardrails",
  hooks: {
    // Intercepts any update to kanban cards
    "kanban.card.beforeUpdate": async ({ current, patch }, ctx) => {
      // Rule: AI Agent cannot move card to 'done' without a linked PR
      if (ctx.principal.actorType === "agent" && patch.status === "done" && !current.data.prUrl) {
        throw new Error("Guardrail Veto: Agents cannot mark cards done without an attached PR URL.");
      }
    },

    // Intercepts bulk email dispatch
    "email.sendBatch.beforeExecute": async ({ input }, ctx) => {
      if (input.recipients.length > 500 && !ctx.principal.roles.includes("marketing_lead")) {
        throw new Error("Guardrail Veto: Batches exceeding 500 recipients require marketing_lead role.");
      }
    }
  }
});
```
