import { describe, it, expect } from "vitest";
import { HookRegistry, createSilentLogger, type KernelContext } from "@embody/testing";
import { b2bSaasPlugin } from "embody-plugin-b2b-saas";
import { acmeCrmPlugin, hipaaVetoReason } from "./plugin.ts";

const ctx = (pluginId: string): KernelContext =>
  ({
    pluginId,
    logger: createSilentLogger(),
    services: {} as KernelContext["services"],
    hooks: {} as KernelContext["hooks"],
    events: {} as KernelContext["events"],
  }) as KernelContext;

const healthcareDeal = (over: Record<string, unknown> = {}) => ({
  title: "Brightpath Health — 300 Clinical Seats",
  stage: "closed_won",
  amount: 84000,
  custom_fields: { industry_vertical: "healthcare", security_review_passed: true, ...over },
});

describe("hipaaVetoReason (the rule in isolation)", () => {
  it("vetoes closing a healthcare deal with no HIPAA review", () => {
    expect(hipaaVetoReason(healthcareDeal())).toMatch(/HIPAA review/);
  });

  it("allows it once the review is recorded", () => {
    expect(hipaaVetoReason(healthcareDeal({ hipaa_review_passed: true }))).toBeNull();
  });

  it("ignores non-healthcare verticals", () => {
    expect(hipaaVetoReason(healthcareDeal({ industry_vertical: "manufacturing" }))).toBeNull();
  });

  it("only gates the closed_won transition", () => {
    expect(hipaaVetoReason({ ...healthcareDeal(), stage: "negotiation" })).toBeNull();
  });
});

describe("custom-crm composes with first-party plugins", () => {
  /** Register both plugins' hooks on one registry, exactly as the kernel does at boot. */
  const registry = () => {
    const reg = new HookRegistry();
    const allowed = ["crm.deal.beforeUpdate"];
    b2bSaasPlugin.registerHooks!(reg.scopedFor("b2b-saas", allowed), ctx("b2b-saas"));
    acmeCrmPlugin.registerHooks!(reg.scopedFor("custom-acme-crm", allowed), ctx("custom-acme-crm"));
    return reg;
  };

  it("adds the HIPAA veto without disabling the built-in InfoSec veto", async () => {
    const reg = registry();
    // Fails b2b-saas' rule (>$50k, no security review) — the first-party veto still wins.
    await expect(
      reg.run(
        "crm.deal.beforeUpdate",
        healthcareDeal({ security_review_passed: false, hipaa_review_passed: true }),
        ctx("test"),
      ),
    ).rejects.toThrow(/Security Review/i);
  });

  it("vetoes on the custom rule when the first-party rule passes", async () => {
    const reg = registry();
    await expect(
      reg.run("crm.deal.beforeUpdate", healthcareDeal(), ctx("test")),
    ).rejects.toThrow(/HIPAA review/);
  });

  it("lets the deal through when both rules are satisfied", async () => {
    const reg = registry();
    const payload = healthcareDeal({ hipaa_review_passed: true });
    await expect(reg.run("crm.deal.beforeUpdate", payload, ctx("test"))).resolves.toBeDefined();
  });
});

describe("plugin manifest", () => {
  it("declares only what it touches, and owns its own schema", () => {
    expect(acmeCrmPlugin.schema).toBe("custom_acme");
    expect(acmeCrmPlugin.dependsOn).toEqual(["core", "crm"]);
    expect(acmeCrmPlugin.capabilities.hooks).toEqual(["crm.deal.beforeUpdate"]);
    expect(acmeCrmPlugin.capabilities.services?.consume).toContain("core.registry");
  });

  it("cannot register a hook it did not declare (capability sandbox)", () => {
    const reg = new HookRegistry();
    const scoped = reg.scopedFor("custom-acme-crm", acmeCrmPlugin.capabilities.hooks ?? []);
    expect(() => scoped.register("crm.deal.beforeCreate", () => {})).toThrow(/undeclared hook/);
  });
});
