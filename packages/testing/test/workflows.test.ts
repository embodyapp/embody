import { describe, expect, it } from "vitest";
import { definePlugin, defineWorkflow, z } from "@embody/core";
import { createTestHarness } from "../src/index.js";

const fulfil = defineWorkflow(z.object({ orderId: z.string() }))({
  version: "1.0.0",
  output: z.object({ shipped: z.boolean() }),
  steps: {
    reserve: {
      output: z.object({ reservation: z.string() }),
      handler: ({ input }) => ({ reservation: `r-${input.orderId}` }),
    },
    ship: {
      dependsOn: ["reserve"],
      output: z.object({ shipped: z.boolean() }),
      handler: ({ outputs }) => ({ shipped: Boolean(outputs["reserve"]) }),
    },
  },
});
const workflowPlugin = definePlugin({
  id: "orders",
  version: "1.0.0",
  workflows: { fulfil },
});

describe("durable workflow harness", () => {
  it("starts idempotently and deterministically ticks a linear workflow", async () => {
    const harness = await createTestHarness({ plugins: [workflowPlugin] });
    try {
      const first = (await harness.call("orders.fulfil.start", {
        input: { orderId: "42" },
        idempotencyKey: "order-42",
      })) as { id: string };
      const duplicate = (await harness.call("orders.fulfil.start", {
        input: { orderId: "42" },
        idempotencyKey: "order-42",
      })) as { id: string };
      expect(duplicate.id).toBe(first.id);
      await harness.tickWorkflows();
      await harness.tickWorkflows();
      const snapshot = await harness.workflow(first.id);
      expect(snapshot?.status).toBe("completed");
      expect(snapshot?.output).toEqual({ shipped: true });
      expect(snapshot?.steps.map(({ status }) => status)).toEqual(["completed", "completed"]);
    } finally {
      await harness.close();
    }
  });

  it("isolates status by organization and cancels before a claim", async () => {
    const harness = await createTestHarness({ plugins: [workflowPlugin] });
    try {
      const started = (await harness.call("orders.fulfil.start", {
        input: { orderId: "43" },
        idempotencyKey: "order-43",
      })) as { id: string };
      await harness.call("orders.fulfil.cancel", { id: started.id });
      expect((await harness.workflow(started.id))?.status).toBe("cancelled");
      expect(await harness.asHuman("other", { orgId: "other" }).workflow(started.id)).toBeNull();
    } finally {
      await harness.close();
    }
  });
});
