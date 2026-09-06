# Testing Agent Applications with `@embody/testing`

> Learn how to write deterministic unit and end-to-end tests for AI agent applications using the `@embody/testing` test harness.

---

## 🧪 Why Testing Agent Software is Different

Testing software built for autonomous AI agents requires more than standard HTTP assertion tests:
1. **Actor Persona Simulation**: You must verify that an action succeeds for a `human` supervisor but is vetoed for an `agent`.
2. **Deterministic Veto Verification**: You must test that safety hooks throw `HookVetoError` when invariants are violated.
3. **Outbox & Event Assertions**: You must verify that domain events are written to the outbox atomically.
4. **SSE Progress Verification**: You must test that long-running actions emit correct progress percentages.

The `@embody/testing` package provides an in-memory, isolated test harness designed specifically for these workflows.

---

## 🚀 Setting Up the Test Harness

Install `@embody/testing` and `vitest` in your project:

```bash
pnpm add -D @embody/testing vitest
```

### Basic Harness Initialization

The `createTestHarness` factory starts an isolated, in-memory SQLite storage engine and boots your plugins through the complete 7-phase microkernel lifecycle:

```typescript
import { describe, expect, it, afterEach } from "vitest";
import { createTestHarness } from "@embody/testing";
import { tasksPlugin } from "./src/plugins/tasks.js";

describe("Tasks Safety Tests", () => {
  let harness: Awaited<ReturnType<typeof createTestHarness>>;

  afterEach(async () => {
    // Closes DB connections and cleans up temporary test directories
    await harness?.close();
  });

  it("boots cleanly with in-memory storage", async () => {
    harness = await createTestHarness({
      plugins: [tasksPlugin],
    });

    expect(harness.appManifest.entities).toHaveProperty("task");
  });
});
```

---

## 🎭 Simulating Actors (`asActor`)

The test harness allows you to switch execution contexts between different actors effortlessly:

```typescript
it("prevents agents from completing tasks without a PR URL", async () => {
  const harness = await createTestHarness({
    plugins: [tasksPlugin],
    actor: { actorType: "human", actorId: "alice", roles: ["admin"], scopes: ["*"] },
  });

  try {
    // 1. Human creates a task
    const task = await harness.call("ops.tasks.task.create", {
      data: { title: "Refactor auth middleware", status: "todo" },
    });

    expect(task.data.status).toBe("todo");

    // 2. Switch context to an autonomous agent
    const agentHarness = harness.asActor({
      actorType: "agent",
      actorId: "devin-01",
      roles: ["contributor"],
      scopes: ["tasks:write"],
    });

    // 3. Agent attempts to mark done without PR -> Must be VETOED
    await expect(
      agentHarness.call("ops.tasks.task.update", {
        id: task.id,
        data: { status: "done" },
      })
    ).rejects.toThrow("Agents cannot mark a task 'done' without a linked PR URL");

    // 4. Agent provides a valid PR URL -> Must SUCCEED
    const completed = await agentHarness.call("ops.tasks.task.update", {
      id: task.id,
      data: {
        status: "done",
        prUrl: "https://github.com/my-org/repo/pull/123",
      },
    });

    expect(completed.data.status).toBe("done");
  } finally {
    await harness.close();
  }
});
```

---

## 🎯 Typed Proxy Client (`harness.client`)

Instead of string-based `harness.call(...)`, you can use the typed proxy client for full TypeScript autocomplete:

```typescript
// Auto-completed and type-checked against your plugin's Zod schema
const card = await harness.client.kanban.card.create({
  data: {
    title: "Implement SSO login",
    priority: "urgent",
  },
});

// Calling a custom action
const result = await harness.client.kanban.bulkMove({
  cardIds: [card.id],
  newStatus: "in_progress",
});
```

---

## 📦 Asserting Transactional Outbox Events

Verify that domain events are written to the outbox and processed reliably:

```typescript
it("publishes review event when card moves to in_review", async () => {
  const harness = await createTestHarness({ plugins: [kanbanPlugin] });

  try {
    const card = await harness.client.kanban.card.create({
      data: { title: "New Feature", status: "in_progress" },
    });

    // Update status to in_review
    await harness.client.kanban.card.update({
      id: card.id,
      data: { status: "in_review" },
    });

    // Inspect pending outbox events
    const outboxEvents = await harness.getOutboxEvents();
    expect(outboxEvents).toHaveLength(1);
    expect(outboxEvents[0]?.eventName).toBe("kanban.card.ready_for_review");
    expect(outboxEvents[0]?.payload).toMatchObject({
      cardId: card.id,
      title: "New Feature",
    });

    // Manually trigger the outbox worker to process events
    const processedCount = await harness.processOutbox();
    expect(processedCount).toBe(1);
  } finally {
    await harness.close();
  }
});
```

---

## 📊 Testing SSE Live Progress

The test harness automatically captures all progress events emitted via `context.progress(...)`:

```typescript
it("emits streaming progress during batch email sending", async () => {
  const harness = await createTestHarness({ plugins: [emailPlugin] });

  try {
    await harness.call("email.sendBatch", {
      campaignId: "newsletter-01",
      recipients: ["user1@test.com", "user2@test.com"],
      subject: "Welcome",
      template: "Hello World",
    });

    // Inspect captured progress updates
    expect(harness.capturedProgress.length).toBeGreaterThanOrEqual(1);
    const lastProgress = harness.capturedProgress.at(-1);
    expect(lastProgress?.update.percent).toBe(100);
  } finally {
    await harness.close();
  }
});
```

---

## 🛡️ Inspecting Audit Trails

The microkernel records every action invocation in an immutable audit log accessible via `harness.auditEvents`:

```typescript
expect(harness.auditEvents[0]).toMatchObject({
  target: "ops.tasks.task.create",
  principal: {
    actorId: "alice",
    actorType: "human",
  },
  status: "success",
});
```

Next: **[Tutorial: Building an Agent Kanban Board →](../tutorials/01-kanban-board.md)**
