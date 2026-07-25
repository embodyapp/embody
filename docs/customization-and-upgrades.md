# Customization & Upgrades Guide

A major design goal of **Embody** is allowing companies to heavily customize business logic, schemas, and workflows **without forking the core codebase** (Decision D8).

---

## 🏢 Real-World Scenario: B2B SaaS vs. E-Commerce Customization

To see how Embody adapts to completely different business models, examine the two fully-functional reference plugins under `examples/`:

1. [**`examples/b2b-saas`**](file:///Users/nimrodfeldman/playground/embody/examples/b2b-saas/src/plugin.ts): Enterprise B2B SaaS CRM customization.
2. [**`examples/ecom-fulfillment`**](file:///Users/nimrodfeldman/playground/embody/examples/ecom-fulfillment/src/plugin.ts): E-Commerce Retailer CRM customization.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Shared @embody/core                               │
│                         (core.parties Table)                                │
└──────────────────────┬───────────────────────────────┬──────────────────────┘
                       │                               │
                       ▼                               ▼
       ┌───────────────────────────────┐   ┌───────────────────────────────┐
       │   b2b-saas Plugin             │   │  ecom-fulfillment Plugin      │
       │   (b2bSaasPlugin)             │   │  (ecomFulfillmentPlugin)      │
       ├───────────────────────────────┤   ├───────────────────────────────┤
       │ • Account: Corporate Company  │   │ • Account: Individual Shopper │
       │ • Fields: ARR, Contract Term  │   │ • Fields: VIP Tier, Orders    │
       │ • Hook: Block if no SecReview │   │ • Hook: Auto VIP Discount     │
       │ • Service: b2b.pricing        │   │ • Event: Trigger Warehouse    │
       │ • Tool: b2b_calculate_discount│   │ • Tool: ecom_track_shipment   │
       └───────────────────────────────┘   └───────────────────────────────┘
```

---

### Scenario A: B2B SaaS Company ([`examples/b2b-saas/src/plugin.ts`](file:///Users/nimrodfeldman/playground/embody/examples/b2b-saas/src/plugin.ts))

A B2B SaaS company sells enterprise software subscriptions to mid-market and enterprise businesses.

#### 1. Tier 2 Custom Fields (No Migration)
The B2B company adds enterprise sales fields to `crm.deals` via `custom_fields` JSONB:

```typescript
// B2B Deal Creation
await tx`
  INSERT INTO crm.deals (org_id, party_id, title, stage, amount, custom_fields)
  VALUES (
    ${orgId},
    ${accountPartyId},
    'Acme Corp - 500 Enterprise Seats',
    'negotiation',
    120000.00,
    ${JSON.stringify({
      arr: 120000,
      contract_months: 24,
      security_review_passed: true,
      sla_level: "platinum"
    })}::jsonb
  );
`;
```

#### 2. Runnable Plugin Code ([`examples/b2b-saas/src/plugin.ts`](file:///Users/nimrodfeldman/playground/embody/examples/b2b-saas/src/plugin.ts))
The B2B company exports `b2bSaasPlugin` to enforce security review rules and expose ARR calculation AI tools:

```typescript
import { z } from "zod";
import type { EmbodyPlugin } from "@embody/kernel";

export const b2bSaasPlugin: EmbodyPlugin = {
  id: "b2b-saas",
  schema: "b2b_saas",
  dependsOn: ["core", "crm"],
  capabilities: {
    entities: ["b2b.account", "b2b.contract"],
    hooks: ["crm.deal.beforeUpdate"],
    services: { provide: ["b2b.pricing"], consume: ["core.registry"] },
    events: { publish: ["b2b.contract.signed"] },
  },

  registerHooks(hooks, ctx) {
    // Vetoable Domain Hook: Block closing deals >= $50,000 without Security Review
    hooks.register("crm.deal.beforeUpdate", async (payload) => {
      const dealAmount = Number(payload.amount ?? 0);
      if (payload.stage === "closed_won" && dealAmount >= 50000) {
        const customFields = (payload.custom_fields as Record<string, unknown>) ?? {};
        if (customFields.security_review_passed !== true) {
          throw new Error("Veto: Enterprise deals >= $50k require an approved Security Review before closing!");
        }
      }
    });
  },

  registerMcpTools(mcp, ctx) {
    mcp.tool({
      name: "b2b_calculate_arr_discount",
      description: "Calculate ARR pricing discount for multi-year enterprise contracts.",
      input: z.object({ baseArr: z.number(), contractMonths: z.number() }),
      handler: (input, req) => {
        req.assert("read", "crm:deal");
        const discountedArr = input.contractMonths >= 24 ? input.baseArr * 0.85 : input.baseArr;
        return { baseArr: input.baseArr, discountedArr };
      },
    });
  },
};
```

---

### Scenario B: E-Commerce Retailer ([`examples/ecom-fulfillment/src/plugin.ts`](file:///Users/nimrodfeldman/playground/embody/examples/ecom-fulfillment/src/plugin.ts))

An E-Commerce company sells consumer goods to thousands of online shoppers.

#### 1. Tier 2 Custom Fields (No Migration)
The E-Commerce company adds shopper loyalty fields to `crm.contact_profiles` and `crm.deals`:

```typescript
// E-Commerce Order Creation
await tx`
  INSERT INTO crm.deals (org_id, party_id, title, stage, amount, custom_fields)
  VALUES (
    ${orgId},
    ${shopperPartyId},
    'Order #98432 - Wireless Headphones',
    'completed',
    149.99,
    ${JSON.stringify({
      vip_tier: "Gold",
      total_lifetime_orders: 14,
      shipping_method: "Express Overnight",
      tracking_number: "TRK-981247"
    })}::jsonb
  );
`;
```

#### 2. Runnable Plugin Code ([`examples/ecom-fulfillment/src/plugin.ts`](file:///Users/nimrodfeldman/playground/embody/examples/ecom-fulfillment/src/plugin.ts))
The E-Commerce company exports `ecomFulfillmentPlugin` to auto-apply VIP discounts and trigger warehouse dispatches:

```typescript
import { z } from "zod";
import type { EmbodyPlugin } from "@embody/kernel";

export const ecomFulfillmentPlugin: EmbodyPlugin = {
  id: "ecom-fulfillment",
  schema: "ecom_fulfillment",
  dependsOn: ["core", "crm"],
  capabilities: {
    entities: ["ecom.order", "ecom.shipment"],
    hooks: ["crm.deal.beforeCreate"],
    services: { consume: ["core.registry"] },
    events: { subscribe: ["crm.deal.created"], publish: ["ecom.shipment.dispatched"] },
  },

  registerHooks(hooks, ctx) {
    // Vetoable Domain Hook: Auto-apply 15% discount for Gold/Platinum VIP shoppers
    hooks.register("crm.deal.beforeCreate", async (payload) => {
      const customFields = (payload.custom_fields as Record<string, unknown>) ?? {};
      const vipTier = customFields.vip_tier as string | undefined;
      if (vipTier === "Gold" || vipTier === "Platinum") {
        payload.amount = (Number(payload.amount ?? 0) * 0.85).toFixed(2);
      }
    });
  },

  subscribe(bus, ctx) {
    // Durable Post-Commit Event Subscriber: Automatically dispatch order to warehouse
    bus.subscribe("crm.deal.created", async (event) => {
      ctx.logger.info(`[Warehouse Dispatch] Order dispatched for deal ID: ${event.payload.id}`);
      await ctx.events.publish({
        name: "ecom.shipment.dispatched",
        orgId: event.orgId,
        payload: { orderId: event.payload.id },
      });
    });
  },

  registerMcpTools(mcp, ctx) {
    mcp.tool({
      name: "ecom_track_shipment",
      description: "Lookup package shipping status for customer support AI agents.",
      input: z.object({ orderId: z.string().uuid() }),
      handler: (input, req) => {
        req.assert("read", "crm:deal");
        return { orderId: input.orderId, status: "In Transit", trackingNumber: "TRK-892341" };
      },
    });
  },
};
```

---

## 📊 Summary Comparison Matrix

| Aspect | 🏢 B2B SaaS Company ([`examples/b2b-saas`](file:///Users/nimrodfeldman/playground/embody/examples/b2b-saas/src/plugin.ts)) | 🛒 E-Commerce Retailer ([`examples/ecom-fulfillment`](file:///Users/nimrodfeldman/playground/embody/examples/ecom-fulfillment/src/plugin.ts)) |
| :--- | :--- | :--- |
| **Shared Party (`core.parties`)** | Represents an **Enterprise Account** (e.g. Acme Corp) | Represents an **Individual Shopper** (e.g. Jane Doe) |
| **CRM Deal Entity** | Represents a **Multi-Month Sales Opportunity** | Represents a **Single Shopping Cart Order** |
| **Custom Fields (`custom_fields`)** | `arr`, `contract_months`, `security_review_passed` | `vip_tier`, `lifetime_orders`, `tracking_number` |
| **Domain Hook (`registerHooks`)** | Vetoes deal closing if security review is missing | Auto-applies 15% discount for VIP Gold/Platinum tiers |
| **Domain Event (`subscribe`)** | Assigns Dedicated Customer Success Manager | Sends Instant Warehouse Shipping Webhook |
| **MCP AI Tool (`registerMcpTools`)** | `b2b_calculate_arr_discount` | `ecom_track_shipment` |

---

## 🛑 The Problem with Forking

In traditional open-source enterprise systems, companies fork the main repository to add custom fields or logic. Six months later, upstream releases security patches and new features, but the company cannot upgrade because their custom code is mixed into the core repository ("forked and stranded").

---

## 🛡️ How Embody Solves This: Two-Tier Customization

Embody provides two customization tiers that stay completely separate from upstream packages:

```text
┌─────────────────────────────────────────────────────────────┐
│                    Upstream Embody Packages                 │
│         (@embody/kernel, @embody/core, @embody/crm)          │
└──────────────────────────────┬──────────────────────────────┘
                               │ Stable SemVer SPI Contract
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Your app (your repository)               │
│   (Custom Plugins, JSONB Custom Fields, Custom Workflows)   │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚡ Tier 1: Dynamic Custom Fields (No Database Migrations)

If your company simply needs to attach extra fields to existing entities (e.g. adding a `priority_level` or `internal_code` to CRM Deals), you do **not** need to edit the database schema or run a migration!

Every business table in Embody includes an opt-in **`custom_fields`** `JSONB` column:

### Inserting Custom Fields
```typescript
await tx`
  INSERT INTO crm.deals (org_id, title, stage, custom_fields)
  VALUES (
    ${orgId},
    'Big Enterprise Deal',
    'lead',
    ${JSON.stringify({ priority_level: 'high', region: 'EMEA' })}::jsonb
  )
`;
```

### Filtering by Custom Fields
Embody automatically places GIN indexes on queryable custom fields for fast JSON search:

```sql
SELECT id, title, amount
FROM crm.deals
WHERE org_id = '...'::uuid
  AND custom_fields @> '{"priority_level": "high"}';
```

---

## 🔌 Tier 2: Your Own Plugin

When you need full power (new Postgres tables, vetoable rules, DI services, MCP tools,
CLI commands), write a plugin. It lives in your own project — there is no vendor
directory to put it in, because embody arrives from npm.

One command creates it *and* enables it:

```bash
npx embody new plugin acme-logistics
```

```text
my-crm/
├── embody.config.ts          # edited for you: import + plugins entry
└── plugins/
    └── acme-logistics/
        ├── plugin.ts
        ├── index.ts
        ├── plugin.test.ts
        └── migrations/
            └── 0001_init.sql # your own schema, with RLS
```

The generated plugin imports from `@embody/plugin-sdk` and nothing else. That is the
whole SPI — see [PLUGINS.md](../PLUGINS.md).

### Enabling it

`embody new plugin` already did this, but here is what it wrote to your
`embody.config.ts` — the only file that decides what runs:

```typescript
import { defineConfig } from "@embody/host";
import { crmPlugin } from "@embody/crm";
import { acmeLogisticsPlugin } from "./plugins/acme-logistics/index.ts";

export default defineConfig({
  plugins: [
    crmPlugin,
    acmeLogisticsPlugin, // mounted alongside published plugins; the kernel sees no difference
  ],
});
```

Note where this file lives: your repository. Enabling a plugin never touches anything
inside `node_modules`, which is why an upgrade cannot disturb it. See
[PLUGINS.md](../PLUGINS.md).

### Your rules gate real writes

A hook you register here is not advisory. Entity writes go through
`defineEntity` in `@embody/plugin-sdk`, which runs the `before*` chain **inside the
tenant transaction**, having first merged your patch onto the stored row:

- your rule sees the **whole row**, including fields the caller never sent;
- throwing **rolls the transaction back** — that is the veto;
- it applies to every caller: AI agents, the CLI, and a UI over the `/api` bridge;
- your hook receives the transaction (`ctx.tx`) and may query before deciding.

`examples/custom-crm` is a worked example, with `write-path.integration.test.ts` proving
against a real Postgres that a rejected close leaves the row untouched.

---

## 🔄 Upgrading

There is no merge, because there is no copy of embody in your repository to merge into.
The runtime lives in `node_modules`:

```bash
npm update @embody/crm
npx embody doctor
npm run migrate
```

1. **Nothing happens to your database when you run `npm update`.** The new version's
   migrations apply the next time your app boots, inside an advisory lock, topologically
   sorted so `core` runs before plugins that depend on it and yours run last.
2. **Migrations only roll forward.** Installing an older version leaves the newer schema
   in place — the package downgrades, the database does not. If you would rather a
   dependency bump never changed schema implicitly, make
   `embody-host ./embody.config.ts --mode migrate-only` an explicit deploy step.
3. **`embody doctor`** checks the wiring that a version bump can break: that every
   plugin still shares one `@embody/plugin-sdk` instance, and that no two plugins claim
   the same Postgres schema.

Your own code is never involved in an upgrade. It was never in the same repository as
the thing being upgraded.
