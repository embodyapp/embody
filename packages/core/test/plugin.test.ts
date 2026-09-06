import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { definePlugin, type EntityDefinition } from "../src/index.js";

describe("definePlugin", () => {
  it("returns the original plugin without mutation and infers handler input", async () => {
    const handler = vi.fn((input: { message: string }) => Promise.resolve(input.message.length));
    const source = {
      id: "greeting",
      version: "1.0.0",
      entities: {
        note: { schema: z.object({ body: z.string(), archived: z.boolean().default(false) }) },
      },
      actions: {
        length: {
          input: z.object({ message: z.string() }),
          output: z.number(),
          handler,
        },
      },
    };

    const beforeKeys = Object.keys(source);
    const plugin = definePlugin(source);

    expect(plugin).toBe(source);
    expect(Object.keys(source)).toEqual(beforeKeys);
    await plugin.actions.length.handler({ message: "hello" });
    expect(handler).toHaveBeenCalledWith({ message: "hello" });
    expectTypeOf(plugin.entities.note.schema).toMatchTypeOf<
      z.ZodObject<{ body: z.ZodString; archived: z.ZodDefault<z.ZodBoolean> }>
    >();
  });

  it("infers action input, entity stores, and lifecycle payloads in the typed form", () => {
    const typed = definePlugin(
      {
        id: "notes",
        version: "1.0.0",
        entities: { note: { schema: z.object({ body: z.string(), archived: z.boolean() }) } },
      },
      (define) => ({
        actions: {
          archive: define.action({
            input: z.object({ id: z.uuid() }),
            handler: async ({ id }, context) => {
              expectTypeOf(id).toEqualTypeOf<string>();
              const note = await context.entities.note.get(id);
              expectTypeOf(note.data.body).toEqualTypeOf<string>();
              expectTypeOf(context.entities.note.getMany([id])).toEqualTypeOf<
                Promise<readonly (typeof note)[]>
              >();
              await context.entities.note.updateMany([{ id, data: { archived: true } }]);
              return context.entities.note.update(id, { archived: true });
            },
          }),
        },
        hooks: [
          define.beforeUpdate("note", ({ current, patch }) => {
            expectTypeOf(current.data.body).toEqualTypeOf<string>();
            expectTypeOf(patch.archived).toEqualTypeOf<boolean | undefined>();
          }),
        ],
      }),
    );

    expect(Object.keys(typed.actions ?? {})).toEqual(["archive"]);
    expect(Object.keys(typed.hooks ?? {})).toEqual(["notes.note.beforeUpdate"]);
  });

  it("rejects handler input types that disagree with their schema", () => {
    definePlugin({
      id: "typed",
      version: "1.0.0",
      actions: {
        echo: {
          input: z.object({ message: z.string() }),
          // @ts-expect-error message is a string according to the input schema
          handler: (input: { message: number }) => input.message,
        },
      },
    });
  });

  it("types entity indexes as schema keys", () => {
    const schema = z.object({ title: z.string(), priority: z.number() });
    const valid: EntityDefinition<typeof schema> = { schema, indexes: ["priority"] };
    expect(valid.indexes).toEqual(["priority"]);

    const invalid: EntityDefinition<typeof schema> = {
      schema,
      // @ts-expect-error unknown index fields must not type-check
      indexes: ["missing"],
    };
    expect(invalid.indexes).toEqual(["missing"]);
  });
});
