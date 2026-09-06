import { describe, expect, it } from "vitest";
import { compileWorkflow, defineWorkflow, ValidationError, z } from "../src/index.js";

const step = { handler: () => ({ ok: true }) };

describe("workflow contract", () => {
  it("orders a diamond DAG deterministically", () => {
    const definition = defineWorkflow(z.object({ id: z.string() }))({
      version: "1.0.0",
      resultStep: "finish",
      steps: {
        finish: { ...step, dependsOn: ["left", "right"] },
        right: { ...step, dependsOn: ["root"] },
        root: step,
        left: { ...step, dependsOn: ["root"] },
      },
    });
    expect(compileWorkflow("demo", "flow", definition).order).toEqual([
      "root",
      "left",
      "right",
      "finish",
    ]);
  });

  it.each([
    ["missing dependency", { a: { ...step, dependsOn: ["missing"] } }, "missing step"],
    ["cycle", { a: { ...step, dependsOn: ["b"] }, b: { ...step, dependsOn: ["a"] } }, "cycle"],
    ["bad retry", { a: { ...step, retry: { maxAttempts: 0 } } }, "maxAttempts"],
    ["bad timeout", { a: { ...step, timeoutMs: 0 } }, "timeoutMs"],
  ])("rejects %s", (_name, steps, message) => {
    expect(() =>
      compileWorkflow("demo", "flow", { version: "1.0.0", input: z.object({}), steps }),
    ).toThrow(message);
  });

  it("rejects malformed versions and empty graphs", () => {
    expect(() =>
      compileWorkflow("demo", "flow", { version: "v1", input: z.object({}), steps: { a: step } }),
    ).toThrow(ValidationError);
    expect(() =>
      compileWorkflow("demo", "flow", { version: "1.0.0", input: z.object({}), steps: {} }),
    ).toThrow("has no steps");
  });
});
