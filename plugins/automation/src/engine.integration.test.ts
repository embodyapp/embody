/**
 * The end-to-end proof: a deal write causes an automation to run.
 *
 * This drives the whole chain the user actually configures — real Postgres, real
 * tenant transactions, the real durable outbox, the real worker, the real executor:
 *
 *   crm_create_deal  ->  crm.deal.created in embody.outbox (same transaction)
 *                    ->  worker fans out and delivers
 *                    ->  automation matches the row and evaluates conditions
 *                    ->  the action tool runs as the workflow's principal
 *                    ->  automation.runs records the outcome
 *
 * It also pins the two things that would make the feature unsafe rather than merely
 * broken: a workflow cannot be given roles its creator lacks, and an action refused by
 * authorization is recorded as a failure rather than silently succeeding.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { z } from "zod";
import {
  bootRuntime,
  createDb,
  createSilentLogger,
  defineConfig,
  makeExecutor,
  startWorker,
  type EmbodyPlugin,
  type Principal,
  type Runtime,
  type RunningWorker,
} from "@embody/testing";
import { defineAutomation } from "@embody/plugin-sdk";
import { crmPlugin } from "@embody/crm";
import { automationPlugin } from "./plugin.ts";

/** Every action invocation, so a test can assert what actually ran. */
const ran: { tool: string; input: unknown; roles: readonly string[] }[] = [];

/**
 * Stands in for a customer plugin. Two actions: one written with `defineAutomation`
 * (whole event in, no mapping) and one ordinary tool that needs an input map — the two
 * shapes a workflow's `--do` can point at.
 */
const acme: EmbodyPlugin = {
  id: "acme",
  schema: "acme_test",
  dependsOn: ["core"],
  capabilities: {},
  registerMcpTools(mcp, ctx) {
    defineAutomation(mcp, ctx, {
      name: "acme_review_big_deal",
      description: "Open a review when a large deal lands",
      permission: { action: "write", resource: "acme:automation" },
      run(event, req) {
        ran.push({ tool: "acme_review_big_deal", input: event, roles: req.principal.roles });
        return { reviewed: (event.payload as { id: string }).id, system: req.principal.system };
      },
    });

    mcp.tool({
      name: "acme_plain_tool",
      description: "An ordinary tool, usable as an action given an input map.",
      input: z.object({ dealId: z.string(), note: z.string() }),
      handler: (input, req) => {
        req.assert("write", "acme:automation");
        ran.push({ tool: "acme_plain_tool", input, roles: req.principal.roles });
        return { ok: true };
      },
    });

    mcp.tool({
      name: "acme_admin_only",
      description: "Requires a permission `viewer` does not have.",
      input: z.object({}).passthrough(),
      handler: (_input, req) => {
        req.assert("delete", "acme:secret");
        ran.push({ tool: "acme_admin_only", input: {}, roles: req.principal.roles });
        return { ok: true };
      },
    });
  },
};

async function reachable(): Promise<boolean> {
  try {
    const h = createDb(
      process.env.DATABASE_URL ?? "postgres://embody:embody@localhost:5432/embody",
      { max: 1 },
    );
    await h.sql`select 1`;
    await h.close();
    return true;
  } catch {
    return false;
  }
}

const suite = (await reachable()) ? describe : describe.skip;

