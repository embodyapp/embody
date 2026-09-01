import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compileManifest, definePlugin, stableStringify } from "../src/index.js";

const cardSchema = z.object({
  title: z.string().min(1).describe("Title of the card"),
  status: z.enum(["todo", "done"]).default("todo"),
  prUrl: z.url().optional(),
});

describe("manifest compiler", () => {
  it("emits five CRUD actions plus custom actions and subscriptions", () => {
    const manifest = compileManifest([
      definePlugin({
        id: "kanban",
        version: "1.0.0",
        entities: { card: { description: "A card", schema: cardSchema } },
        actions: {
          exportBoard: {
            description: "Export a board",
            input: z.object({ boardId: z.string() }),
            output: z.object({ url: z.url() }),
            handler: () => Promise.resolve({ url: "https://example.test/export" }),
          },
        },
        events: { "kanban.card.ready_for_review": () => Promise.resolve() },
      }),
    ]);

    expect(Object.keys(manifest.entities)).toEqual(["kanban.card"]);
    expect(Object.keys(manifest.actions)).toEqual([
      "kanban.card.create",
      "kanban.card.delete",
      "kanban.card.get",
      "kanban.card.list",
      "kanban.card.update",
      "kanban.exportBoard",
    ]);
    expect(manifest.eventSubscriptions).toEqual(["kanban.card.ready_for_review"]);
    expect(manifest.actions["kanban.card.create"]?.inputSchema).toMatchObject({
      type: "object",
      required: ["data"],
      properties: {
        data: {
          type: "object",
          properties: {
            title: { type: "string", description: "Title of the card", minLength: 1 },
            status: { type: "string", enum: ["todo", "done"], default: "todo" },
            prUrl: { type: "string", format: "uri" },
          },
        },
      },
    });
  });

  it("serializes identically regardless of plugin insertion order", () => {
    const alpha = definePlugin({ id: "alpha", version: "1.0.0", actions: {} });
    const beta = definePlugin({ id: "beta", version: "1.0.0", actions: {} });

    expect(stableStringify(compileManifest([alpha, beta]))).toBe(
      stableStringify(compileManifest([beta, alpha])),
    );
  });

  it("rejects canonical action collisions", () => {
    expect(() =>
      compileManifest([
        definePlugin({ id: "same", version: "1.0.0", actions: {} }),
        definePlugin({ id: "same", version: "2.0.0", actions: {} }),
      ]),
    ).toThrow(/duplicate plugin/i);
  });
});
