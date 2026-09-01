# 08. Reference Applications: Kanban & Email Automation

This document outlines the complete end-to-end reference implementation for the two example applications: **Kanban Board** and **Email Automation**.

---

## 1. App 1: Kanban Board Service

### 1.1 Plugin Definition (`src/plugin.ts`)
```typescript
import { definePlugin, z } from "@embody/core";

export const KanbanCardSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: z.enum(["todo", "in_progress", "in_review", "done"]).default("todo"),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  assigneeId: z.string().optional(),
  prUrl: z.string().url().optional(),
});

export const kanbanPlugin = definePlugin({
  id: "kanban",
  version: "1.0.0",

  // 1. Declarative Dynamic Entity (Auto-CRUD generated)
  entities: {
    card: {
      description: "Tasks and work items managed on the kanban board",
      schema: KanbanCardSchema,
      indexes: ["status", "priority", "assigneeId"],
    },
  },

  // 2. Custom Domain Actions
  actions: {
    bulkMove: {
      description: "Move multiple cards to a new status simultaneously",
      input: z.object({
        cardIds: z.array(z.string().uuid()),
        newStatus: z.enum(["todo", "in_progress", "in_review", "done"]),
      }),
      handler: async (input, ctx) => {
        const updated = [];
        for (const id of input.cardIds) {
          const res = await ctx.entities.card.update(id, { status: input.newStatus });
          updated.push(res);
        }
        return { count: updated.length, cards: updated };
      },
    },
  },

  // 3. Vetoable Guardrail Hooks
  hooks: {
    "kanban.card.beforeUpdate": async ({ current, patch }, ctx) => {
      // Rule: Agents cannot mark cards as 'done' without a valid PR URL
      if (ctx.principal.actorType === "agent" && patch.status === "done" && !current.data.prUrl) {
        throw new Error("Guardrail Veto: Agents cannot complete cards without a linked PR URL.");
      }
    },
    "kanban.card.afterUpdate": async ({ current, updated }, ctx) => {
      // Emit domain event when a card enters 'in_review'
      if (current.data.status !== "in_review" && updated.data.status === "in_review") {
        await ctx.events.publish("kanban.card.ready_for_review", {
          cardId: updated.id,
          title: updated.data.title,
          assigneeId: updated.data.assigneeId,
        });
      }
    },
  },
});
```

### 1.2 App Host (`src/index.ts`)
```typescript
import { createAppHost } from "@embody/host";
import { kanbanPlugin } from "./plugin";

const app = createAppHost({
  appId: "kanban",
  port: 8081,
  plugins: [kanbanPlugin],
  gateway: {
    url: process.env.GATEWAY_URL || "http://localhost:4000",
    secret: process.env.GATEWAY_REGISTRATION_SECRET || "dev-secret",
  },
});

app.listen();
```

---

## 2. App 2: Email Automation Service

### 2.1 Plugin Definition (`src/plugin.ts`)
```typescript
import { definePlugin, z } from "@embody/core";

export const emailPlugin = definePlugin({
  id: "email",
  version: "1.0.0",

  // 1. Outbox Event Subscribers (Reacts to cross-app events from Kanban)
  events: {
    "kanban.card.ready_for_review": async (event, ctx) => {
      // Trigger notification email when Kanban card is ready
      await ctx.services.get<{ send: (to: string, sub: string, body: string) => Promise<void> }>("mailer")
        .send(
          "team-lead@company.com",
          `Review Required: ${event.payload.title}`,
          `Card ${event.payload.cardId} has been moved to in_review and requires approval.`
        );
    },
  },

  // 2. Custom Domain Actions
  actions: {
    sendBatch: {
      description: "Send automated marketing or notification batch with live progress",
      input: z.object({
        campaignId: z.string(),
        recipients: z.array(z.string().email()),
        subject: z.string(),
        template: z.string(),
      }),
      handler: async (input, ctx) => {
        let sentCount = 0;
        const total = input.recipients.length;

        for (const recipient of input.recipients) {
          // Simulate email dispatch
          sentCount++;
          if (sentCount % 10 === 0 || sentCount === total) {
            ctx.progress({
              percent: Math.round((sentCount / total) * 100),
              message: `Sent ${sentCount} of ${total} emails...`,
            });
          }
        }

        return { campaignId: input.campaignId, totalSent: sentCount };
      },
    },
  },
});
```

### 2.2 App Host (`src/index.ts`)
```typescript
import { createAppHost } from "@embody/host";
import { emailPlugin } from "./plugin";

const app = createAppHost({
  appId: "email",
  port: 8082,
  plugins: [emailPlugin],
  gateway: {
    url: process.env.GATEWAY_URL || "http://localhost:4000",
    secret: process.env.GATEWAY_REGISTRATION_SECRET || "dev-secret",
  },
});

app.listen();
```
