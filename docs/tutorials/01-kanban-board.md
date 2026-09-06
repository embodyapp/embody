# Tutorial: Building an AI Agent Kanban Board

> Build a multi-agent Kanban board application from scratch with custom actions, mechanical safety guardrails, and automated tests.

---

## 🎯 What We Are Building

In this tutorial, you will build a complete task management backend for an autonomous AI engineering team.

Your application will feature:
1. **Kanban Card Entity**: Cards with `title`, `description`, `status` (`todo`, `in_progress`, `in_review`, `done`), `priority`, and `prUrl`.
2. **Bulk Move Action**: An atomic business action allowing agents or leads to move batches of cards simultaneously.
3. **Mechanical PR Safety Guardrail**: A veto hook preventing any autonomous agent from moving a card to `done` unless a valid Pull Request URL is attached.
4. **Domain Event Publication**: Automatic emission of `kanban.card.ready_for_review` events whenever a card transitions to `in_review`.
5. **Automated Vitest Test Suite**: Verifying the safety veto and workflow logic.

---

## 📁 Step 1: Project Setup

Initialize a new Embody project:

```bash
pnpm create embody-app kanban-app
cd kanban-app
pnpm install
```

---

## 📝 Step 2: Define Schemas and Plugin

Create `src/kanban.ts` and define the schemas, custom actions, and safety hooks:

```typescript
// src/kanban.ts
import { definePlugin, HookVetoError, z } from "@embody/core";

// 1. Define Enum & Entity Schemas
export const CardStatusSchema = z.enum(["todo", "in_progress", "in_review", "done"]);
export const CardPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

export const KanbanCardSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  status: CardStatusSchema.default("todo"),
  priority: CardPrioritySchema.default("medium"),
  assigneeId: z.string().optional(),
  prUrl: z.string().url("prUrl must be a valid URL").optional(),
});

export type KanbanCard = z.output<typeof KanbanCardSchema>;

// 2. Define the Kanban Plugin
export const kanbanPlugin = definePlugin(
  {
    id: "kanban",
    version: "1.0.0",
    entities: {
      card: {
        description: "Tasks and work items managed on the engineering board",
        schema: KanbanCardSchema,
        indexes: ["status", "priority", "assigneeId"],
      },
    },
  },
  (define) => ({
    // 3. Declare Typed Business Actions
    actions: {
      bulkMove: define.action({
        description: "Atomically move multiple cards to a new status",
        input: z.object({
          cardIds: z.array(z.string().uuid()).min(1),
          newStatus: CardStatusSchema,
        }),
        output: z.object({
          count: z.number(),
        }),
        handler: async ({ cardIds, newStatus }, context) => {
          const updated = await context.entities.card.updateMany(
            cardIds.map((id) => ({ id, data: { status: newStatus } }))
          );
          return { count: updated.length };
        },
      }),
    },

    // 4. Declare Mechanical Safety Hooks
    hooks: [
      // Veto rule: Autonomous agents cannot mark done without a PR
      define.beforeUpdate("card", ({ current, patch }, context) => {
        if (
          context.principal.actorType === "agent" &&
          patch.status === "done" &&
          !current.data.prUrl &&
          !patch.prUrl
        ) {
          throw new HookVetoError(
            "Autonomous agents cannot complete cards without a linked PR URL."
          );
        }
      }),

      // Domain event: Publish review event when transitioning to in_review
      define.afterUpdate("card", async ({ current, updated }, context) => {
        if (current.data.status !== "in_review" && updated.data.status === "in_review") {
          await context.events.publish("kanban.card.ready_for_review", {
            cardId: updated.id,
            title: updated.data.title,
            assigneeId: updated.data.assigneeId,
          });
        }
      }),
    ],
  })
);
```

---

## ⚙️ Step 3: Register the Plugin in `embody.config.ts`

Update your root `embody.config.ts`:

```typescript
// embody.config.ts
import { defineApp } from "@embody/host";
import { kanbanPlugin } from "./src/kanban.js";

export default defineApp({
  appId: "eng",
  version: "1.0.0",
  plugins: [kanbanPlugin],
});
```

---

## 🧪 Step 4: Write End-to-End Tests

Create `test/kanban.test.ts` to test your application with `@embody/testing`:

```typescript
// test/kanban.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { createTestHarness } from "@embody/testing";
import { kanbanPlugin } from "../src/kanban.js";

describe("Kanban App Safety & Actions", () => {
  let harness: Awaited<ReturnType<typeof createTestHarness>>;

  afterEach(async () => {
    await harness?.close();
  });

  it("enforces PR URL on agents but allows humans to close directly", async () => {
    harness = await createTestHarness({
      plugins: [kanbanPlugin],
      actor: { actorType: "human", actorId: "tech-lead", roles: ["admin"], scopes: ["*"] },
    });

    // 1. Human creates a task
    const card = await harness.client.kanban.card.create({
      data: { title: "Refactor database pool", status: "todo" },
    });

    // 2. Switch context to an AI agent
    const agentHarness = harness.asActor({
      actorType: "agent",
      actorId: "coding-agent-42",
      roles: ["agent"],
      scopes: ["kanban:write"],
    });

    // 3. Agent attempts to mark done without PR -> Must be vetoed
    await expect(
      agentHarness.client.kanban.card.update({
        id: card.id,
        data: { status: "done" },
      })
    ).rejects.toThrow("Autonomous agents cannot complete cards without a linked PR URL");

    // 4. Agent provides a PR URL -> Update succeeds
    const doneCard = await agentHarness.client.kanban.card.update({
      id: card.id,
      data: {
        status: "done",
        prUrl: "https://github.com/my-org/repo/pull/77",
      },
    });

    expect(doneCard.data.status).toBe("done");
  });

  it("executes bulkMove action across cards", async () => {
    harness = await createTestHarness({ plugins: [kanbanPlugin] });

    const card1 = await harness.client.kanban.card.create({ data: { title: "Task 1" } });
    const card2 = await harness.client.kanban.card.create({ data: { title: "Task 2" } });

    const result = await harness.client.kanban.bulkMove({
      cardIds: [card1.id, card2.id],
      newStatus: "in_progress",
    });

    expect(result.count).toBe(2);

    const updated1 = await harness.client.kanban.card.get({ id: card1.id });
    expect(updated1.data.status).toBe("in_progress");
  });
});
```

Run the tests:

```bash
pnpm test
```

All tests pass! 🎉

---

## 🚀 Step 5: Run the Server and Test with CLI

Start your development server:

```bash
pnpm dev
```

In another terminal, test creating and listing cards:

```bash
# Create a card
embody eng card create --title "Set up Redis cache" --priority high

# List cards
embody eng card list --status todo

# Move card using bulk action
embody eng bulkMove --cardIds "<CARD_ID>" --newStatus in_progress
```

Congratulations! You have built a fully functional, agent-native backend with strict mechanical safety guardrails!

Next: **[Tutorial: Email Campaign Automation →](./02-email-automation.md)**
