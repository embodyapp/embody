/**
 * The client-side mirror of `framework/auth/src/authorizer.ts`.
 *
 * These cases mirror `framework/auth/src/authorizer.test.ts` one for one, on purpose:
 * they are what stops the client's idea of a permission from drifting away from the
 * server's. If the server's matching grows real syntax, this file fails with it.
 *
 * Run: `pnpm --filter @embody/react exec vitest run`
 */
import { describe, it, expect } from "vitest";
import { matchesPermission } from "./can.ts";
import type { Permission } from "./types.ts";

const OWNER: Permission[] = [{ action: "*", resource: "*" }];
const VIEWER: Permission[] = [{ action: "read", resource: "*" }];
const CRM_OPS: Permission[] = [{ action: "*", resource: "crm:*" }];

describe("matchesPermission", () => {
  it("grants owners everything", () => {
    expect(matchesPermission(OWNER, "delete", "crm:deal")).toBe(true);
    expect(matchesPermission(OWNER, "write", "anything:here")).toBe(true);
  });

  it("grants viewers read but not write", () => {
    expect(matchesPermission(VIEWER, "read", "crm:deal")).toBe(true);
    expect(matchesPermission(VIEWER, "write", "crm:deal")).toBe(false);
  });

  it("denies when there are no grants at all", () => {
    expect(matchesPermission([], "read", "crm:deal")).toBe(false);
  });

  it("supports resource prefix wildcards", () => {
    expect(matchesPermission(CRM_OPS, "delete", "crm:deal")).toBe(true);
    expect(matchesPermission(CRM_OPS, "delete", "billing:invoice")).toBe(false);
  });

  it("combines grants from several roles", () => {
    expect(matchesPermission([...CRM_OPS, ...VIEWER], "read", "x:y")).toBe(true);
  });
});
