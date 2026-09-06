# Durable workflows

Workflows are versioned DAGs. Each step receives immutable input, outputs of completed dependencies, the attempt number, normal principal/context services, and a cancellation signal. Steps run at least once: external effects must use a domain idempotency key such as `${workflowId}:${stepName}`.

```ts
const fulfil = defineWorkflow(z.object({ orderId: z.string() }))({
  version: "1.0.0",
  output: z.object({ shipped: z.boolean() }),
  steps: {
    reserve: {
      output: z.object({ reservationId: z.string() }),
      retry: { maxAttempts: 3, backoffMs: 1000 },
      handler: async ({ input, workflowId }) =>
        inventory.reserve(input.orderId, `${workflowId}:reserve`),
      compensate: async (reservation, { workflowId }) =>
        inventory.release(reservation.reservationId, `${workflowId}:reserve:compensate`),
    },
    ship: {
      dependsOn: ["reserve"],
      output: z.object({ shipped: z.boolean() }),
      handler: async ({ workflowId }) => shipping.send(workflowId),
    },
  },
});

export const plugin = definePlugin({
  id: "orders", version: "1.0.0", workflows: { fulfil },
});
```

Start/status/cancel/retry are generated actions: `orders.fulfil.start`, `.status`, `.cancel`, and `.retry`. They use the same scopes, gateway, CLI, MCP, progress, and audit route as other actions. A start takes `{ input, idempotencyKey }`; reuse with equivalent input returns the original instance and reuse with different input conflicts.

Instances retain the initiating principal and re-evaluate its current scopes before every step. Revocation stops the workflow. Inputs/outputs are capped at 256 KiB and must be JSON. Use `redact(value, kind)` to remove protected fields before storage. Cancellation prevents downstream claims and compensates completed compensatable steps in reverse graph order. Compensation is a recorded forward action—not a promise that external effects were rolled back.

Deploy every workflow version referenced by a nonterminal database instance. Delays use `delayMs` and persisted `scheduled_at`; never use process timers in handlers. Tests can call `harness.tickWorkflows()` and inject `now` to advance a fake clock without sleeps.
