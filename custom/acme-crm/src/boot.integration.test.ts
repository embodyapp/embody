/**
 * Boots a REAL kernel with core + crm + b2b-saas + custom/acme-crm and drives the hook
 * chain through the booted registry. This proves the customization end-to-end through the
 * genuine registration path — topo-sort, capability-manifest enforcement, and cross-plugin
 * hook composition — rather than a hand-assembled registry. No database required.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { EmbodyKernel, createSilentLogger } from "@embody/kernel";
import type { BootedKernel, KernelContext } from "@embody/kernel";
import { corePlugin } from "@embody/core";
import { crmPlugin } from "@embody/crm";
import { b2bSaasPlugin } from "@embody/b2b-saas";
import { acmeCrmPlugin } from "./plugin.ts";

const runCtx = { pluginId: "test", logger: createSilentLogger() } as unknown as KernelContext;

const deal = (customFields: Record<string, unknown>) => ({
  title: "Brightpath Health — 300 Clinical Seats",
  stage: "closed_won",
  amount: 84000,
  custom_fields: customFields,
});

describe("custom/acme-crm in a booted kernel", () => {
  let booted: BootedKernel;

  beforeAll(async () => {
    const kernel = new EmbodyKernel({
      logger: createSilentLogger(),
      // Migrations are exercised for real against Postgres by the host; skip here.
      runMigrations: async () => {},
    });
    // Deliberately registered out of order — the kernel topo-sorts on dependsOn.
    for (const p of [acmeCrmPlugin, b2bSaasPlugin, crmPlugin, corePlugin]) kernel.register(p);
    booted = await kernel.boot();
  });

  it("loads after its dependencies and contributes its tools + command", () => {
    const ids = booted.plugins.map((p) => p.id);
    expect(ids).toContain("custom-acme-crm");
    expect(ids.indexOf("custom-acme-crm")).toBeGreaterThan(ids.indexOf("crm"));
    expect(ids.indexOf("custom-acme-crm")).toBeGreaterThan(ids.indexOf("core"));

    expect(booted.mcp.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["acme_flag_hipaa", "acme_list_hipaa_reviews"]),
    );
    expect(booted.cli.commands.map((c) => c.name)).toContain("acme:hipaa");
  });

  it("VETOES closing a healthcare deal with no HIPAA review", async () => {
    await expect(
      booted.hooks.run(
        "crm.deal.beforeUpdate",
        deal({ industry_vertical: "healthcare", security_review_passed: true }),
        runCtx,
      ),
    ).rejects.toThrow(/HIPAA review/);
  });

  it("ALLOWS the close once the review is recorded", async () => {
    await expect(
      booted.hooks.run(
        "crm.deal.beforeUpdate",
        deal({
          industry_vertical: "healthcare",
          security_review_passed: true,
          hipaa_review_passed: true,
        }),
        runCtx,
      ),
    ).resolves.toBeDefined();
  });

  it("leaves the first-party InfoSec veto intact (both rules apply independently)", async () => {
    await expect(
      booted.hooks.run(
        "crm.deal.beforeUpdate",
        deal({
          industry_vertical: "healthcare",
          security_review_passed: false,
          hipaa_review_passed: true,
        }),
        runCtx,
      ),
    ).rejects.toThrow(/Security Review/i);
  });

  it("does not affect non-healthcare deals", async () => {
    await expect(
      booted.hooks.run(
        "crm.deal.beforeUpdate",
        deal({ industry_vertical: "manufacturing", security_review_passed: true }),
        runCtx,
      ),
    ).resolves.toBeDefined();
  });
});
