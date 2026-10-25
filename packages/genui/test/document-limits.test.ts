import { expect, it } from "vitest";
import { parseGenUiDocument, parseGenUiEvent, serializeGenUiDocument } from "../src/index.js";

const text = { version: 1, root: { version: 1, type: "text", text: "Hi" } };

it("serializes normalized documents in canonical property order", () => {
  expect(serializeGenUiDocument(text)).toBe(
    '{"root":{"text":"Hi","type":"text","version":1},"version":1}',
  );
  expect(
    serializeGenUiDocument({ root: { text: "Hi", type: "text", version: 1 }, version: 1 }),
  ).toBe(serializeGenUiDocument(text));
});

it.each([
  [{ maxTextLength: 2 }, { ...text, root: { ...text.root, text: "abc" } }, "text"],
  [{ maxSerializedBytes: 1 }, text, "byte"],
  [
    { maxNodes: 1 },
    { version: 1, root: { version: 1, type: "stack", children: [text.root] } },
    "node",
  ],
  [
    { maxDepth: 1 },
    { version: 1, root: { version: 1, type: "stack", children: [text.root] } },
    "depth",
  ],
] as const)("enforces configured document limits before schema parsing", (limits, value, limit) => {
  expect(() => parseGenUiDocument(value, limits)).toThrow(`GenUI document exceeds ${limit} limit`);
});

it("rejects invalid configurations and cycles with safe errors", () => {
  expect(() => parseGenUiDocument(text, { maxDepth: 65 })).toThrow(/configuration/);
  expect(() => parseGenUiDocument(text, { maxNodes: 0 })).toThrow(/configuration/);
  const cyclic: Record<string, unknown> = { version: 1, type: "stack" };
  cyclic["children"] = [cyclic];
  expect(() => parseGenUiDocument({ version: 1, root: cyclic })).toThrow(/acyclic/);
});

it("rejects accessor-backed documents without invoking supplied code", () => {
  let calls = 0;
  const root = { version: 1, type: "text" };
  Object.defineProperty(root, "text", {
    enumerable: true,
    get: () => {
      calls++;
      return "private";
    },
  });
  expect(() => parseGenUiDocument({ version: 1, root })).toThrow(/JSON/);
  expect(calls).toBe(0);
});

it("enforces configured option counts and event payload limits", () => {
  const select = {
    version: 1,
    root: {
      version: 1,
      type: "select",
      id: "choice",
      label: "Choice",
      value: "a",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      event: {
        intent: "change",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { type: "string", maxLength: 100 } },
        },
      },
    },
  };
  expect(() => parseGenUiDocument(select, { maxOptions: 1 })).toThrow(/option limit/);
  expect(() =>
    parseGenUiEvent(select, "choice", { value: "a" }, { limits: { maxEventBytes: 1 } }),
  ).toThrow(/event payload/);
});

it("bounds event payload bytes independently of the document", () => {
  const document = {
    version: 1,
    root: {
      version: 1,
      type: "form",
      id: "form",
      label: "Submit",
      effect: "Update data",
      children: [],
      event: {
        intent: "submit",
        target: "cards.update",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["a", "b", "c"],
          properties: {
            a: { type: "string", maxLength: 8_192 },
            b: { type: "string", maxLength: 8_192 },
            c: { type: "string", maxLength: 8_192 },
          },
        },
      },
    },
  };
  expect(() =>
    parseGenUiEvent(
      document,
      "form",
      { a: "a".repeat(8_000), b: "b".repeat(8_000), c: "c".repeat(8_000) },
      { callableTargets: ["cards.update"] },
    ),
  ).toThrow(/event payload/);
});
