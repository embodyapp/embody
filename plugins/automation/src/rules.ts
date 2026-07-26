/**
 * The configurable half of an automation: matching an event and shaping a tool call.
 *
 * Everything here is deliberately, permanently small. Embody's core promise (D8) is
 * "no low-code builder and no runtime metadata engine" — real logic stays in
 * TypeScript. A condition language grows into an interpreter one reasonable feature
 * request at a time (arithmetic, then functions, then nesting, then a debugger, then a
 * UI), so the line is drawn here and written down:
 *
 *   - conditions are `path op value`, ANDed, with one level of `any_of` for OR;
 *   - there is no arithmetic, no function call, no expression evaluation;
 *   - templates substitute a value, they do not compute one.
 *
 * The escape hatch is not a bigger language. It is `defineAutomation`, where you have
 * the whole of TypeScript. If a rule cannot be said in the vocabulary below, that is
 * the signal to write a handler, not to extend this file.
 *
 * Pure functions with no imports, so the semantics are unit-testable without a kernel
 * or a database.
 */
import type { DomainEvent } from "@embody/plugin-sdk";

export const CONDITION_OPS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
  "exists",
] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface Comparison {
  /** Dotted path into the event, e.g. "payload.amount" or "name". */
  path: string;
  op: ConditionOp;
  /** Not required by `exists`. */
  value?: unknown;
}

/** A group is satisfied when ANY of its comparisons is. */
export interface AnyOf {
  any_of: Comparison[];
}

export type Condition = Comparison | AnyOf;

/**
 * The event as conditions and templates see it: `name`, `payload`, `at`.
 *
 * `at` is tolerant of a non-Date even though `DomainEvent` types it as one: events
 * arrive from a database column and from JSON over the wire, and a rule engine that
 * throws on a well-formed timestamp in the wrong wrapper is worse than useless.
 */
export function eventScope(event: DomainEvent): Record<string, unknown> {
  const at = event.at;
  const iso =
    at instanceof Date
      ? at.toISOString()
      : at
        ? new Date(at as string | number).toISOString()
        : new Date().toISOString();
  return { name: event.name, payload: event.payload, at: iso };
}

/** Walk a dotted path. Returns undefined for any missing link, never throws. */
export function resolvePath(scope: unknown, path: string): unknown {
  let current: unknown = scope;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function compare(actual: unknown, op: ConditionOp, expected: unknown): boolean {
  switch (op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "eq":
      return looseEquals(actual, expected);
    case "ne":
      return !looseEquals(actual, expected);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      // Numeric columns arrive from Postgres as strings ("45000.00"), so an amount
      // comparison would silently be a string comparison. Coerce, and refuse rather
      // than guess when either side is not a number.
      const a = Number(actual);
      const b = Number(expected);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (op === "gt") return a > b;
      if (op === "gte") return a >= b;
      if (op === "lt") return a < b;
      return a <= b;
    }
    case "in":
      return Array.isArray(expected) && expected.some((v) => looseEquals(actual, v));
    case "contains":
      if (Array.isArray(actual)) return actual.some((v) => looseEquals(v, expected));
      if (typeof actual === "string") return actual.includes(String(expected));
      return false;
  }
}

/**
 * Compare with the same numeric coercion as the ordering operators, so
 * `payload.amount eq 45000` matches the string "45000.00" Postgres returns. Everything
 * else is compared by value after JSON normalisation.
 */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  if (a !== null && b !== null && a !== "" && b !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return na === nb;
  }
  if (typeof a === "object" && typeof b === "object" && a && b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function isAnyOf(c: Condition): c is AnyOf {
  return typeof c === "object" && c !== null && Array.isArray((c as AnyOf).any_of);
}

/** True when every condition holds. An empty list matches everything. */
export function conditionsMatch(conditions: Condition[], event: DomainEvent): boolean {
  const scope = eventScope(event);
  return conditions.every((c) =>
    isAnyOf(c)
      ? c.any_of.some((cmp) => compare(resolvePath(scope, cmp.path), cmp.op, cmp.value))
      : compare(resolvePath(scope, c.path), c.op, c.value),
  );
}

/**
 * Build a tool's input from a workflow's `input_map`.
 *
 * A string that is *exactly* `{{path}}` is replaced by the resolved value with its type
 * intact — `{{payload.amount}}` yields the number 45000, not the string "45000". A
 * string with `{{...}}` embedded in other text is interpolated as text. Anything else
 * passes through as a literal, which is how you set a constant like
 * `{"stage": "closed_won"}`. Nested objects and arrays are mapped recursively.
 *
 * With no map, the action receives the event envelope — the shape `defineAutomation`
 * declares — so the common case needs no mapping at all.
 */
export function buildInput(
  inputMap: unknown,
  event: DomainEvent,
): Record<string, unknown> {
  const scope = eventScope(event);
  if (inputMap === null || inputMap === undefined) {
    return scope;
  }
  return substitute(inputMap, scope) as Record<string, unknown>;
}

const WHOLE_TEMPLATE = /^\{\{\s*([\w.]+)\s*\}\}$/;
const EMBEDDED_TEMPLATE = /\{\{\s*([\w.]+)\s*\}\}/g;

function substitute(node: unknown, scope: Record<string, unknown>): unknown {
  if (typeof node === "string") {
    const whole = WHOLE_TEMPLATE.exec(node);
    if (whole) return resolvePath(scope, whole[1]!);
    return node.replace(EMBEDDED_TEMPLATE, (_, path: string) => {
      const value = resolvePath(scope, path);
      return value === undefined || value === null ? "" : String(value);
    });
  }
  if (Array.isArray(node)) return node.map((n) => substitute(n, scope));
  if (typeof node === "object" && node !== null) {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, substitute(v, scope)]),
    );
  }
  return node;
}

/**
 * Parse the CLI's condition sugar (`payload.amount > 50000`) into stored form.
 *
 * This exists so `--if` reads like a person wrote it while the database keeps the
 * structured shape. It is a splitter, not a parser: one comparison per string, no
 * precedence, no parentheses. Pass `--if` more than once to AND them.
 */
const OP_ALIASES: Record<string, ConditionOp> = {
  "==": "eq",
  "=": "eq",
  "!=": "ne",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
  eq: "eq",
  ne: "ne",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  in: "in",
  contains: "contains",
  exists: "exists",
};

export function parseCondition(text: string): Comparison {
  const trimmed = text.trim();
  // Longest operators first, so ">=" is not read as ">".
  const tokens = Object.keys(OP_ALIASES).sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    const isWord = /^[a-z]+$/.test(token);
    const idx = isWord
      ? trimmed.toLowerCase().indexOf(` ${token} `)
      : trimmed.indexOf(token);
    if (idx < 0) continue;
    const path = trimmed.slice(0, idx).trim();
    const rest = trimmed.slice(idx + (isWord ? token.length + 2 : token.length)).trim();
    if (!path) continue;
    const op = OP_ALIASES[token]!;
    if (op === "exists") return { path, op };
    return { path, op, value: parseValue(rest) };
  }
  // No operator at all: treat a bare path as a truthiness check.
  return { path: trimmed, op: "exists" };
}

function parseValue(raw: string): unknown {
  const text = raw.trim();
  if (text === "") return "";
  try {
    // JSON first, so numbers, booleans, null, and arrays keep their types.
    return JSON.parse(text) as unknown;
  } catch {
    // A bare word or an unquoted phrase is a string. Strip matching quotes if present.
    return text.replace(/^['"]|['"]$/g, "");
  }
}
