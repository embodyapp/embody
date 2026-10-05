import { z } from "zod";
import {
  changeEventSchema,
  compileEventSchema,
  submitEventSchema,
  invokeEventSchema,
  type GenUiChangeEvent,
  type GenUiActionEvent,
} from "./event-schema.js";
export type { GenUiEventSchema, GenUiChangeEvent, GenUiActionEvent } from "./event-schema.js";

export interface GenUiActionControl {
  readonly id: string;
  readonly label: string;
  readonly effect: string;
  readonly event: GenUiActionEvent;
  readonly disabled?: boolean | undefined;
  readonly pending?: boolean | undefined;
}

interface GenUiNodeVersion {
  readonly version: 1;
}
export type GenUiNode =
  | (GenUiNodeVersion & {
      readonly type: "text";
      readonly text: string;
      readonly sensitive?: boolean | undefined;
    })
  | (GenUiNodeVersion & {
      readonly type: "stack" | "columns";
      readonly children: readonly GenUiNode[];
    })
  | (GenUiNodeVersion & {
      readonly type: "callout";
      readonly tone: "info" | "warning" | "success";
      readonly text: string;
    })
  | (GenUiNodeVersion & {
      readonly type: "badge" | "emptyState" | "errorState";
      readonly text: string;
    })
  | (GenUiNodeVersion & {
      readonly type: "keyValue";
      readonly label: string;
      readonly value: string;
      readonly sensitive?: boolean | undefined;
    })
  | (GenUiNodeVersion & {
      readonly type: "field";
      readonly id: string;
      readonly label: string;
      readonly value: string;
      readonly event: GenUiChangeEvent;
      readonly sensitive?: boolean | undefined;
      readonly disabled?: boolean | undefined;
    })
  | (GenUiNodeVersion & {
      readonly type: "select";
      readonly id: string;
      readonly label: string;
      readonly value: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
      readonly event: GenUiChangeEvent;
      readonly sensitive?: boolean | undefined;
      readonly disabled?: boolean | undefined;
    })
  | (GenUiNodeVersion & {
      readonly type: "form";
      readonly id: string;
      readonly label: string;
      readonly effect: string;
      readonly children: readonly GenUiNode[];
      readonly event: GenUiActionEvent;
      readonly disabled?: boolean | undefined;
      readonly pending?: boolean | undefined;
    })
  | (GenUiNodeVersion & {
      readonly type: "actions";
      readonly actions: readonly GenUiActionControl[];
      readonly disabled?: boolean | undefined;
      readonly pending?: boolean | undefined;
    })
  | (GenUiNodeVersion & {
      readonly type: "section";
      readonly title: string;
      readonly children: readonly GenUiNode[];
    })
  | (GenUiNodeVersion & { readonly type: "list"; readonly items: readonly GenUiNode[] });

export interface GenUiDocument {
  readonly version: 1;
  readonly root: GenUiNode;
}

const nodeId = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const label = z.string().trim().min(1);
const actionControlSchema = z.strictObject({
  id: nodeId,
  label,
  effect: label,
  event: invokeEventSchema,
  disabled: z.boolean().optional(),
  pending: z.boolean().optional(),
});
const nodeSchema: z.ZodType<GenUiNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      version: z.literal(1),
      type: z.literal("text"),
      text: z.string(),
      sensitive: z.boolean().optional(),
    }),
    z.strictObject({
      version: z.literal(1),
      type: z.literal("stack"),
      children: z.array(nodeSchema),
    }),
    z.strictObject({
      version: z.literal(1),
      type: z.literal("columns"),
      children: z.array(nodeSchema),
    }),
    z.strictObject({
      version: z.literal(1),
      type: z.literal("callout"),
      tone: z.enum(["info", "warning", "success"]),
      text: z.string(),
    }),
    z.strictObject({ version: z.literal(1), type: z.literal("badge"), text: z.string() }),
    z.strictObject({ version: z.literal(1), type: z.literal("emptyState"), text: z.string() }),
    z.strictObject({ version: z.literal(1), type: z.literal("errorState"), text: z.string() }),
    z.strictObject({
      version: z.literal(1),
      type: z.literal("keyValue"),
      label: z.string(),
      value: z.string(),
      sensitive: z.boolean().optional(),
    }),
    z.strictObject({
      version: z.literal(1),
      type: z.literal("field"),
      id: nodeId,
      label,
      value: z.string(),
      event: changeEventSchema,
      sensitive: z.boolean().optional(),
      disabled: z.boolean().optional(),
    }),
    z
      .strictObject({
        version: z.literal(1),
        type: z.literal("select"),
        id: nodeId,
        label,
        value: z.string(),
        options: z
          .array(z.strictObject({ value: z.string(), label }))
          .min(1)
          .max(500),
        event: changeEventSchema,
        sensitive: z.boolean().optional(),
        disabled: z.boolean().optional(),
      })
      .refine(
        (node) =>
          node.options.some((option) => option.value === node.value) &&
          new Set(node.options.map((option) => option.value)).size === node.options.length,
      ),
    z.strictObject({
      version: z.literal(1),
      type: z.literal("form"),
      id: nodeId,
      label,
      effect: label,
      children: z.array(nodeSchema),
      event: submitEventSchema,
      disabled: z.boolean().optional(),
      pending: z.boolean().optional(),
    }),
    z.strictObject({
      version: z.literal(1),
      type: z.literal("actions"),
      actions: z.array(actionControlSchema).min(1).max(500),
      disabled: z.boolean().optional(),
      pending: z.boolean().optional(),
    }),
    z.strictObject({
      version: z.literal(1),
      type: z.literal("section"),
      title: z.string(),
      children: z.array(nodeSchema),
    }),
    z.strictObject({ version: z.literal(1), type: z.literal("list"), items: z.array(nodeSchema) }),
  ]),
);
const documentSchema = z.strictObject({ version: z.literal(1), root: nodeSchema });

