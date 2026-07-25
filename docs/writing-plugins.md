# Writing Plugins in Embody

This tutorial walks you step-by-step through writing your own custom plugin for **Embody**!

Whether you are building a first-party app in `catalog/` or a custom company feature in `custom/my-plugin`, every feature in Embody is built using the exact same **`EmbodyPlugin`** contract.

---

## 🎯 What Makes Up a Plugin?

An Embody plugin is a TypeScript object implementing the `EmbodyPlugin` interface from `@embody/kernel`:

```typescript
import type { EmbodyPlugin } from "@embody/kernel";

export const myPlugin: EmbodyPlugin = {
  id: "inventory",             // Unique plugin identifier
  schema: "inventory",         // Postgres schema name owned by this plugin
  dependsOn: ["core"],        // Dependencies loaded before this plugin
  capabilities: {              // Capability manifest (sandboxing)
    entities: ["inventory.item"],
    services: { consume: ["core.registry"] },
    events: { publish: ["inventory.item.created"] },
  },
  // Lifecycle hooks & registration methods go here!
};
```

---

## 📝 Step-by-Step Guide to Building a Plugin

Let's build a sample **Inventory Plugin** (`id: "inventory"`) that tracks warehouse products!

### Step 1: Declare the Capability Manifest

Before your plugin touches the database, registers hooks, or consumes services, you must declare its capabilities. The kernel uses this manifest to sandbox plugins for security.

```typescript
capabilities: {
  entities: ["inventory.item"],              // Entity types owned by this plugin
  services: {
    provide: ["inventory.checker"],         // DI services published by this plugin
    consume: ["core.registry"],             // DI services consumed from other plugins
  },
  hooks: ["inventory.item.beforeCreate"],    // Vetoable domain hooks allowed
  events: {
    publish: ["inventory.item.created"],    // Post-commit domain events allowed
    subscribe: ["crm.deal.won"],            // Domain events subscribed to
  },
}
```

---

### Step 2: Database Schema & Migrations

Each plugin owns its own PostgreSQL schema (`schema: "inventory"`). Specify where your migration SQL files live:

```typescript
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

export const inventoryPlugin: EmbodyPlugin = {
  id: "inventory",
  schema: "inventory",
  migrations: {
    dir: migrationsDir,
    schema: "inventory",
  },
  // ...
};
```

Your migration SQL (`migrations/0001_create_items.sql`) creates the table:

```sql
CREATE SCHEMA IF NOT EXISTS inventory;

CREATE TABLE inventory.items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Turn on Row-Level Security (RLS) for tenant isolation
ALTER TABLE inventory.items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON inventory.items
  USING (org_id = current_setting('app.current_org')::uuid);
```

---

### Step 3: Register DI Services (`provides`)

Publish typed helper functions into the shared Dependency Injection (DI) registry so other plugins can consume them safely:

```typescript
provides(ctx) {
  return [
    {
      name: "inventory.checker",
      version: "1.0.0",
      impl: {
        checkStock: async (sku: string) => {
          ctx.logger.info(`Checking stock for SKU: ${sku}`);
          // Query stock logic here...
          return 42;
        },
      },
    },
  ];
}
```

---

### Step 4: Plugin Setup (`init`)

The `init` method runs after services are registered. Here you can retrieve services published by other plugins (like `core.registry`):

```typescript
async init(ctx) {
  ctx.logger.info("Inventory plugin initialised successfully!");
  
  // Consume a service from @embody/core
  const registry = ctx.services.get("core.registry");
}
```

---

### Step 5: Mount HTTP Routes (`registerRoutes`)

Embody uses **Hono** for routing. Use this for liveness and info endpoints — **not for data access.**

> [!IMPORTANT]
> **Do not build a data API here.** A raw route is a hand-written path where it is on you to
> remember `ctx.tx`, `req.assert`, and the hook chain — and the framework's own demo routes
> were deleted precisely because they skipped them. Put data access in `registerMcpTools`
> (Step 6) instead: those tools are automatically callable by an AI agent, by the CLI, **and
> by a UI** over the `/api` bridge, all through the one executor. One registration, four
> transports. See [React Hooks & the HTTP Bridge](./react-hooks.md).

```typescript
registerRoutes(router, ctx) {
  router.get("/inventory/items", async (c) => {
    return c.json({
      plugin: "inventory",
      items: [
        { sku: "WIDGET-01", qty: 100 },
        { sku: "GADGET-02", qty: 50 },
      ],
    });
  });
}
```

---

### Step 6: Expose AI Tools via MCP (`registerMcpTools`)

Model Context Protocol (MCP) lets AI assistants call your plugin's tools safely using **Zod** schema validation:

```typescript
import { z } from "zod";

registerMcpTools(mcp, ctx) {
  mcp.tool({
    name: "inventory_add_item",
    description: "Add a new item to warehouse inventory.",
    input: z.object({
      sku: z.string().min(1),
      quantity: z.number().int().positive(),
    }),
    handler: (input, req) => {
      // Check authorization (Must have write permission for inventory:item)
      req.assert("write", "inventory:item");

      // Execute within tenant database transaction
      return req.tx(async (tx) => {
        const [item] = await tx`
          INSERT INTO inventory.items (org_id, sku, quantity)
          VALUES (${req.orgId}, ${input.sku}, ${input.quantity})
          RETURNING id, sku, quantity;
        `;
        return item;
      });
    },
  });
}
```

---

## ⚡ Plugin Startup Sequence Summary

```text
provides()          ──► Register DI services
  │
init()              ──► Setup logic (consume DI services)
  │
registerMiddleware()──► Add request middleware
  │
registerHooks()     ──► Wire vetoable domain hooks
  │
registerRoutes()    ──► Mount info/liveness HTTP endpoints
  │
registerMcpTools()  ──► Expose actions: AI tools = CLI actions = the UI's API
  │
subscribe()         ──► Listen to post-commit events
```

---

## ➡️ Next Steps

- Learn how to intercept requests and domain logic in [**Middleware & Hooks**](file:///Users/nimrodfeldman/playground/embody/docs/middleware-and-hooks.md).
- Read how AI assistants call your plugin in [**AI & MCP Integration**](file:///Users/nimrodfeldman/playground/embody/docs/mcp-and-ai.md).
