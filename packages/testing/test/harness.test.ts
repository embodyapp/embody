import { describe, expect, expectTypeOf, it } from "vitest";
import { definePlugin, HookVetoError, z, type KernelContext } from "@embody/core";
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
      output: z.object({ value: z.string() }),
      handler: async (input: { value: string }, ctx: KernelContext) => {
        await ctx.events.publish("kanban.card.created", input);
        ctx.progress({ percent: 50, message: input.value });
        return input;
      },
    },
    veto: {
      input: z.object({}),
      handler: () => {
        throw new HookVetoError("blocked by test guardrail");
      },
    },
  },
} as const;
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

  it("provides typed clients, actor conveniences, and structured observations", async () => {
    const harness = await createTestHarness({ plugins: [plugin] as const, tenantId: "org-a" });
    try {
      expectTypeOf(harness.client.kanban.publish).parameter(0).toEqualTypeOf<{ value: string }>();
      expectTypeOf(harness.client.kanban.publish).returns.toEqualTypeOf<
        Promise<{ value: string }>
      >();
      expect(await harness.client.kanban.publish({ value: "typed" })).toEqual({ value: "typed" });
      const card = await harness.client.kanban.card.create({ data: { title: "typed card" } });
      expectTypeOf(card.data.title).toEqualTypeOf<string>();
      expect(await harness.client.kanban.card.get({ id: card.id })).toEqual(card);
      expect(await harness.events("kanban.card.created")).toHaveLength(2);
      expect(harness.progress().map(({ update }) => update.message)).toContain("typed");
      expect(await harness.veto(() => harness.client.kanban.veto({}))).toMatchObject({
        code: "HOOK_VETO",
        message: "blocked by test guardrail",
      });
      expect(harness.asHuman("alice").principal).toMatchObject({
        orgId: "org-a",
        actorId: "alice",
        actorType: "human",
      });
      expect(harness.asAgent("bot", { orgId: "org-b" }).principal).toMatchObject({
        orgId: "org-b",
        actorId: "bot",
        actorType: "agent",
      });
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
