/**
 * "New email arrives → a workflow runs", end to end.
 *
 * This is the extensibility claim under test, not just the email plugin. Email is a
 * trigger kind that did not exist when the automation engine was written, arrives from
 * a third party over HTTP with no session, and carries a payload shape nobody here
 * chose. If the design holds, wiring it up required no change to the engine and no new
 * concept — and this test passes using only the public SPI.
 *
 * The path exercised is the real one: an actual HTTP POST to `/hooks/:token` on a
 * mounted host, resolved to a tenant by the token alone, published through the outbox,
 * delivered by the worker, matched by a workflow, acted on by a tool.
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
import { mountHooks } from "@embody/host";
import { defineAutomation } from "@embody/plugin-sdk";
import { automationPlugin } from "@embody/automation";
import { createEmailPlugin } from "./plugin.ts";

/** What the triage action saw. */
const triaged: { subject: string; from: string }[] = [];

const helpdesk: EmbodyPlugin = {
  id: "helpdesk",
  schema: "helpdesk_test",
  dependsOn: ["core"],
  capabilities: {},
  registerMcpTools(mcp, ctx) {
    defineAutomation(mcp, ctx, {
      name: "helpdesk_triage_email",
      description: "File an inbound support email",
      permission: { action: "write", resource: "helpdesk:ticket" },
      run(event) {
        const msg = event.payload as { subject: string; from: string };
        triaged.push({ subject: msg.subject, from: msg.from });
        return { filed: msg.subject };
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

suite("inbound email triggers an automation (integration)", () => {
  let runtime: Runtime;
  let worker: RunningWorker;
  let owner: Principal;
  let token: string;

  const post = (body: unknown, headers: Record<string, string> = {}, tok = token) =>
    runtime.booted.app.request(`/hooks/${tok}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const message = (over: Record<string, unknown> = {}) => ({
    from: "Angry Customer <customer@example.com>",
    to: ["support@acme.test"],
    subject: "Cannot log in",
    text: "Help!",
    ...over,
  });

  beforeAll(async () => {
    runtime = await bootRuntime({
      config: defineConfig({
        plugins: [
          automationPlugin,
          createEmailPlugin({ provider: "generic", signatureHeader: "x-mail-signature" }),
          helpdesk,
        ],
      }),
      logger: createSilentLogger(),
    });
    // Mount the hooks route exactly as startHost does, without binding a port. The
    // /api bridge is not needed: this test drives tools through the executor and only
    // the webhook has to be reachable over HTTP.
    mountHooks(runtime.booted.app, { runtime, logger: createSilentLogger() });
    worker = startWorker({ runtime, autoStart: false, logger: createSilentLogger() });

    const rand = Math.random().toString(36).slice(2, 8);
    const [org] = await runtime.ownerDb.sql<{ id: string }[]>`
      insert into core.orgs (name, slug) values ('E', ${`e-${rand}`}) returning id`;
    const [user] = await runtime.ownerDb.sql<{ id: string }[]>`
      insert into core.users (email, name) values (${`e-${rand}@t`}, 'E') returning id`;
    await runtime.ownerDb.sql`
      insert into core.memberships (org_id, user_id, role)
      values (${org!.id}, ${user!.id}, 'owner')`;
    owner = { orgId: org!.id, userId: user!.id, roles: ["owner"] };

    const exec = makeExecutor({ runtime, principal: owner });
    const endpoint = (await exec.invoke("automation_create_endpoint", {
      name: "inbox",
      plugin: "email",
      hook: "inbound",
      secret: "shhh",
    })) as { token: string };
    token = endpoint.token;

    await exec.invoke("automation_create_workflow", {
      name: "triage-support",
      on: "email.message.received",
      conditions: [{ path: "payload.to", op: "contains", value: "support@acme.test" }],
      do: "helpdesk_triage_email",
    });
  });

  afterAll(async () => {
    await runtime?.close();
  });

  beforeEach(() => {
    triaged.length = 0;
  });

  const sign = (body: unknown) => {
    const raw = JSON.stringify(body);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    return { raw, sig: createHmac("sha256", "shhh").update(raw).digest("base64") };
  };

  it("turns an inbound email into a workflow run", async () => {
    const { raw, sig } = sign(message());
    const res = await post(raw, { "x-mail-signature": sig });
    expect(res.status).toBe(202);

    // Accepted, but nothing has run yet — it is a durable event, not a synchronous call.
    expect(triaged).toEqual([]);

    await worker.tick();
    expect(triaged).toEqual([{ subject: "Cannot log in", from: "customer@example.com" }]);
  });

  it("does not run the workflow when the condition does not hold", async () => {
    const { raw, sig } = sign(message({ to: ["sales@acme.test"] }));
    expect((await post(raw, { "x-mail-signature": sig })).status).toBe(202);
    await worker.tick();
    expect(triaged).toEqual([]);
  });

  it("rejects a request whose signature does not match, publishing nothing", async () => {
    const before = await runtime.ownerDb.sql<{ n: string }[]>`
      select count(*) as n from embody.outbox where org_id = ${owner.orgId}`;

    const res = await post(message(), { "x-mail-signature": "sha256=wrong" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid webhook signature" });

    const after = await runtime.ownerDb.sql<{ n: string }[]>`
      select count(*) as n from embody.outbox where org_id = ${owner.orgId}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("404s an unknown token without saying whether it ever existed", async () => {
    const res = await post(message(), {}, "not-a-real-token");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown endpoint" });
  });

  it("404s a revoked token", async () => {
    const exec = makeExecutor({ runtime, principal: owner });
    const created = (await exec.invoke("automation_create_endpoint", {
      name: "temp",
      plugin: "email",
      hook: "inbound",
    })) as { token: string };
    expect((await post(message(), {}, created.token)).status).toBe(202);

    await exec.invoke("automation_delete_endpoint", { name: "temp" });
    expect((await post(message(), {}, created.token)).status).toBe(404);
  });

  it("rejects an unparseable body with the reason, not a 500", async () => {
    const { sig } = sign("nonsense");
    const res = await post("nonsense", { "x-mail-signature": sig });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /not valid JSON/ as unknown as string });
  });

  it("records the run in the automation history like any other trigger", async () => {
    const { raw, sig } = sign(message({ subject: "Billing question" }));
    await post(raw, { "x-mail-signature": sig });
    await worker.tick();

    const [run] = await runtime.ownerDb.sql<{ event_name: string; status: string }[]>`
      select r.event_name, r.status from automation.runs r
      join automation.workflows w on w.id = r.workflow_id
      where r.org_id = ${owner.orgId} and w.name = 'triage-support'
      order by r.started_at desc limit 1`;
    expect(run).toMatchObject({ event_name: "email.message.received", status: "ok" });
  });
});
