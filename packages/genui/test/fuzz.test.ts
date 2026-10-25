import { expect, it } from "vitest";
import { parseGenUiDocument, parseGenUiEvent } from "../src/document.js";
import { parseGenUiResourceJson } from "../src/index.js";
import { resolveGenUiPayload } from "../src/payload.js";
import { renderGenUiText } from "../src/text.js";
// Retained deterministic adversarial seed corpus. Budget is iteration/byte bound, not an unbounded random run.
const seeds = [
  null,
  [],
  { version: 999 },
  { version: 1, root: { version: 1, type: "script", text: "secret-marker" } },
  {
    version: 1,
    root: { version: 1, type: "text", text: "<script>inert</script>\u001b[31m\u202e" },
  },
  JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
];
it("keeps deterministic parser fuzz seeds bounded, value-free on rejection and inert on acceptance", () => {
  const start = performance.now();
  let random = 0x14c0ffee;
  const next = () => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return random >>> 0;
  };
  for (let iteration = 0; iteration < 1000; iteration++) {
    // Fixed seed, real structural variation, and a bounded 32-node/4-KiB input
    // budget. Retain the hand-written corpus alongside generated mutations.
    const length = next() % 32;
    const generated = {
      version: next() % 3,
      root: {
        version: 1,
        type: next() % 2 ? "stack" : "list",
        children: Array.from({ length }, () => ({
          version: next() % 3,
          type: ["text", "script", "field", "__proto__"][next() % 4],
          text: "<script>inert</script>\u001b[31m\u202e".repeat(next() % 4),
        })),
      },
    };
    const seed = iteration % 2 ? generated : seeds[iteration % seeds.length];
    for (const parse of [
      () => parseGenUiDocument(seed),
      () => parseGenUiResourceJson(JSON.stringify(seed)),
      () => resolveGenUiPayload(seed, {}),
      () => parseGenUiEvent(seed, "unknown", seed),
    ]) {
      let result: unknown;
      try {
        result = parse();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(RangeError);
        expect((error as Error).message).not.toContain("secret-marker");
        continue;
      }
      if (result && typeof result === "object" && "root" in result) {
        const text = renderGenUiText(result);
        expect(text).not.toContain("\u001b");
        expect(text).not.toContain("\u202e");
      }
    }
  }
  expect(performance.now() - start).toBeLessThan(5000);
  expect(Object.getPrototypeOf({})).not.toHaveProperty("polluted");
  const cyclic: { kind: string; fields?: unknown } = { kind: "object" };
  cyclic.fields = cyclic;
  expect(() => resolveGenUiPayload(cyclic, {})).toThrow();
});
