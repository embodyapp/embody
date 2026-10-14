import { describe, expect, it } from "vitest";
import {
  assertHostedWorkflowLimits,
  definePlugin,
  defineWorkflow,
  HOSTED_WORKFLOW_LIMITS,
  ValidationError,
  z,
} from "../src/index.js";

const handler = () => ({ ok: true });
const plugin = (step: Record<string, unknown>) =>
  definePlugin({
    id: "orders",
    version: "1.0.0",
    workflows: {
      flow: defineWorkflow(z.object({}))({
        version: "1.0.0",
        steps: { charge: { handler, ...step } },
      }),
    },
  });
const day = 24 * 60 * 60 * 1_000;

describe("hosted workflow limits", () => {
  it("accepts steps at the limits and steps without explicit limits", () => {
    expect(() =>
      assertHostedWorkflowLimits([
        plugin({}),
        plugin({ timeoutMs: 30_000, delayMs: 30 * day }),
        // Backoff before the last attempt: 2^(3-2) * 15 days = 30 days.
        plugin({ retry: { maxAttempts: 3, backoffMs: 15 * day } }),
      ]),
    ).not.toThrow();
    expect(HOSTED_WORKFLOW_LIMITS).toEqual({ stepTimeoutMs: 30_000, maxDelayMs: 30 * day });
  });

  it.each([
    [
      "step timeout",
      { timeoutMs: 30_001 },
      /orders\.flow step charge has timeoutMs 30001.*Split the step/,
    ],
    [
      "delay",
      { delayMs: 30 * day + 1 },
      /orders\.flow step charge has delayMs .*Chain shorter delayed steps/,
    ],
    [
      "retry backoff",
      { retry: { maxAttempts: 3, backoffMs: 15 * day + 1 } },
      /orders\.flow step charge retry backoff reaches .*Lower maxAttempts or backoffMs/,
    ],
    ["default backoff growth", { retry: { maxAttempts: 34 } }, /retry backoff reaches/],
  ])("rejects an oversized %s with an actionable error", (_name, step, message) => {
    expect(() => assertHostedWorkflowLimits([plugin(step)])).toThrow(ValidationError);
    expect(() => assertHostedWorkflowLimits([plugin(step)])).toThrow(message);
  });
});
