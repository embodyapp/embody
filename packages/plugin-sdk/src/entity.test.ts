/**
 * Unit tests for the parts of defineEntity that need no database: the patch-merge
 * rule (the thing that makes a customer's veto see fields the caller never sent) and
 * the capability check on hook invocation.
 *
 * The full write path — veto rolls back a real transaction — is covered by
 * entity.integration.test.ts against Postgres.
 */
import { describe, it, expect } from "vitest";
import { createSilentLogger, HookRegistry, InMemoryEventBus } from "@embody/kernel";
import type { KernelContext, CapabilityManifest } from "@embody/kernel";
import { defineEntity, mergePatch } from "./entity.ts";

function fakeCtx(capabilities: CapabilityManifest): KernelContext {
  return {
    pluginId: "test",
    logger: createSilentLogger(),
    services: { get: () => undefined } as unknown as KernelContext["services"],
    hooks: new HookRegistry().scopedFor("test", capabilities.hooks ?? []),
    events: new InMemoryEventBus(),
    capabilities,
  };
}

describe("mergePatch", () => {
  it("overlays scalar fields", () => {
    expect(mergePatch({ stage: "lead", title: "A" }, { stage: "won" })).toEqual({
      stage: "won",
      title: "A",
    });
  });

  it("keeps fields the caller did not send", () => {
    // The legacy update route dropped these; a rule keyed off industry_vertical
    // then never fired and the write wrongly succeeded.
    const current = { custom_fields: { industry_vertical: "healthcare" } };
    const merged = mergePatch(current, { stage: "closed_won" }, ["custom_fields"]);
    expect(merged.custom_fields).toEqual({ industry_vertical: "healthcare" });
  });

  it("merges jsonb columns key-by-key instead of replacing them", () => {
    const current = { custom_fields: { industry_vertical: "healthcare", arr: 84000 } };
    const merged = mergePatch(
      current,
      { custom_fields: { hipaa_review_passed: true } },
      ["custom_fields"],
    );
    expect(merged.custom_fields).toEqual({
      industry_vertical: "healthcare",
      arr: 84000,
      hipaa_review_passed: true,
    });
  });

  it("replaces a jsonb column when it is not declared as jsonb", () => {
    const merged = mergePatch({ meta: { a: 1 } }, { meta: { b: 2 } });
    expect(merged.meta).toEqual({ b: 2 });
  });

  it("does not merge arrays", () => {
    const merged = mergePatch({ tags: ["a"] }, { tags: ["b"] }, ["tags"]);
    expect(merged.tags).toEqual(["b"]);
  });
});

describe("defineEntity capability enforcement", () => {
  it("refuses an entity type the plugin did not declare", () => {
    expect(() =>
      defineEntity(fakeCtx({ entities: ["crm.deal"] }), {
        type: "billing.invoice",
        schema: "billing",
        table: "invoices",
        columns: ["amount"],
        label: () => "x",
      }),
    ).toThrow(/without declaring it/);
  });

  it("accepts a declared entity type", () => {
    const repo = defineEntity(fakeCtx({ entities: ["crm.deal"] }), {
      type: "crm.deal",
      schema: "crm",
      table: "deals",
      columns: ["title"],
      label: () => "x",
      register: false,
    });
    expect(repo.type).toBe("crm.deal");
  });
});
