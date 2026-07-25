/**
 * Run: `pnpm --filter @embody/react exec vitest run`
 */
import { describe, it, expect } from "vitest";
import { stableStringify, toolKey, toolOfKey } from "./key.ts";

describe("stableStringify", () => {
  it("is insensitive to key order — one query, one key", () => {
    expect(stableStringify({ stage: "lead", limit: 10 })).toBe(
      stableStringify({ limit: 10, stage: "lead" }),
    );
  });

  it("treats an explicit undefined as absent", () => {
    expect(stableStringify({ stage: undefined, limit: 5 })).toBe(stableStringify({ limit: 5 }));
  });

  it("preserves array order, which is meaningful", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("sorts nested objects too", () => {
    expect(stableStringify({ a: { y: 1, x: 2 } })).toBe(stableStringify({ a: { x: 2, y: 1 } }));
  });

  it("refuses values JSON cannot round-trip", () => {
    // Silently coercing these would let two different requests share one key.
    expect(() => stableStringify({ at: new Date() })).toThrow(/plain JSON/);
    expect(() => stableStringify({ m: new Map() })).toThrow(/plain JSON/);
    expect(() => stableStringify({ fn: () => 1 })).toThrow(/function/);
    expect(() => stableStringify({ n: Number.NaN })).toThrow(/NaN/);
  });
});

describe("toolKey", () => {
  it("namespaces by tool, and treats no input as empty input", () => {
    expect(toolKey("crm_query_deals")).toBe("crm_query_deals:{}");
    expect(toolKey("crm_query_deals", {})).toBe(toolKey("crm_query_deals"));
  });

  it("separates different inputs of the same tool", () => {
    expect(toolKey("crm_query_deals", { stage: "lead" })).not.toBe(
      toolKey("crm_query_deals", { stage: "won" }),
    );
  });
});

describe("toolOfKey", () => {
  it("recovers the tool name, so group invalidation works", () => {
    expect(toolOfKey(toolKey("crm_query_deals", { stage: "lead" }))).toBe("crm_query_deals");
  });

  it("reports no tool for the reserved entries", () => {
    expect(toolOfKey("@me")).toBe("");
    expect(toolOfKey("@tools")).toBe("");
  });
});