export interface GenUiDocumentLimits {
  readonly maxSerializedBytes: number;
  /** Counts JSON containers, including children arrays, with document root at depth zero. */
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxTextLength: number;
  readonly maxOptions: number;
  readonly maxEventBytes: number;
}

export const GENUI_DOCUMENT_DEFAULT_LIMITS: GenUiDocumentLimits = Object.freeze({
  maxSerializedBytes: 262_144,
  maxDepth: 32,
  maxNodes: 2_000,
  maxTextLength: 8_192,
  maxOptions: 100,
  maxEventBytes: 16_384,
});
export const GENUI_DOCUMENT_HARD_LIMITS: GenUiDocumentLimits = Object.freeze({
  maxSerializedBytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 10_000,
  maxTextLength: 32_768,
  maxOptions: 500,
  maxEventBytes: 65_536,
});

export class GenUiDocumentError extends Error {
  readonly code = "GENUI_INVALID_DOCUMENT";
  constructor(message: string) {
    super(message);
    this.name = "GenUiDocumentError";
  }
}

function limitsFor(overrides: Partial<GenUiDocumentLimits>): GenUiDocumentLimits {
  const limits = { ...GENUI_DOCUMENT_DEFAULT_LIMITS, ...overrides };
  for (const key of Object.keys(GENUI_DOCUMENT_HARD_LIMITS) as (keyof GenUiDocumentLimits)[]) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > GENUI_DOCUMENT_HARD_LIMITS[key]
    )
      throw new GenUiDocumentError("GenUI document limit configuration is invalid");
  }
  return limits;
}

function preflight(value: unknown, limits: GenUiDocumentLimits): void {
  const pending: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let values = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (item.exit) {
      seen.delete(item.value as object);
      continue;
    }
    if (item.depth > limits.maxDepth)
      throw new GenUiDocumentError("GenUI document exceeds depth limit");
    if (++values > 100_000) throw new GenUiDocumentError("GenUI document exceeds value limit");
    if (typeof item.value === "string") {
      if (item.value.length > limits.maxTextLength)
        throw new GenUiDocumentError("GenUI document exceeds text limit");
      bytes += encoder.encode(item.value).length;
    } else if (item.value !== null && typeof item.value === "object") {
      if (seen.has(item.value))
        throw new GenUiDocumentError("GenUI document must be an acyclic JSON tree");
      seen.add(item.value);
      pending.push({ value: item.value, depth: item.depth, exit: true });
      if (
        !Array.isArray(item.value) &&
        Object.getPrototypeOf(item.value) !== Object.prototype &&
        Object.getPrototypeOf(item.value) !== null
      )
        throw new GenUiDocumentError("GenUI document must contain JSON values");
      const descriptors = Object.getOwnPropertyDescriptors(item.value);
      if (
        Object.getOwnPropertySymbols(item.value).length > 0 ||
        Object.entries(descriptors).some(
          ([key, descriptor]) =>
            descriptor.get !== undefined ||
            descriptor.set !== undefined ||
            (!descriptor.enumerable && !(Array.isArray(item.value) && key === "length")),
        )
      )
        throw new GenUiDocumentError("GenUI document must contain plain JSON values");
      const entries = Object.entries(descriptors)
        .filter(([, descriptor]) => descriptor.enumerable)
        .map(([key, descriptor]) => [key, descriptor.value] as const);
      if (values + pending.length + entries.length > 100_000)
        throw new GenUiDocumentError("GenUI document exceeds value limit");
      if (
        Object.hasOwn(item.value, "type") &&
        Object.hasOwn(item.value, "version") &&
        ++nodes > limits.maxNodes
      )
        throw new GenUiDocumentError("GenUI document exceeds node limit");
      if (
        descriptors["type"]?.value === "actions" &&
        Array.isArray(descriptors["actions"]?.value)
      ) {
        nodes += descriptors["actions"].value.length;
        if (nodes > limits.maxNodes)
          throw new GenUiDocumentError("GenUI document exceeds node limit");
      }
      for (const [key, child] of entries) {
        if (
          (key === "options" || key === "actions" || key === "enum") &&
          Array.isArray(child) &&
          child.length > limits.maxOptions
        )
          throw new GenUiDocumentError("GenUI document exceeds option limit");
        bytes += encoder.encode(key).length;
        pending.push({ value: child, depth: item.depth + 1 });
      }
    } else if (
      item.value !== null &&
      typeof item.value !== "boolean" &&
      !(typeof item.value === "number" && Number.isFinite(item.value))
    ) {
      throw new GenUiDocumentError("GenUI document must contain JSON values");
    }
    if (bytes > limits.maxSerializedBytes)
      throw new GenUiDocumentError("GenUI document exceeds byte limit");
  }
  if (encoder.encode(JSON.stringify(value)).length > limits.maxSerializedBytes)
    throw new GenUiDocumentError("GenUI document exceeds byte limit");
}

