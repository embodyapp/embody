import { describe, expect, it } from "vitest";
import {
  assertUniqueMappedTargets,
  formatTarget,
  parseTarget,
  targetToMcpName,
} from "../src/index.js";

describe("canonical targets", () => {
  it.each(["kanban.card.create", "email.sendBatch"])("round-trips %s", (value) => {
    expect(formatTarget(parseTarget(value))).toBe(value);
  });

  it.each([
    "",
    ".",
    "kanban..create",
    "../secret",
    "kanban.card\ncreate",
    "__internal.run",
    "embody.run",
    "Kanban.card.create",
  ])("rejects unsafe target %j", (value) => expect(() => parseTarget(value)).toThrow());

  it("maps global and scoped MCP names deterministically", () => {
    expect(targetToMcpName("kanban.card.create", { appId: "work", scoped: false })).toBe(
      "work__kanban_card_create",
    );
    expect(targetToMcpName("kanban.card.create", { appId: "work", scoped: true })).toBe(
      "kanban_card_create",
    );
  });

  it("rejects mapped-name collisions", () => {
    expect(() => assertUniqueMappedTargets(["mail.sendBatch", "mail.send_batch"])).toThrow(
      /collision/i,
    );
  });
});
