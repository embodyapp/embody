import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appManifestSchema,
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
    expect(registrationRequestSchema.parse(accepted["registrationWithView"])).toBeTruthy();
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
    [registrationRequestSchema, rejected["invalidViewUriRegistration"]],
    [registrationRequestSchema, rejected["invalidViewIntegrityRegistration"]],
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

  it.each([
    ["unknown view protocol", (view: Record<string, unknown>) => (view["protocolVersion"] = 2)],
    ["unknown view kind", (view: Record<string, unknown>) => (view["kind"] = "remote")],
    ["unknown fallback", (view: Record<string, unknown>) => (view["fallback"] = "html")],
    ["mismatched view ID", (view: Record<string, unknown>) => (view["id"] = "other")],
    [
      "mismatched resource path",
      (view: Record<string, unknown>) => (view["resourceUri"] = "ui://kanban/other@1.0.0"),
    ],
    [
      "invalid callable target",
      (view: Record<string, unknown>) => (view["callableTargets"] = ["kanban.missing"]),
    ],
    [
      "duplicate callable target",
      (view: Record<string, unknown>) =>
        (view["callableTargets"] = ["kanban.card.update", "kanban.card.update"]),
    ],
  ])("rejects a manifest with %s", (_name, mutate) => {
    const registration = structuredClone(accepted["registrationWithView"]) as {
      manifest: { views: { board: Record<string, unknown> } };
    };
    mutate(registration.manifest.views.board);
    expect(appManifestSchema.safeParse(registration.manifest).success).toBe(false);
  });

  it("rejects presented actions without output or declared views", () => {
    const registration = structuredClone(accepted["registrationWithView"]) as {
      manifest: {
        actions: Record<string, Record<string, unknown>>;
        views: Record<string, unknown>;
      };
    };
    delete registration.manifest.actions["kanban.board"]?.["outputSchema"];
    expect(appManifestSchema.safeParse(registration.manifest).success).toBe(false);

    registration.manifest.actions["kanban.board"]!["outputSchema"] = { type: "object" };
    registration.manifest.views = {};
    expect(appManifestSchema.safeParse(registration.manifest).success).toBe(false);
  });

  it("rejects a view resource authority for another app", () => {
    const registration = structuredClone(accepted["registrationWithView"]) as {
      manifest: { views: { board: { resourceUri: string } } };
    };
    registration.manifest.views.board.resourceUri = "ui://other/board@1.0.0";
    expect(registrationRequestSchema.safeParse(registration).success).toBe(false);
  });
});
