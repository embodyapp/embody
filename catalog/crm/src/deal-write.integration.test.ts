/**
 * The proof that a veto is real.
 *
 * A rule registered by *another* plugin must be able to stop a genuine database
 * write — not merely be observed firing in a unit test. This boots a real kernel
 * against a real Postgres, drives `crm_update_deal` through the same executor an
 * agent/CLI/REST call uses, and asserts that after a rejected update the row on disk
 * is UNCHANGED (the transaction rolled back).
 *
 * It also pins the two properties that made the old demo route lie:
 *   - the hook sees fields the caller never sent (the full merged row), and
 *   - patching one jsonb key does not drop the others.
 *
 * Requires the docker-compose Postgres. Skips cleanly if unreachable.
 * Run: `pnpm --filter @embody/crm exec vitest run`
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSilentLogger, type EmbodyPlugin, type Principal } from "@embody/kernel";
import { defineConfig, bootRuntime, makeExecutor, type Runtime } from "@embody/host";
import { createDb } from "@embody/db";
import { crmPlugin, type DealRow } from "./plugin.ts";

const OWNER_URL =
  process.env.DATABASE_URL ?? "postgres://embody:embody@localhost:5432/embody";

async function reachable(url: string): Promise<boolean> {
  try {
    const h = createDb(url, { max: 1 });
    await h.sql`select 1`;
    await h.close();
    return true;
  } catch {
    return false;
  }
}

/** Payloads the veto plugin actually observed, so we can assert what hooks are shown. */
const seen: Record<string, unknown>[] = [];

/**
 * Stands in for a customer's `custom/` plugin: it knows nothing about crm's internals
 * and only registers a rule. Healthcare deals may not close without a review flag.
 */
const complianceGate: EmbodyPlugin = {
  id: "test-compliance",
  schema: "test_compliance",
  dependsOn: ["core", "crm"],
  capabilities: { hooks: ["crm.deal.beforeUpdate"] },
  registerHooks(hooks) {
    hooks.register("crm.deal.beforeUpdate", (payload: Record<string, unknown>) => {
      seen.push(payload);
      const cf = (payload.custom_fields ?? {}) as Record<string, unknown>;
      if (
        payload.stage === "closed_won" &&
        cf.industry_vertical === "healthcare" &&
        cf.review_passed !== true
      ) {
        throw new Error("Compliance: healthcare deals require a completed review.");
      }
    });
  },
};

const canRun = await reachable(OWNER_URL);
const suite = canRun ? describe : describe.skip;

suite("crm deal writes run the hook chain (integration)", () => {
  let runtime: Runtime;
  let principal: Principal;
  let dealId: string;

  const invoke = (tool: string, input: unknown) =>
    makeExecutor({ runtime, principal }).invoke(tool, input);

  /** Read the row with the owner role, bypassing RLS — the ground truth on disk. */
  const onDisk = async (): Promise<DealRow> => {
    const [row] = await runtime.ownerDb.sql<DealRow[]>`
      select * from crm.deals where id = ${dealId}
    `;
    return row!;
  };

  beforeAll(async () => {
    runtime = await bootRuntime({
      config: defineConfig({ plugins: [crmPlugin, complianceGate] }),
      logger: createSilentLogger(),
    });

    const rand = Math.random().toString(36).slice(2, 8);
    const [org] = await runtime.ownerDb
      .sql<{ id: string }[]>`insert into core.orgs (name, slug) values ('T', ${`t-${rand}`}) returning id`;
    const [user] = await runtime.ownerDb
      .sql<{ id: string }[]>`insert into core.users (email, name) values (${`u-${rand}@t`}, 'T') returning id`;
    await runtime.ownerDb
      .sql`insert into core.memberships (org_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
    principal = { orgId: org!.id, userId: user!.id, roles: ["owner"] };

    const deal = (await invoke("crm_create_deal", {
      title: "Brightpath Health — 300 seats",
      amount: 84000,
      customFields: { industry_vertical: "healthcare", arr: 84000 },
    })) as DealRow;
    dealId = deal.id;
  });

  afterAll(async () => {
    await runtime?.close();
  });

  it("creates through the SDK and persists the row", async () => {
    const row = await onDisk();
    expect(row.stage).toBe("lead");
    expect(row.custom_fields).toEqual({ industry_vertical: "healthcare", arr: 84000 });
  });

  it("shows the hook the WHOLE row, including fields the caller did not send", async () => {
    seen.length = 0;
    await expect(
      invoke("crm_update_deal", { id: dealId, stage: "closed_won" }),
    ).rejects.toThrow();
    // The caller sent only `stage`; the rule still saw the vertical it keys off.
    expect(seen.at(-1)?.custom_fields).toMatchObject({ industry_vertical: "healthcare" });
  });

  it("ROLLS BACK the write when a hook vetoes — the row on disk is untouched", async () => {
    await expect(
      invoke("crm_update_deal", { id: dealId, stage: "closed_won" }),
    ).rejects.toThrow(/healthcare deals require a completed review/);

    const row = await onDisk();
    expect(row.stage).toBe("lead"); // NOT closed_won
  });

  it("merges jsonb keys instead of replacing them", async () => {
    await invoke("crm_update_deal", {
      id: dealId,
      customFields: { review_passed: true },
    });
    const row = await onDisk();
    expect(row.custom_fields).toEqual({
      industry_vertical: "healthcare",
      arr: 84000,
      review_passed: true,
    });
  });

  it("allows the write once the rule is satisfied", async () => {
    await invoke("crm_update_deal", { id: dealId, stage: "closed_won" });
    const row = await onDisk();
    expect(row.stage).toBe("closed_won");
  });

  it("denies the write to a principal without the role (RBAC, same path)", async () => {
    const viewer = makeExecutor({
      runtime,
      principal: { ...principal, roles: ["viewer"] },
    });
    await expect(
      viewer.invoke("crm_update_deal", { id: dealId, stage: "lead" }),
    ).rejects.toThrow(/Not authorized to write crm:deal/);
  });
});
