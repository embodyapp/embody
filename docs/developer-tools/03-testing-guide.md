# Testing Agent Applications with `@embody/testing`

> Exercise the production kernel, transactions, principals, outbox, and workflows without live infrastructure.

---

## Setup

Install the harness and test runner:

```bash
pnpm add -D @embody/testing vitest
```

Pass a literal plugin tuple to retain typed client inference, and always close the harness:

```typescript
import { createTestHarness } from "@embody/testing";
import { afterEach, describe, expect, it } from "vitest";
import { tasksPlugin } from "../src/tasks.js";

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

it("boots the production execution path", async () => {
  harness = await createTestHarness({ plugins: [tasksPlugin] as const });
  expect(harness.kernel.manifest.entities).toBeDefined();
});
```

The harness owns an isolated temporary SQLite database and boots the same kernel execution path used by a host.

---

## Typed and dynamic invocation

Use the generated typed client for normal tests:

```typescript
const task = await harness.client.tasks.task.create({
  data: { title: "Implement SSO", status: "todo" },
});

await harness.client.tasks.completeMany({ taskIds: [task.id] });
```

Use `call()` when a target is dynamic:

```typescript
await harness.call("tasks.task.update", {
  id: task.id,
  data: { status: "in_progress" },
});
```

Harness targets omit the app ID because the harness boots plugins directly. Generated entity action inputs use `{ data }`, while entity accessors inside handlers accept data directly.

---

## Simulating principals

Use immutable request views:

```typescript
const agent = harness.asAgent("coding-agent");
const human = harness.asHuman("alice", {
  roles: ["admin"],
  scopes: ["tasks:*"],
});

const system = harness.as({
  orgId: "test",
  actorId: "outbox-worker",
  actorType: "system",
  roles: [],
  scopes: ["tasks:*"],
});
```

`asAgent` and `asHuman` inherit omitted tenant, role, scope, and metadata values from the current view. Scope checks occur before handlers and hooks. Do not use an empty scope list when testing a hook unless authorization denial is the intended result.

---

## Testing a mechanical guardrail

```typescript
it("requires a PR before an agent completes a task", async () => {
  const harness = await createTestHarness({ plugins: [tasksPlugin] as const });

  try {
    const task = await harness.client.tasks.task.create({
      data: { title: "Refactor authentication", status: "todo" },
    });
    const agent = harness.asAgent("coding-agent");

    const veto = await agent.veto(() =>
      agent.client.tasks.task.update({
        id: task.id,
        data: { status: "done" },
      }),
    );
    expect(veto.message).toContain("PR");

    const unchanged = await harness.client.tasks.task.get({ id: task.id });
    expect(unchanged.data.status).toBe("todo");

    const completed = await agent.client.tasks.task.update({
      id: task.id,
      data: {
        status: "done",
        prUrl: "https://github.com/example/repository/pull/123",
      },
    });
    expect(completed.data.status).toBe("done");
  } finally {
    await harness.close();
  }
});
```

Use `veto()` when a `HookVetoError` is expected. It rejects non-veto failures, preventing a permission or validation error from creating a false-positive guardrail test.

---

## Service overrides

Only declared services can be overridden:

```typescript
const harness = await createTestHarness({
  plugins: [notificationsPlugin] as const,
  services: {
    "notifications.mailer": fakeMailer,
  },
});
```

Use deterministic fakes rather than live network services.

---

## Events and outbox processing

Inspect persisted events and run eligible handlers explicitly:

```typescript
const events = await harness.events("tasks.task.completed");
expect(events).toHaveLength(1);

await harness.tickOutbox();
expect(fakeNotifier.calls).toHaveLength(1);
```

Event delivery is at least once. Verify that subscribers pass stable idempotency keys to external providers.

---

## Durable workflows

Start through the generated action, tick eligible steps, and inspect the durable snapshot:

```typescript
const started = (await harness.call("orders.fulfil.start", {
  input: { orderId: "order-123" },
  idempotencyKey: "fulfil:order-123",
})) as { id: string };

await harness.tickWorkflows(); // first eligible step
await harness.tickWorkflows(); // newly unblocked dependent step
const snapshot = await harness.workflow(started.id);
expect(snapshot?.status).toBe("completed");
```

Each tick runs currently eligible steps, so dependent steps generally require later ticks. Inject `now` into `createTestHarness` and advance a fake clock for retry backoff and delayed-step tests. Do not sleep in tests.

---

## Progress, cancellation, and audit

Calls accept an optional abort signal:

```typescript
const controller = new AbortController();
const operation = harness.call("tasks.longOperation", input, {
  signal: controller.signal,
});
controller.abort();
await expect(operation).rejects.toThrow();
```

Read observations with:

```typescript
const updates = harness.progress(); // optionally filter by requestId
const audit = harness.audit();
```

Assert progress ordering and terminal audit outcomes where they are part of the contract.

---

## Test checklist

For each feature, cover the applicable cases:

- allowed and denied actors
- expected error type or message
- unchanged state after rejection
- tenant separation
- all-or-nothing batch rollback
- event persistence and idempotent delivery
- progress and cancellation
- workflow retry, delay, cancellation, and compensation
- audit outcome
- harness cleanup

Next: **[CLI Reference →](./01-cli-reference.md)**
