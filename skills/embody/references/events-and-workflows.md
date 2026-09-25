# Events and durable workflows

Read this when state changes trigger downstream work or a process must survive retries and restarts.

## Transactional events

Publish from an action or lifecycle hook:

```ts
await context.events.publish("orders.order.approved", {
  orderId: updated.id,
  approvedBy: context.principal.actorId,
});
```

The event is stored in the transactional outbox with entity mutations. Delivery is at least once, so external effects must be idempotent.

Subscribe in a plugin's static definition:

```ts
export const notifications = definePlugin({
  id: "notifications",
  version: "1.0.0",
  events: {
    "orders.order.approved": async (event, context) => {
      const mailer = context.services.get<Mailer>("notifications.mailer");
      await mailer.sendApproval(
        event.payload.orderId,
        `${event.id}:approval-email`,
      );
    },
  },
});
```

Event handlers run as a system principal. Embody tracks handler delivery, but an external provider can still observe a retry around a process or network failure. Give the provider a stable idempotency key based on the event ID and effect name.

Test persisted events before delivery, then tick the worker explicitly:

```ts
expect(await harness.events("orders.order.approved")).toHaveLength(1);
await harness.tickOutbox();
expect(fakeMailer.calls).toHaveLength(1);
```

## Durable workflows

Use a workflow for a versioned, retryable DAG rather than process timers or an in-memory job chain:

```ts
import { definePlugin, defineWorkflow, z } from "@embody/core";

const fulfil = defineWorkflow(z.object({ orderId: z.string() }))({
  description: "Reserve inventory and ship an order",
  version: "1.0.0",
  output: z.object({ shipped: z.boolean() }),
  steps: {
    reserve: {
      output: z.object({ reservationId: z.string() }),
      retry: { maxAttempts: 3, backoffMs: 1_000 },
      handler: async ({ input, workflowId, services }) => {
        const inventory = services.get<Inventory>("orders.inventory");
        return inventory.reserve(input.orderId, `${workflowId}:reserve`);
      },
      compensate: async (reservation, { workflowId, services }) => {
        const inventory = services.get<Inventory>("orders.inventory");
        await inventory.release(
          reservation.reservationId,
          `${workflowId}:reserve:compensate`,
        );
      },
    },
    ship: {
      dependsOn: ["reserve"],
      output: z.object({ shipped: z.boolean() }),
      handler: async ({ workflowId, services }) => {
        const shipping = services.get<Shipping>("orders.shipping");
        return shipping.send(workflowId);
      },
    },
  },
  resultStep: "ship",
});

export const orders = definePlugin({
  id: "orders",
  version: "1.0.0",
  services: () => ({ inventory, shipping }),
  workflows: { fulfil },
});
```

Generated targets are:

```text
orders.fulfil.start
orders.fulfil.status
orders.fulfil.cancel
orders.fulfil.retry
```

Start with stable idempotency:

```ts
const started = await harness.call("orders.fulfil.start", {
  input: { orderId },
  idempotencyKey: `fulfil:${orderId}`,
});
```

Reusing a key with equivalent input returns the original instance; using it with different input conflicts.

## Workflow rules

- Steps run at least once. Every external effect needs a domain idempotency key.
- Use `dependsOn` for ordering and `delayMs` for persisted delays; never use process timers.
- `maxAttempts` includes the first attempt.
- Throw `NonRetryableWorkflowError` for a terminal failure.
- Compensation is a recorded forward action, not proof an external effect was reversed.
- Cancellation blocks downstream claims and compensates completed compensatable steps in reverse graph order.
- Inputs and outputs must be JSON and are capped at 256 KiB.
- Use `redact(value, "input" | "output")` before sensitive values are persisted.
- Keep every workflow version referenced by a nonterminal stored instance deployed.
- The initiating principal is retained and its current scopes are reevaluated before each step.

Test without sleeps:

```ts
await harness.tickWorkflows(); // reserve
await harness.tickWorkflows(); // ship
const snapshot = await harness.workflow(workflowId);
expect(snapshot?.status).toBe("completed");
```

Each tick runs currently eligible steps; dependent steps generally require a later tick. Inject `now` into the harness and advance a fake clock for retries and delays.
