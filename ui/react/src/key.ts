/**
 * Cache keys.
 *
 * Two components asking for the same data must land on the same entry, whatever order
 * they happened to spell the input in — `{stage, limit}` and `{limit, stage}` are one
 * query. So keys come from a canonical serialisation, not `JSON.stringify`.
 */

/** Entries that are not tool calls (identity, the tool catalogue) live under `@`. */
export const IDENTITY_KEY = "@me";
export const CATALOGUE_KEY = "@tools";

/**
 * Deterministic JSON: object keys sorted, `undefined` properties dropped (so
 * `{stage: undefined}` and `{}` are the same query), array order preserved.
 *
 * Throws on values JSON cannot round-trip. A silent coercion here would produce two
 * inputs that share a key but are not the same request — a cache that returns the wrong
 * data is far worse than one that refuses the input.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError(`Cannot build a cache key from ${String(value)}`);
      }
      return JSON.stringify(value);
    case "undefined":
      return "null";
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError(`Cannot build a cache key from a ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    // Date, Map, Set, class instances: each would stringify to something lossy or
    // ambiguous. Tool inputs are JSON going over the wire anyway — send a string.
    throw new TypeError(
      `Cannot build a cache key from ${(value as object).constructor?.name ?? "this value"}. ` +
        `Tool inputs must be plain JSON.`,
    );
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/** The cache key for a tool call. */
export function toolKey(tool: string, input?: unknown): string {
  return `${tool}:${stableStringify(input ?? {})}`;
}

/** The tool a key belongs to, or "" for the reserved `@` entries. */
export function toolOfKey(key: string): string {
  if (key.startsWith("@")) return "";
  const colon = key.indexOf(":");
  return colon === -1 ? key : key.slice(0, colon);
}
