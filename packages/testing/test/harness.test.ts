import { describe, expect, it } from "vitest";
import { definePlugin, z, type KernelContext } from "@embody/core";
import { createTestHarness } from "../src/index.js";

const pluginSource = {
  id: "kanban",
  version: "1.0.0",
  services: () => ({ clock: "production" }),
  entities: { card: { schema: z.object({ title: z.string() }) } },
  actions: {
    service: {
      input: z.object({}),
      handler: (_input: Record<string, never>, ctx: KernelContext) =>
        ctx.services.get<string>("kanban.clock"),
    },
    publish: {
      input: z.object({ value: z.string() }),
      handler: async (input: { value: string }, ctx: KernelContext) => {
        await ctx.events.publish("kanban.card.created", input);
        ctx.progress({ percent: 50, message: input.value });
        return input;
      },
    },
  },
};
const plugin = definePlugin(pluginSource);

describe("createTestHarness", () => {
  it("uses the real execution, entity, authorization, and service paths", async () => {
    const harness = await createTestHarness({
      plugins: [plugin],
      tenantId: "org-a",
      services: { "kanban.clock": "fake" },
    });
    try {
      expect(await harness.call("kanban.service", {})).toBe("fake");
      const card = (await harness.call("kanban.card.create", { data: { title: "private" } })) as {
        id: string;
      };
      await expect(
        harness
          .as({
            orgId: "org-b",
            actorId: "other",
            actorType: "agent",
            roles: [],
            scopes: ["kanban:*"],
          })
          .call("kanban.card.get", { id: card.id }),
      ).rejects.toThrow(/not found/i);
    } finally {
      await harness.close();
    }
  });

  it("captures per-call progress and deterministically ticks the outbox", async () => {
    const harness = await createTestHarness({ plugins: [plugin], tenantId: "org-a" });
    try {
      await harness.call("kanban.publish", { value: "published" });
      expect(harness.progress()).toMatchObject([{ update: { percent: 50, message: "published" } }]);
      expect((await harness.outbox())[0]?.status).toBe("pending");
      await harness.tickOutbox();
      expect((await harness.events())[0]?.status).toBe("completed");
    } finally {
      await harness.close();
    }
  });

  it("rejects overrides for services the application did not declare", async () => {
    await expect(
      createTestHarness({ plugins: [plugin], services: { "kanban.missing": "fake" } }),
    ).rejects.toThrow(/unavailable service/i);
  });
});
