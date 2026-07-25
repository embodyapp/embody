/**
 * These cases are the contract the CLI (`--org/--user/--roles`, EMBODY_* env) and the
 * HTTP bridge (`x-embody-*` headers) both depend on. If they drift, the same identity
 * means two different things depending on how you connected.
 *
 * Run: `pnpm --filter @embody/auth exec vitest run`
 */
import { describe, it, expect } from "vitest";
import { principalFrom, parseRoles } from "./principal.ts";

describe("parseRoles", () => {
  it("splits, trims and drops empties", () => {
    expect(parseRoles("owner, viewer ,, member")).toEqual(["owner", "viewer", "member"]);
  });

  it("defaults to owner when absent or effectively empty", () => {
    expect(parseRoles(undefined)).toEqual(["owner"]);
    expect(parseRoles("")).toEqual(["owner"]);
    expect(parseRoles(" , ")).toEqual(["owner"]);
  });
});

describe("principalFrom", () => {
  it("builds a principal from org + user + roles", () => {
    expect(principalFrom({ org: "o1", user: "u1", roles: "viewer" })).toEqual({
      orgId: "o1",
      userId: "u1",
      roles: ["viewer"],
    });
  });

  it("allows an unattributed actor (no user id)", () => {
    expect(principalFrom({ org: "o1" })).toEqual({
      orgId: "o1",
      userId: "",
      roles: ["owner"],
    });
  });

  it("returns null without an org — there is no tenant to scope to", () => {
    expect(principalFrom({ user: "u1", roles: "owner" })).toBeNull();
    expect(principalFrom({ org: "   " })).toBeNull();
  });
});