suite("automation engine (integration)", () => {
  let runtime: Runtime;
  let worker: RunningWorker;
  let owner: Principal;

  const as = (p: Principal) => makeExecutor({ runtime, principal: p });
  const invoke = (tool: string, input: unknown) => as(owner).invoke(tool, input);

  /** Publish a deal and let the worker deliver whatever it caused. */
  const createDeal = async (amount: number, title = "Test deal") => {
    const deal = (await invoke("crm_create_deal", { title, amount })) as { id: string };
    await worker.tick();
    return deal;
  };

  const runs = () =>
    runtime.ownerDb.sql<{ status: string; error: string | null; event_name: string; name: string }[]>`
      select r.status, r.error, r.event_name, w.name
      from automation.runs r join automation.workflows w on w.id = r.workflow_id
      where r.org_id = ${owner.orgId} order by r.started_at
    `;

  beforeAll(async () => {
    runtime = await bootRuntime({
      config: defineConfig({ plugins: [crmPlugin, automationPlugin, acme] }),
      logger: createSilentLogger(),
    });
    worker = startWorker({ runtime, autoStart: false, logger: createSilentLogger() });

    const rand = Math.random().toString(36).slice(2, 8);
    const [org] = await runtime.ownerDb.sql<{ id: string }[]>`
      insert into core.orgs (name, slug) values ('A', ${`a-${rand}`}) returning id`;
    const [user] = await runtime.ownerDb.sql<{ id: string }[]>`
      insert into core.users (email, name) values (${`a-${rand}@t`}, 'A') returning id`;
    await runtime.ownerDb.sql`
      insert into core.memberships (org_id, user_id, role)
      values (${org!.id}, ${user!.id}, 'owner')`;
    owner = { orgId: org!.id, userId: user!.id, roles: ["owner"] };
  });

  afterAll(async () => {
    await runtime?.close();
  });

  beforeEach(async () => {
    ran.length = 0;
    await runtime.ownerDb.sql`delete from automation.workflows where org_id = ${owner.orgId}`;
    await runtime.ownerDb.sql`delete from embody.outbox where org_id = ${owner.orgId}`;
  });

  it("runs the action when the trigger fires and the conditions hold", async () => {
    await invoke("automation_create_workflow", {
      name: "big-deal-review",
      on: "crm.deal.created",
      conditions: [{ path: "payload.amount", op: "gt", value: 50000 }],
      do: "acme_review_big_deal",
    });

    const deal = await createDeal(84000, "Brightpath — 300 seats");

    expect(ran).toHaveLength(1);
    expect(ran[0]!.tool).toBe("acme_review_big_deal");
    // No input map: the action received the whole event envelope.
    expect((ran[0]!.input as { payload: { id: string } }).payload.id).toBe(deal.id);
    expect(await runs()).toEqual([
      { status: "ok", error: null, event_name: "crm.deal.created", name: "big-deal-review" },
    ]);
  });

  it("does not run when the conditions do not hold, and logs nothing", async () => {
    await invoke("automation_create_workflow", {
      name: "big-deal-review",
      on: "crm.deal.created",
      conditions: [{ path: "payload.amount", op: "gt", value: 50000 }],
      do: "acme_review_big_deal",
    });

    await createDeal(1000, "Small fry");

    expect(ran).toEqual([]);
    // A run log full of "did not match" is a run log nobody reads.
    expect(await runs()).toEqual([]);
  });

  it("does not run when the event name does not match", async () => {
    await invoke("automation_create_workflow", {
      name: "on-update-only",
      on: "crm.deal.updated",
      do: "acme_review_big_deal",
    });
    await createDeal(90000);
    expect(ran).toEqual([]);
  });

  it("runs the action as the workflow's roles, flagged as a system actor", async () => {
    await invoke("automation_create_workflow", {
      name: "as-member",
      on: "crm.deal.created",
      do: "acme_review_big_deal",
      runAsRoles: ["member"],
    });
    await createDeal(10);

    expect(ran[0]!.roles).toEqual(["member"]);
    // The action itself can see it was not a person who triggered it.
    const [row] = await runtime.ownerDb.sql<{ result: { system: boolean } }[]>`
      select result from automation.runs where org_id = ${owner.orgId}`;
    expect(row!.result.system).toBe(true);
  });

  it("drives an ordinary tool through an input map", async () => {
    await invoke("automation_create_workflow", {
      name: "map-it",
      on: "crm.deal.created",
      do: "acme_plain_tool",
      inputMap: { dealId: "{{payload.id}}", note: "New: {{payload.title}}" },
    });
    const deal = await createDeal(5, "Contoso");

    expect(ran[0]!.input).toEqual({ dealId: deal.id, note: "New: Contoso" });
  });

  it("records a failed action instead of losing it", async () => {
    await invoke("automation_create_workflow", {
      name: "will-fail",
      on: "crm.deal.created",
      do: "acme_admin_only",
      inputMap: {},
      runAsRoles: ["member"], // lacks delete on acme:secret
    });
    await createDeal(5);

    expect(ran).toEqual([]);
    const [row] = await runs();
    expect(row!.status).toBe("error");
    expect(row!.error).toMatch(/Not authorized/);
  });

  it("skips a disabled workflow and resumes when re-enabled", async () => {
    await invoke("automation_create_workflow", {
      name: "toggle-me",
      on: "crm.deal.created",
      do: "acme_review_big_deal",
    });
    await invoke("automation_set_enabled", { name: "toggle-me", enabled: false });
    await createDeal(5);
    expect(ran).toEqual([]);

    await invoke("automation_set_enabled", { name: "toggle-me", enabled: true });
    await createDeal(5);
    expect(ran).toHaveLength(1);
  });

  it("refuses a workflow that would run with roles the creator does not hold", async () => {
    const member = as({ ...owner, roles: ["member"] });
    await expect(
      member.invoke("automation_create_workflow", {
        name: "escalate",
        on: "crm.deal.created",
        do: "acme_review_big_deal",
        runAsRoles: ["owner"],
      }),
    ).rejects.toThrow(/do not hold/);
  });

  it("rejects an unknown action tool when the workflow is created, not when it fires", async () => {
    await expect(
      invoke("automation_create_workflow", {
        name: "typo",
        on: "crm.deal.created",
        do: "acme_reveiw_big_deal",
      }),
    ).rejects.toThrow(/No registered tool named/);
  });

  it("isolates workflows by tenant", async () => {
    await invoke("automation_create_workflow", {
      name: "mine",
      on: "crm.deal.created",
      do: "acme_review_big_deal",
    });

    const rand = Math.random().toString(36).slice(2, 8);
    const [other] = await runtime.ownerDb.sql<{ id: string }[]>`
      insert into core.orgs (name, slug) values ('B', ${`b-${rand}`}) returning id`;
    const stranger = as({ orgId: other!.id, userId: "", roles: ["owner"] });

    expect(await stranger.invoke("automation_list_workflows", {})).toEqual([]);

    // And the other org's deal must not trigger this org's workflow.
    await stranger.invoke("crm_create_deal", { title: "Theirs", amount: 99999 });
    await worker.tick();
    expect(ran).toEqual([]);
  });

  it("tests a workflow against a sample event without waiting for the trigger", async () => {
    await invoke("automation_create_workflow", {
      name: "dry-run-me",
      on: "crm.deal.created",
      conditions: [{ path: "payload.amount", op: "gt", value: 50000 }],
      do: "acme_review_big_deal",
    });

    expect(
      await invoke("automation_test", {
        name: "dry-run-me",
        event: "crm.deal.created",
        payload: { id: "sample", amount: 10 },
      }),
    ).toEqual({ matched: false, reason: "conditions did not match" });

    const hit = (await invoke("automation_test", {
      name: "dry-run-me",
      event: "crm.deal.created",
      payload: { id: "sample", amount: 90000 },
    })) as { matched: boolean; result: { reviewed: string } };
    expect(hit.matched).toBe(true);
    expect(hit.result.reviewed).toBe("sample");
  });
});
