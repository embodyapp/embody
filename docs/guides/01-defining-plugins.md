# Defining Plugins & Microkernel Lifecycle

> Learn how to architect modular, reusable capabilities with `definePlugin` and understand the 7-phase microkernel boot process.

---

## 🧩 What is a Plugin?

In Embody, a **Plugin** is a self-contained domain module. A plugin packages:
- **Entities**: Business models persisted to the database.
- **Services**: Shared state, API clients, or singletons (e.g., mailers, payment adapters).
- **Actions**: Custom workflows exposed to agents and human operators.
- **Hooks**: Safety guardrails that intercept and validate state transitions.
- **Event Handlers**: Subscriptions to domain events published across the application.

By keeping plugins isolated and namespaced, you can build large, sophisticated multi-agent backends without spaghetti code or conflicting tool names.

---

## 🛠️ The Anatomy of `definePlugin`

A plugin is declared using the `definePlugin` function from `@embody/core`:

```typescript
import { definePlugin, z } from "@embody/core";

export const crmPlugin = definePlugin(
  // 1. Static Metadata & Declarations
  {
    id: "crm",
    version: "1.0.0",
    description: "Customer relationship management and lead qualification",
    
    // Dynamic entity definitions
    entities: {
      customer: {
        description: "Company customer record",
        schema: z.object({
          name: z.string().min(1),
          tier: z.enum(["starter", "growth", "enterprise"]).default("starter"),
          arr: z.number().nonnegative().default(0),
        }),
        indexes: ["tier"],
      },
    },

    // Dependency injection services
    services: () => ({
      scoringClient: new PredictiveScoringEngine(),
    }),

    // Cross-plugin domain event subscriptions
    events: {
      "billing.invoice.paid": async (event, context) => {
        // React to events published by other plugins
        console.log(`Invoice paid for customer ${event.payload.customerId}`);
      },
    },
  },

  // 2. Extension Builder (Actions & Hooks)
  (define) => ({
    actions: {
      upgradeTier: define.action({
        description: "Upgrade customer tier with automated discounting",
        input: z.object({
          customerId: z.string().uuid(),
          targetTier: z.enum(["growth", "enterprise"]),
        }),
        output: z.object({
          success: z.boolean(),
          effectiveDate: z.string(),
        }),
        handler: async ({ customerId, targetTier }, context) => {
          const customer = await context.entities.customer.get(customerId);
          if (!customer) throw new Error("Customer not found");

          await context.entities.customer.update(customerId, {
            tier: targetTier,
          });

          return { success: true, effectiveDate: new Date().toISOString() };
        },
      }),
    },

    hooks: [
      define.beforeUpdate("customer", ({ current, patch }, context) => {
        // Mechanical guardrail: agents cannot downgrade enterprise customers
        if (
          context.principal.actorType === "agent" &&
          current.data.tier === "enterprise" &&
          patch.tier &&
          patch.tier !== "enterprise"
        ) {
          throw new Error("Agents cannot downgrade Enterprise accounts without human supervisor approval.");
        }
      }),
    ],
  })
);
```

---

## ⚙️ The 7-Phase Microkernel Lifecycle

When an Embody application boots, the **Microkernel** loads all registered plugins deterministically. Rather than letting plugins run arbitrary async code at arbitrary times, Embody boots through **seven explicit phases**:

```
 ┌─────────────────────────────────────────────────────────────┐
 │ 1. INIT                Topological sort & dependency checks │
 ├─────────────────────────────────────────────────────────────┤
 │ 2. REGISTER_ENTITIES   Compile Zod schemas & auto-CRUD tools│
 ├─────────────────────────────────────────────────────────────┤
 │ 3. REGISTER_SERVICES   Instantiate singletons & DI container│
 ├─────────────────────────────────────────────────────────────┤
 │ 4. REGISTER_ACTIONS    Register custom business actions     │
 ├─────────────────────────────────────────────────────────────┤
 │ 5. REGISTER_HOOKS      Attach pre-commit safety guardrails  │
 ├─────────────────────────────────────────────────────────────┤
 │ 6. START               Open DB connections & start workers  │
 ├─────────────────────────────────────────────────────────────┤
 │ 7. READY               HTTP & MCP endpoints begin accepting │
 └─────────────────────────────────────────────────────────────┘
```

### Why Deterministic Phases Matter
- **Zero Circular Deadlocks**: Plugin dependencies are resolved topologically before initialization starts.
- **Strict Registration Ordering**: You can never invoke an entity or service in an action handler before that entity has been compiled and validated.
- **Immutable Tool Manifests**: Once the kernel reaches `READY`, the tool catalog is locked and hashed, ensuring AI agents never experience tool definitions mutating mid-session.

---

## 💉 Dependency Injection with `services`

Actions frequently require access to external APIs, mockable clients, or shared utilities. Embody provides a typed, isolated service container.

### 1. Declare Services in the Plugin Definition

```typescript
export interface PaymentGateway {
  charge(amountCents: number, currency: string): Promise<string>;
}

export const billingPlugin = definePlugin(
  {
    id: "billing",
    version: "1.0.0",
    entities: {},
    services: () => ({
      gateway: new StripePaymentGateway(process.env.STRIPE_SECRET_KEY!),
    }),
  },
  (define) => ({
    actions: {
      collectPayment: define.action({
        input: z.object({ amount: z.number() }),
        handler: async (input, context) => {
          // Retrieve service by name: "<pluginId>.<serviceName>"
          const gateway = context.services.get<PaymentGateway>("billing.gateway");
          const transactionId = await gateway.charge(input.amount, "USD");
          return { transactionId };
        },
      }),
    },
  })
);
```

### 2. Mocking Services in Tests

Because services are declared via factory functions, you can effortlessly swap out real network calls with deterministic mocks in unit and end-to-end tests:

```typescript
import { createTestHarness } from "@embody/testing";

const mockGateway: PaymentGateway = {
  charge: async () => "mock-tx-123",
};

const harness = await createTestHarness({
  plugins: [billingPlugin],
  services: {
    "billing.gateway": mockGateway, // Overrides the real service
  },
});
```

---

## 🎯 Best Practices for Plugins

1. **Keep Plugins Cohesive**: Group related entities, actions, and hooks by domain (e.g., `kanban`, `notifications`, `billing`).
2. **Never Write Cross-Plugin Direct Database Queries**: Use domain events (`context.events.publish`) or exposed actions to interact between plugins.
3. **Use Descriptive Action Descriptions**: The `description` field on actions and entities is fed directly to the LLM via MCP. Write clear, unambiguous documentation explaining what the tool does and when to use it.

Next: **[Entities & Storage →](./02-entities-and-storage.md)**