/** Depth/size validation precedes recursive schema parsing. Errors contain no supplied values. */
export function parseGenUiDocument(
  value: unknown,
  overrides: Partial<GenUiDocumentLimits> = {},
): GenUiDocument {
  const limits = limitsFor(overrides);
  preflight(value, limits);
  const parsed = documentSchema.safeParse(value);
  if (!parsed.success) throw new GenUiDocumentError("GenUI document schema is invalid");
  const interactive = new Set<string>();
  for (const node of documentControls(parsed.data.root)) {
    if (interactive.has(node.id))
      throw new GenUiDocumentError("GenUI document has duplicate node IDs");
    interactive.add(node.id);
  }
  const pending: object[] = [parsed.data];
  while (pending.length > 0) {
    const item = pending.pop()!;
    for (const child of Object.values(item) as unknown[])
      if (child !== null && typeof child === "object") pending.push(child);
    Object.freeze(item);
  }
  return parsed.data;
}

function* documentControls(root: GenUiNode) {
  const pending = [{ node: root, disabled: false }];
  while (pending.length > 0) {
    const { node, disabled: inherited } = pending.pop()!;
    const disabled =
      inherited || ("disabled" in node && !!node.disabled) || ("pending" in node && !!node.pending);
    if (node.type === "field" || node.type === "select" || node.type === "form")
      yield { ...node, disabled };
    if (node.type === "actions")
      for (const action of node.actions)
        yield {
          ...action,
          type: "action" as const,
          disabled: disabled || !!action.disabled || !!action.pending,
        };
    const children = "children" in node ? node.children : node.type === "list" ? node.items : [];
    for (let index = children.length - 1; index >= 0; index--)
      pending.push({ node: children[index]!, disabled });
  }
}

/** Canonical JSON for deterministic fixtures and artifact comparisons; contains dynamic data. */
export function serializeGenUiDocument(
  value: unknown,
  overrides: Partial<GenUiDocumentLimits> = {},
): string {
  return JSON.stringify(parseGenUiDocument(value, overrides), (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : item,
  );
}

export interface GenUiEventOptions {
  readonly callableTargets?: readonly string[];
  readonly limits?: Partial<GenUiDocumentLimits>;
}

/** Validates control input and declared targets; adapters must still authenticate and authorize ordinary execution. */
export function parseGenUiEvent(
  document: unknown,
  nodeId: string,
  payload: unknown,
  options: GenUiEventOptions = {},
): unknown {
  const limits = limitsFor(options.limits ?? {});
  const parsed = parseGenUiDocument(document, limits);
  const node = Array.from(documentControls(parsed.root)).find((item) => item.id === nodeId);
  if (node === undefined || node.disabled || ("pending" in node && node.pending))
    throw new GenUiDocumentError("GenUI event is unavailable");
  if (node.event.intent !== "change" && !options.callableTargets?.includes(node.event.target))
    throw new GenUiDocumentError("GenUI event target is not allowlisted");
  try {
    preflight(payload, { ...limits, maxSerializedBytes: limits.maxEventBytes });
    const result = compileEventSchema(node.event.schema).safeParse(payload);
    if (!result.success) throw new GenUiDocumentError("GenUI event payload is invalid");
    if (node.type === "select") {
      const selectedValue =
        result.data && typeof result.data === "object" && "value" in result.data
          ? result.data.value
          : undefined;
      if (!node.options.some((option) => option.value === selectedValue))
        throw new GenUiDocumentError("GenUI event payload is invalid");
    }
    return result.data;
  } catch {
    throw new GenUiDocumentError("GenUI event payload is invalid");
  }
}
