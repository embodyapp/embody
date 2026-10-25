import { expect, it } from "vitest";
import { resolveGenUiPayload } from "../src/payload.js";
it("composes app-owned data bindings without executing code or copying unrelated drafts", () => {
  const binding = {
    kind: "object",
    fields: {
      id: { kind: "literal", value: "card-1" },
      data: {
        kind: "object",
        fields: {
          status: { kind: "field", id: "status" },
          prUrl: { kind: "field", id: "pr", omitEmpty: true },
        },
      },
    },
  };
  expect(resolveGenUiPayload(binding, { status: "done", pr: "", secret: "do not copy" })).toEqual({
    id: "card-1",
    data: { status: "done" },
  });
  expect(() => resolveGenUiPayload({ kind: "code", source: "evil()" }, {})).toThrow();
});
