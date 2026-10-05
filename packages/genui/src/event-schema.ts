import { z } from "zod";

/** Deliberately bounded JSON Schema subset: no references, regexes, executable validators or remote schemas. */
export type GenUiEventSchema =
  | {
      readonly type: "string";
      readonly maxLength: number;
      readonly enum?: readonly string[] | undefined;
    }
  | { readonly type: "boolean" }
  | { readonly type: "integer"; readonly minimum: number; readonly maximum: number }
  | {
      readonly type: "object";
      readonly additionalProperties: false;
      readonly properties: Readonly<Record<string, GenUiEventSchema>>;
      readonly required: readonly string[];
    };

export interface GenUiChangeEvent {
  readonly intent: "change";
  readonly schema: GenUiEventSchema;
}

export const eventSchema: z.ZodType<GenUiEventSchema> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("string"),
      maxLength: z.number().int().min(1).max(8_192),
      enum: z.array(z.string()).min(1).max(500).optional(),
    }),
    z.strictObject({ type: z.literal("boolean") }),
    z
      .strictObject({
        type: z.literal("integer"),
        minimum: z.number().safe(),
        maximum: z.number().safe(),
      })
      .refine((schema) => schema.minimum <= schema.maximum),
    z
      .strictObject({
        type: z.literal("object"),
        additionalProperties: z.literal(false),
        properties: z.record(z.string().min(1).max(63), eventSchema),
        required: z.array(z.string()).max(100),
      })
      .refine(
        (schema) =>
          Object.keys(schema.properties).length <= 100 &&
          new Set(schema.required).size === schema.required.length &&
          schema.required.every((key) => Object.hasOwn(schema.properties, key)),
      ),
  ]),
);
export const changeEventSchema: z.ZodType<GenUiChangeEvent> = z
  .strictObject({ intent: z.literal("change"), schema: eventSchema })
  .refine(
    ({ schema }) =>
      schema.type === "object" &&
      schema.required.length === 1 &&
      schema.required[0] === "value" &&
      Object.keys(schema.properties).length === 1 &&
      schema.properties["value"]?.type === "string",
  );

export interface GenUiActionEvent {
  readonly intent: "submit" | "invoke";
  readonly target: string;
  readonly schema: GenUiEventSchema;
}
const targetSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}(?:\.[a-zA-Z][a-zA-Z0-9_-]{0,62}){1,2}$/);
export const submitEventSchema: z.ZodType<GenUiActionEvent> = z.strictObject({
  intent: z.literal("submit"),
  target: targetSchema,
  schema: eventSchema,
});
export const invokeEventSchema: z.ZodType<GenUiActionEvent> = z.strictObject({
  intent: z.literal("invoke"),
  target: targetSchema,
  schema: eventSchema,
});

export function compileEventSchema(schema: GenUiEventSchema): z.ZodType {
  switch (schema.type) {
    case "string":
      return z
        .string()
        .max(schema.maxLength)
        .refine((value) => schema.enum === undefined || schema.enum.includes(value));
    case "boolean":
      return z.boolean();
    case "integer":
      return z.number().int().min(schema.minimum).max(schema.maximum);
    case "object":
      return z.strictObject(
        Object.fromEntries(
          Object.entries(schema.properties).map(([key, value]) => {
            const compiled = compileEventSchema(value);
            return [key, schema.required.includes(key) ? compiled : compiled.optional()];
          }),
        ),
      );
  }
}
