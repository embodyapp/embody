import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  errorEnvelopeSchema,
  eventEnvelopeSchema,
  executionRequestSchema,
  heartbeatRequestSchema,
  principalClaimsSchema,
  progressUpdateSchema,
  registrationRequestSchema,
} from "../src/index.js";

const accepted = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/protocol/accepted.json"), "utf8"),
) as Record<string, unknown>;
const rejected = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/protocol/rejected.json"), "utf8"),
) as Record<string, unknown>;

describe("wire protocol contracts", () => {
  it("parses accepted phase-zero fixtures", () => {
    expect(registrationRequestSchema.parse(accepted["registration"])).toBeTruthy();
    expect(heartbeatRequestSchema.parse(accepted["heartbeat"])).toBeTruthy();
    expect(executionRequestSchema.parse(accepted["execution"])).toBeTruthy();
    expect(principalClaimsSchema.parse(accepted["principalClaims"])).toBeTruthy();
    expect(eventEnvelopeSchema.parse(accepted["event"])).toBeTruthy();
    expect(progressUpdateSchema.parse(accepted["progress"])).toBeTruthy();
    expect(errorEnvelopeSchema.parse(accepted["error"])).toBeTruthy();
  });

  it.each([
    [executionRequestSchema, rejected["missingVersionExecution"]],
    [executionRequestSchema, rejected["futureVersionExecution"]],
    [registrationRequestSchema, rejected["malformedUrlRegistration"]],
    [progressUpdateSchema, rejected["invalidProgress"]],
  ])("rejects an invalid protocol fixture", (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("rejects unknown security-envelope fields", () => {
    expect(
      principalClaimsSchema.safeParse({
        ...(accepted["principalClaims"] as Record<string, unknown>),
        admin: true,
      }).success,
    ).toBe(false);
  });
});
