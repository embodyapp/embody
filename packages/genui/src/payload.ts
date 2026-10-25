import { z } from "zod";
export type GenUiPayloadBinding =
  | { readonly kind: "literal"; readonly value: string | number | boolean | null }
  | { readonly kind: "field"; readonly id: string; readonly omitEmpty?: boolean | undefined }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, GenUiPayloadBinding>> };
const schema: z.ZodType<GenUiPayloadBinding> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("literal"),
      value: z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null()]),
    }),
    z.strictObject({
      kind: z.literal("field"),
      id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
      omitEmpty: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal("object"),
      fields: z.record(
        z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/)
          .refine((key) => !["constructor", "prototype", "__proto__"].includes(key)),
        schema,
      ),
    }),
  ]),
);
/** Declarative trusted app data composition, shared by browser/native; still validate the resulting event. */
export function resolveGenUiPayload(
  binding: unknown,
  values: Readonly<Record<string, string>>,
): unknown {
  const queue: { value: unknown; depth: number }[] = [{ value: binding, depth: 0 }];
  let count = 0;
  while (queue.length) {
    const item = queue.pop()!;
    if (++count > 1000 || item.depth > 16) throw new Error("GenUI payload binding is invalid");
    if (item.value !== null && typeof item.value === "object") {
      const descriptors = Object.getOwnPropertyDescriptors(item.value);
      for (const descriptor of Object.values(descriptors)) {
        if (!("value" in descriptor)) throw new Error("GenUI payload binding is invalid");
        queue.push({ value: descriptor.value as unknown, depth: item.depth + 1 });
      }
    }
  }
  const result = schema.safeParse(binding);
  if (!result.success) throw new Error("GenUI payload binding is invalid");
  function resolve(node: GenUiPayloadBinding): unknown {
    if (node.kind === "literal") return node.value;
    if (node.kind === "field") {
      const value = values[node.id] ?? "";
      if (typeof value !== "string" || value.length > 8192)
        throw new Error("GenUI field value is invalid");
      return node.omitEmpty && value === "" ? undefined : value;
    }
    return Object.fromEntries(
      Object.entries(node.fields)
        .map(([key, child]) => [key, resolve(child)])
        .filter(([, value]) => value !== undefined),
    );
  }
  return resolve(result.data);
}
