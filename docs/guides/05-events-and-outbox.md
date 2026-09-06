# Transactional Outbox & Event Streaming

> Learn how Embody eliminates dual-write failures, guarantees reliable event delivery, and streams live progress with Server-Sent Events (SSE).

---

## 💥 The Dual-Write Problem

In many applications, an action updates a database record and then attempts to send an event or HTTP webhook:

```typescript
// ❌ Dangerous Dual-Write Pattern
await db.tasks.update(taskId, { status: "done" });
await messageQueue.publish("task.completed", { taskId }); // What if this network call fails?
```

If the database write succeeds but the queue call fails (due to a network timeout, process crash, or rate limit), your system enters an inconsistent state. Conversely, if the queue call succeeds but the database transaction fails to commit, downstream workers process ghost events.

**Embody solves this with the Transactional Outbox Pattern.**

---

## 📦 The Embody Outbox Pattern

In Embody, when you publish an event via `context.events.publish(...)`, the event is written to an internal outbox table **inside the same database transaction** as your entity mutations:

```
[Action Handler Execution]
             │
             ▼
     BEGIN TRANSACTION
             ├── 1. Insert/Update Business Entity
             └── 2. Insert Event into `embody_outbox` (Status: "pending")
     COMMIT TRANSACTION
```

Either both the business data and the event are written to disk, or neither is. Dual-write failures are mathematically eliminated.

---

## 📢 Publishing Events

Inside any action or post-mutation hook, use `context.events.publish`:

```typescript
actions: {
  submitForReview: define.action({
    input: z.object({ cardId: z.string().uuid() }),
    handler: async ({ cardId }, context) => {
      // Update entity
      const card = await context.entities.card.update(cardId, {
        status: "in_review",
      });

      // Atomically publish domain event
      await context.events.publish("kanban.card.ready_for_review", {
        cardId: card.id,
        title: card.data.title,
        submittedBy: context.principal.actorId,
      });

      return { success: true };
    },
  }),
}
```

---

## 👂 Subscribing to Events Across Plugins

Plugins can register event subscribers in their static definition:

```typescript
export const notificationsPlugin = definePlugin({
  id: "notifications",
  version: "1.0.0",
  entities: {},
  events: {
    // Listen to events published by the kanban plugin
    "kanban.card.ready_for_review": async (event, context) => {
      const { cardId, title, submittedBy } = event.payload;

      console.log(`Notification: Card "${title}" (${cardId}) needs review!`);

      // Record a notification entity
      await context.entities.notification.create({
        recipient: "team-lead",
        message: `Card ${title} submitted by ${submittedBy} is ready for review.`,
      });
    },
  },
});
```

---

## 🔄 The Outbox Worker

The background `OutboxWorker` polls pending events, delivers them to registered listeners, handles retries with exponential backoff, and marks completed events as `completed`:

- **Guaranteed At-Least-Once Delivery**: Events remain in `pending` until handlers confirm completion.
- **Dead-Letter Support**: If an event handler repeatedly throws an unhandled error, the event transitions to `dead_letter` after maximum retries.
- **Idempotency Keys**: Events carry deterministic UUIDs, allowing subscribers to discard duplicate deliveries safely.

---

## 📡 Live Progress Streaming via SSE

When an AI agent triggers a long-running action (e.g. running test suites, web scraping, batch data processing), standard HTTP requests leave the caller in the dark until the entire job finishes.

Embody provides native **Server-Sent Events (SSE)** progress streaming via `context.progress(...)`:

```typescript
handler: async (input, context) => {
  context.progress({ percent: 10, message: "Initializing environment..." });
  // ...
  context.progress({ percent: 50, message: "Executing step 1 of 2..." });
  // ...
  context.progress({ percent: 100, message: "Finished processing" });

  return { success: true };
}
```

### How Clients Consume Progress
- **CLI**: The Embody CLI automatically renders a live progress bar in the terminal.
- **MCP**: The Model Context Protocol transport streams progress notifications back to the AI model.
- **HTTP / Webhook**: Clients can connect to the execution endpoint with `Accept: text/event-stream` to receive streaming JSON frames:

```text
event: progress
data: {"percent": 50, "message": "Executing step 1 of 2..."}

event: result
data: {"success": true}
```

Next: **[Authentication & Principals →](./06-authentication-and-principals.md)**
