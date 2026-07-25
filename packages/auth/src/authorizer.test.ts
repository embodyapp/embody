import { describe, it, expect } from "vitest";
import { RbacAuthorizer, defaultPolicy, type RolePolicy } from "./authorizer.ts";
import type { Principal } from "@embody/kernel";

const principal = (roles: string[]): Principal => ({
  userId: "u1",
  orgId: "o1",
  roles,
});

describe("RbacAuthorizer", () => {
  const authz = new RbacAuthorizer(defaultPolicy);

  it("grants owners/admins everything", () => {
    expect(authz.can(principal(["owner"]), "delete", "crm:deal")).toBe(true);
    expect(authz.can(principal(["admin"]), "write", "anything:here")).toBe(true);
  });

  it("grants viewers read but not write", () => {
    expect(authz.can(principal(["viewer"]), "read", "crm:deal")).toBe(true);
    expect(authz.can(principal(["viewer"]), "write", "crm:deal")).toBe(false);
  });

  it("denies unknown roles", () => {
    expect(authz.can(principal(["ghost"]), "read", "crm:deal")).toBe(false);
  });

  it("supports resource prefix wildcards", () => {
    const policy: RolePolicy = {
      crmops: [{ action: "*", resource: "crm:*" }],
    };
    const a = new RbacAuthorizer(policy);
    expect(a.can(principal(["crmops"]), "delete", "crm:deal")).toBe(true);
    expect(a.can(principal(["crmops"]), "delete", "billing:invoice")).toBe(false);
  });

  it("combines grants across multiple roles", () => {
    expect(authz.can(principal(["ghost", "viewer"]), "read", "x:y")).toBe(true);
  });

  describe("grantsFor", () => {
    it("returns the permissions a role actually holds", () => {
      expect(authz.grantsFor(principal(["viewer"]))).toEqual([
        { action: "read", resource: "*" },
      ]);
    });

    it("unions roles and drops duplicates", () => {
      // owner and admin hold the identical grant in the default policy.
      expect(authz.grantsFor(principal(["owner", "admin"]))).toEqual([
        { action: "*", resource: "*" },
      ]);
    });

    it("returns nothing for unknown roles", () => {
      expect(authz.grantsFor(principal(["ghost"]))).toEqual([]);
    });

    it("agrees with can() for every grant it reports", () => {
      const p = principal(["member"]);
      for (const g of authz.grantsFor(p)) {
        expect(authz.can(p, g.action, "crm:deal")).toBe(true);
      }
    });
  });
});
