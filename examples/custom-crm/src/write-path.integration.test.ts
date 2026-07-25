/**
 * The Decision D8 proof, end to end.
 *
 * `plugin.test.ts` checks Acme's rule in isolation and `boot.integration.test.ts`
 * checks it composes in a booted kernel. Neither touches a database, so neither can
 * show the thing a buyer actually cares about: that a rule a *customer* wrote, in a
 * directory the vendor never edits, stops a real write to Postgres.
 *
 * This drives `crm_update_deal` through the same executor an AI agent, the CLI, and
 * REST all use, and asserts the row on disk is unchanged after each rejection — and
 * that Acme's gate and the first-party b2b-saas InfoSec gate stack, neither plugin
 * knowing the other exists.
 *
 * Requires the docker-compose Postgres. Skips cleanly if unreachable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootRuntime,
  createSilentLogger,
  databaseReachable,
  defineConfig,
  makeExecutor,
  type Principal,
  type Runtime,
} from "@embody/testing";
import { crmPlugin } from "@embody/crm";
import { b2bSaasPlugin } from "embody-plugin-b2b-saas";
import { acmeCrmPlugin } from "./plugin.ts";

interface DealRow {
  id: string;
  stage: string;
  custom_fields: Record<string, unknown>;
}

const canRun = await databaseReachable();
const suite = canRun ? describe : describe.skip;

suite("acme-crm gates a real write (integration)", () => {
  let runtime: Runtime;
  let principal: Principal;
  let dealId: string;

  const invoke = (tool: string, input: unknown) =>
    makeExecutor({ runtime, principal }).invoke(tool, input);

  /** Ground truth, read as owner so RLS cannot mask a partial write. */
  const onDisk = async (): Promise<DealRow> => {
    const [row] = await runtime.ownerDb.sql<DealRow[]>`
      select id, stage, custom_fields from crm.deals where id = ${dealId}
    `;
    return row!;
  };

  beforeAll(async () => {
    runtime = await bootRuntime({
      // Exactly what a customer's deployment enables: catalog apps plus their own.
      config: defineConfig({ plugins: [crmPlugin, b2bSaasPlugin, acmeCrmPlugin] }),
      logger: createSilentLogger(),
    });

    const rand = Math.random().toString(36).slice(2, 8);
    const [org] = await runtime.ownerDb
      .sql<{ id: string }[]>`insert into core.orgs (name, slug) values ('Acme', ${`acme-${rand}`}) returning id`;
    const [user] = await runtime.ownerDb
      .sql<{ id: string }[]>`insert into core.users (email, name) values (${`u-${rand}@acme`}, 'AE') returning id`;
    await runtime.ownerDb
      .sql`insert into core.memberships (org_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
    principal = { orgId: org!.id, userId: user!.id, roles: ["owner"] };

    const deal = (await invoke("crm_create_deal", {
      title: "Brightpath Health — 300 Clinical Seats",
      amount: 84000,
      customFields: { industry_vertical: "healthcare", security_review_passed: true },
    })) as DealRow;
    dealId = deal.id;
  });

  afterAll(async () => {
    await runtime?.close();
  });

  it("blocks the close and leaves the row untouched (Acme's HIPAA gate)", async () => {
    await expect(
      invoke("crm_update_deal", { id: dealId, stage: "closed_won" }),
    ).rejects.toThrow(/HIPAA review/);
    expect((await onDisk()).stage).toBe("lead");
  });

  it("clears the gate via the plugin's own tool, then allows the close", async () => {
    await invoke("acme_flag_hipaa", { dealId, reviewer: "Nora Adeyemi" });
    await invoke("crm_update_deal", { id: dealId, stage: "closed_won" });
    expect((await onDisk()).stage).toBe("closed_won");
  });

  it("records the review in the plugin's own schema and links it to the deal", async () => {
    const reviews = (await invoke("acme_list_hipaa_reviews", {})) as {
      dealId: string;
      reviewer: string;
    }[];
    expect(reviews.some((r) => r.dealId === dealId && r.reviewer === "Nora Adeyemi")).toBe(
      true,
    );

    const [edge] = await runtime.ownerDb.sql<{ kind: string }[]>`
      select r.kind from core.entity_relationships r
        join core.entities e on e.id = r.to_entity_id
       where e.source_table = 'deals' and e.source_id = ${dealId}
         and r.kind = 'hipaa_review_for_deal'
    `;
    expect(edge?.kind).toBe("hipaa_review_for_deal");
  });

  it("stacks with the first-party InfoSec gate — neither plugin knows the other", async () => {
    // Revoke the security review on a deal that already passed HIPAA. b2b-saas must
    // still refuse, and the row must stay where it was.
    const stacked = (await invoke("crm_create_deal", {
      title: "Northwind Clinics — Renewal",
      amount: 120000,
      customFields: {
        industry_vertical: "healthcare",
        security_review_passed: false,
        hipaa_review_passed: true,
      },
    })) as DealRow;

    await expect(
      invoke("crm_update_deal", { id: stacked.id, stage: "closed_won" }),
    ).rejects.toThrow(/Security Review/i);

    const [row] = await runtime.ownerDb.sql<DealRow[]>`
      select stage from crm.deals where id = ${stacked.id}
    `;
    expect(row!.stage).toBe("lead");
  });
});
