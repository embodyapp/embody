/**
 * The condition language and the input mapper, tested without a kernel or a database.
 *
 * These are the semantics a user writes automations against, so they need to be
 * pinned: the Postgres-numeric coercion in particular is the difference between
 * "amount > 50000" working and silently comparing the strings "45000.00" and "50000".
 */
import { describe, it, expect } from "vitest";
import type { DomainEvent } from "@embody/plugin-sdk";
import { conditionsMatch, buildInput, parseCondition, resolvePath } from "./rules.ts";

const deal = (over: Record<string, unknown> = {}): DomainEvent => ({
  name: "crm.deal.created",
  orgId: "org-1",
  at: new Date("2026-07-26T12:00:00Z"),
  payload: {
    id: "d1",
    title: "Contoso",
    // Postgres numerics come back as strings — the whole reason compare() coerces.
    amount: "45000.00",
    stage: "lead",
    tags: ["inbound", "enterprise"],
    custom_fields: { industry_vertical: "healthcare" },
    ...over,
  },
});

describe("resolvePath", () => {
  it("walks nested keys", () => {
    expect(resolvePath({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
  });

  it("returns undefined rather than throwing on a missing link", () => {
    expect(resolvePath({ a: null }, "a.b.c")).toBeUndefined();
    expect(resolvePath({}, "nope.nope")).toBeUndefined();
  });
});

describe("conditionsMatch", () => {
  it("matches everything when there are no conditions", () => {
    expect(conditionsMatch([], deal())).toBe(true);
  });

  it("compares a Postgres numeric string as a number", () => {
    // The bug this prevents: "45000.00" > "50000" is TRUE as a string comparison.
    expect(conditionsMatch([{ path: "payload.amount", op: "gt", value: 50000 }], deal())).toBe(
      false,
    );
    expect(conditionsMatch([{ path: "payload.amount", op: "gt", value: 40000 }], deal())).toBe(
      true,
    );
    expect(conditionsMatch([{ path: "payload.amount", op: "eq", value: 45000 }], deal())).toBe(
      true,
    );
  });

  it("refuses to guess when a side is not numeric", () => {
    expect(conditionsMatch([{ path: "payload.stage", op: "gt", value: 5 }], deal())).toBe(false);
  });

  it("reads nested jsonb", () => {
    expect(
      conditionsMatch(
        [{ path: "payload.custom_fields.industry_vertical", op: "eq", value: "healthcare" }],
        deal(),
      ),
    ).toBe(true);
  });

  it("ANDs a list", () => {
    const conditions = [
      { path: "payload.stage", op: "eq" as const, value: "lead" },
      { path: "payload.amount", op: "gte" as const, value: 45000 },
    ];
    expect(conditionsMatch(conditions, deal())).toBe(true);
    expect(conditionsMatch(conditions, deal({ stage: "won" }))).toBe(false);
  });

  it("ORs inside any_of", () => {
    const conditions = [
      {
        any_of: [
          { path: "payload.stage", op: "eq" as const, value: "won" },
          { path: "payload.stage", op: "eq" as const, value: "lead" },
        ],
      },
    ];
    expect(conditionsMatch(conditions, deal())).toBe(true);
    expect(conditionsMatch(conditions, deal({ stage: "lost" }))).toBe(false);
  });

  it("supports in / contains / exists", () => {
    expect(
      conditionsMatch([{ path: "payload.stage", op: "in", value: ["lead", "won"] }], deal()),
    ).toBe(true);
    expect(
      conditionsMatch([{ path: "payload.tags", op: "contains", value: "enterprise" }], deal()),
    ).toBe(true);
    expect(
      conditionsMatch([{ path: "payload.title", op: "contains", value: "onto" }], deal()),
    ).toBe(true);
    expect(conditionsMatch([{ path: "payload.id", op: "exists" }], deal())).toBe(true);
    expect(conditionsMatch([{ path: "payload.missing", op: "exists" }], deal())).toBe(false);
  });

  it("can match on the event name itself", () => {
    expect(
      conditionsMatch([{ path: "name", op: "eq", value: "crm.deal.created" }], deal()),
    ).toBe(true);
  });
});

describe("buildInput", () => {
  it("passes the event envelope when there is no map", () => {
    // This is what makes the common case need no mapping: it is exactly the shape
    // defineAutomation declares.
    expect(buildInput(null, deal())).toEqual({
      name: "crm.deal.created",
      payload: expect.objectContaining({ id: "d1" }),
      at: "2026-07-26T12:00:00.000Z",
    });
  });

  it("substitutes a whole-string template preserving type", () => {
    const out = buildInput({ id: "{{payload.id}}", amount: "{{payload.amount}}" }, deal({ amount: 45000 }));
    expect(out).toEqual({ id: "d1", amount: 45000 }); // number, not "45000"
  });

  it("interpolates an embedded template as text", () => {
    expect(buildInput({ note: "Deal {{payload.id}} for {{payload.title}}" }, deal())).toEqual({
      note: "Deal d1 for Contoso",
    });
  });

  it("passes literals through, so constants work", () => {
    expect(buildInput({ stage: "closed_won", flag: true, n: 3 }, deal())).toEqual({
      stage: "closed_won",
      flag: true,
      n: 3,
    });
  });

  it("maps nested objects and arrays", () => {
    expect(
      buildInput({ outer: { inner: "{{payload.id}}" }, list: ["{{payload.stage}}", "x"] }, deal()),
    ).toEqual({ outer: { inner: "d1" }, list: ["lead", "x"] });
  });

  it("renders a missing path as empty text rather than 'undefined'", () => {
    expect(buildInput({ note: "x{{payload.nope}}y" }, deal())).toEqual({ note: "xy" });
  });
});

describe("parseCondition (the CLI's --if sugar)", () => {
  it("parses comparison operators", () => {
    expect(parseCondition("payload.amount > 50000")).toEqual({
      path: "payload.amount",
      op: "gt",
      value: 50000,
    });
    expect(parseCondition("payload.amount >= 50000")).toEqual({
      path: "payload.amount",
      op: "gte",
      value: 50000,
    });
  });

  it("does not read >= as >", () => {
    expect(parseCondition("a >= 1").op).toBe("gte");
    expect(parseCondition("a <= 1").op).toBe("lte");
    expect(parseCondition("a != 1").op).toBe("ne");
  });

  it("keeps JSON types", () => {
    expect(parseCondition("payload.flag == true").value).toBe(true);
    expect(parseCondition('payload.stage == "won"').value).toBe("won");
    expect(parseCondition("payload.stage in [\"a\",\"b\"]")).toEqual({
      path: "payload.stage",
      op: "in",
      value: ["a", "b"],
    });
  });

  it("treats an unquoted word as a string", () => {
    expect(parseCondition("payload.stage == won").value).toBe("won");
  });

  it("parses word operators", () => {
    expect(parseCondition("payload.to contains support@")).toEqual({
      path: "payload.to",
      op: "contains",
      value: "support@",
    });
  });

  it("treats a bare path as an existence check", () => {
    expect(parseCondition("payload.id")).toEqual({ path: "payload.id", op: "exists" });
  });

  it("round-trips through conditionsMatch", () => {
    expect(conditionsMatch([parseCondition("payload.amount > 40000")], deal())).toBe(true);
    expect(conditionsMatch([parseCondition("payload.amount > 50000")], deal())).toBe(false);
  });
});
