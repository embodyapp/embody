# Customization & Upgrades Guide

A major design goal of **Embody** is allowing companies to heavily customize business logic, schemas, and workflows **without forking the core codebase** (Decision D8).

---

## 🏢 Real-World Scenario: B2B SaaS vs. E-Commerce Customization

To see how Embody adapts to completely different business models, examine the two fully-functional reference app plugins included in the codebase under `catalog/`:

1. [**`catalog/b2b-saas`**](file:///Users/nimrodfeldman/playground/embody/catalog/b2b-saas/src/plugin.ts): Enterprise B2B SaaS CRM customization.
2. [**`catalog/ecom-fulfillment`**](file:///Users/nimrodfeldman/playground/embody/catalog/ecom-fulfillment/src/plugin.ts): E-Commerce Retailer CRM customization.

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

### Scenario A: B2B SaaS Company ([`catalog/b2b-saas/src/plugin.ts`](file:///Users/nimrodfeldman/playground/embody/catalog/b2b-saas/src/plugin.ts))

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

#### 2. Runnable Plugin Code ([`catalog/b2b-saas/src/plugin.ts`](file:///Users/nimrodfeldman/playground/embody/catalog/b2b-saas/src/plugin.ts))
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

### Scenario B: E-Commerce Retailer ([`catalog/ecom-fulfillment/src/plugin.ts`](file:///Users/nimrodfeldman/playground/embody/catalog/ecom-fulfillment/src/plugin.ts))

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

#### 2. Runnable Plugin Code ([`catalog/ecom-fulfillment/src/plugin.ts`](file:///Users/nimrodfeldman/playground/embody/catalog/ecom-fulfillment/src/plugin.ts))
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

| Aspect | 🏢 B2B SaaS Company ([`catalog/b2b-saas`](file:///Users/nimrodfeldman/playground/embody/catalog/b2b-saas/src/plugin.ts)) | 🛒 E-Commerce Retailer ([`catalog/ecom-fulfillment`](file:///Users/nimrodfeldman/playground/embody/catalog/ecom-fulfillment/src/plugin.ts)) |
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
│                    Customer Workspace (custom/)             │
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

## 🔌 Tier 2: Custom Plugins in the `custom/` Workspace

When you need full power (new Postgres tables, vetoable rules, DI services, MCP tools,
CLI commands), write a plugin under **`custom/`** — a directory upstream never writes to.

One command creates it *and* wires it into your deployment:

```bash
embody new custom acme-logistics --for deploy/acme
```

```text
custom/
└── acme-logistics/
    ├── package.json          # private, UNSCOPED — @embody/* is the vendor's scope
    ├── src/
    │   ├── plugin.ts
    │   └── plugin.test.ts
    └── migrations/
        └── 0001_init.sql     # your own schema, with RLS
```

### Enabling it

`--for` already did this, but here is what it wrote to
`deploy/acme/embody.config.ts` — **your** file, in **your** directory:

```typescript
import { defineConfig } from "@embody/host";
import { crmPlugin } from "@embody/crm";
import { acmeLogisticsPlugin } from "acme-logistics";

export default defineConfig({
  plugins: [
    crmPlugin,
    acmeLogisticsPlugin, // mounted alongside first-party apps
  ],
});
```

Note where this file lives. If enabling your plugin required editing a file that ships
from upstream, every upgrade would conflict on it — and the promise below would be
false. Deployments belong in `deploy/`, which is yours. See [OWNERSHIP.md](../OWNERSHIP.md).

### Your rules gate real writes

A hook you register here is not advisory. Entity writes go through
`defineEntity` in `@embody/plugin-sdk`, which runs the `before*` chain **inside the
tenant transaction**, having first merged your patch onto the stored row:

- your rule sees the **whole row**, including fields the caller never sent;
- throwing **rolls the transaction back** — that is the veto;
- it applies to every caller: AI agents, the CLI, and a UI over the `/api` bridge;
- your hook receives the transaction (`ctx.tx`) and may query before deciding.

`custom/acme-crm` is a worked example, with `write-path.integration.test.ts` proving
against a real Postgres that a rejected close leaves the row untouched.

---

## 🔄 Upgrade Strategy (Pulling Upstream Updates)

Upgrades are safe for a structural reason, not a stylistic one: **`git merge` can only
conflict on files you have edited**, and your code lives in directories upstream never
writes to (`custom/`, `deploy/`).

```bash
git remote add upstream <embody repo url>   # once
git fetch upstream
embody doctor                                # ← before you merge
git merge upstream/main
pnpm --filter <yours>-deployment migrate
```

1. **`embody doctor`** lists every file you have changed under `framework/`,
   `catalog/` or `examples/` — committed or not — and exits non-zero. Those are exactly
   the files a merge can conflict on. Clean doctor, clean merge. If it can't find an
   upstream ref it says so and checks nothing, rather than reporting a false pass.
2. **Migrations** are topologically sorted on boot (`core` first, then apps, then your
   plugins), so your schema changes apply after the ones they depend on.
3. **Zero conflicts** — provided doctor is clean. If it isn't, it tells you which file
   to move into `custom/` or contribute upstream.
