/**
 * The tool bridge against a real config and a real database.
 *
 * `packages/host/src/api.test.ts` proves the request path with a fake runtime — fast,
 * but it can only assert what a fake was told to throw. The properties a UI actually
 * depends on cannot be faked, because they are enforced by Postgres and by the plugins
 * a config enables:
 *
 *   - RBAC survives the hop: a viewer's write is refused over HTTP, not just over MCP;
 *   - RLS survives the hop: another org's row is indistinguishable from a missing one;
 *   - a domain veto survives the hop: b2b-saas's InfoSec rule arrives as 409 with its
 *     own message, and the row on disk is unchanged.
 *
 * The config here is built inline and deliberately OMITS this app's own plugin, which
 * is the point of the last two cases: what a deployment exposes follows from its
 * plugins list and nothing else. The same tools that appear when `embody.config.ts`
 * lists `acmeCrmPlugin` are absent here, in the same package, from the same source.
 *
 * Requests go through `booted.app.request(...)` — the real Hono app, no socket and no
 * port. Requires the docker-compose Postgres; skips cleanly if unreachable.
 *
 * Run: `pnpm --filter custom-crm exec vitest run`
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  bootRuntime,
  createDevIdentity,
  createSilentLogger,
  databaseReachable,
  defineConfig,
  mountApi,
  type Runtime,
} from "@embody/testing";
import { crmPlugin } from "@embody/crm";
import { b2bSaasPlugin } from "embody-plugin-b2b-saas";
import { ecomFulfillmentPlugin } from "embody-plugin-ecom-fulfillment";

/** Published plugins only — this app's own `acmeCrmPlugin` is intentionally absent. */
const config = defineConfig({
  plugins: [crmPlugin, b2bSaasPlugin, ecomFulfillmentPlugin],
});

interface Ids {
  orgId: string;
  userId: string;
}

const canRun = await databaseReachable();
const suite = canRun ? describe : describe.skip;

suite("the /api tool bridge (integration)", () => {
  let runtime: Runtime;
  let alpha: Ids;
  let beta: Ids;
  let alphaDealId: string;

  /** Call a tool as a principal, exactly as a browser would (minus the cookie). */
  const call = (tool: string, input: unknown, who: Ids, roles = "owner") =>
    runtime.booted.app.request(`/api/tools/${tool}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-embody-org": who.orgId,
        "x-embody-user": who.userId,
        "x-embody-roles": roles,
      },
      body: JSON.stringify({ input }),
    });

  const seedOrg = async (name: string): Promise<Ids> => {
    const rand = Math.random().toString(36).slice(2, 8);
    const [org] = await runtime.ownerDb.sql<{ id: string }[]>`
      insert into core.orgs (name, slug) values (${name}, ${`${name}-${rand}`}) returning id`;
    const [user] = await runtime.ownerDb.sql<{ id: string }[]>`
      insert into core.users (email, name) values (${`u-${rand}@${name}`}, 'AE') returning id`;
    await runtime.ownerDb.sql`
      insert into core.memberships (org_id, user_id, role)
      values (${org!.id}, ${user!.id}, 'owner')`;
    return { orgId: org!.id, userId: user!.id };
  };

  beforeAll(async () => {
    runtime = await bootRuntime({ config, logger: createSilentLogger() });
    // The dev gate is passed explicitly: these tests must not depend on the ambient
    // EMBODY_DEV_IDENTITY of whoever runs them.
    mountApi(runtime.booted.app, {
      runtime,
      logger: createSilentLogger(),
      identity: createDevIdentity({
        allowUnauthenticatedIdentity: true,
        sql: runtime.ownerDb.sql,
      }),
    });

    alpha = await seedOrg("alpha");
    beta = await seedOrg("beta");

    const created = await call(
      "crm_create_deal",
      {
        title: "Brightpath Health — 300 Clinical Seats",
        amount: 84000,
        customFields: { industry_vertical: "healthcare" },
      },
      alpha,
    );
    const body = (await created.json()) as { result: { id: string } };
    alphaDealId = body.result.id;
  });

  afterAll(async () => {
    await runtime?.close();
  });

  it("creates and reads a deal over HTTP", async () => {
    const res = await call("crm_query_deals", { limit: 50 }, alpha);
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { id: string }[] };
    expect(result.map((d) => d.id)).toContain(alphaDealId);
  });

  it("scopes reads to the caller's org (RLS, over HTTP)", async () => {
    const res = await call("crm_query_deals", { limit: 50 }, beta);
    const { result } = (await res.json()) as { result: { id: string }[] };
    expect(result.map((d) => d.id)).not.toContain(alphaDealId);
  });

  it("refuses a viewer's write with 403 denied", async () => {
    const res = await call("crm_create_deal", { title: "Sneaky" }, alpha, "viewer");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { kind: string; message: string } };
    expect(body.error.kind).toBe("denied");
    expect(body.error.message).toMatch(/Not authorized to write crm:deal/);
  });

  it("still lets a viewer read", async () => {
    expect((await call("crm_query_deals", {}, alpha, "viewer")).status).toBe(200);
  });

  it("reports another org's row as not_found, never as forbidden", async () => {
    // The distinction matters: 403 would confirm the id exists. RLS hides the row, and
    // the taxonomy keeps it hidden.
    const res = await call("crm_update_deal", { id: alphaDealId, stage: "proposal" }, beta);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { kind: string } }).toMatchObject({
      error: { kind: "not_found" },
    });
  });

  it("surfaces the InfoSec veto as 409 and leaves the row untouched", async () => {
    const res = await call("crm_update_deal", { id: alphaDealId, stage: "closed_won" }, alpha);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { kind: string; message: string; details: { plugin: string } };
    };
    expect(body.error.kind).toBe("veto");
    // The plugin's own words reach the browser, and it names who refused.
    expect(body.error.message).toMatch(/Security Review/i);
    expect(body.error.details.plugin).toBe("b2b-saas");

    const [row] = await runtime.ownerDb.sql<{ stage: string }[]>`
      select stage from crm.deals where id = ${alphaDealId}`;
    expect(row!.stage).toBe("lead");
  });

  it("allows the close once the rule is satisfied", async () => {
    await call(
      "crm_update_deal",
      { id: alphaDealId, customFields: { security_review_passed: true } },
      alpha,
    );
    const res = await call("crm_update_deal", { id: alphaDealId, stage: "closed_won" }, alpha);
    expect(res.status).toBe(200);

    const [row] = await runtime.ownerDb.sql<{
      stage: string;
      custom_fields: Record<string, unknown>;
    }[]>`select stage, custom_fields from crm.deals where id = ${alphaDealId}`;
    expect(row!.stage).toBe("closed_won");
    // jsonb merged rather than replaced: the vertical the caller never re-sent survives.
    expect(row!.custom_fields.industry_vertical).toBe("healthcare");
  });

  it("404s a tool whose plugin this config does not list", async () => {
    // acme_flag_hipaa is defined in this very package, but the config above omits
    // acmeCrmPlugin — so the tool does not exist. Exposure follows the plugins list.
    const res = await call("acme_flag_hipaa", { dealId: alphaDealId }, alpha);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { kind: string } }).toMatchObject({
      error: { kind: "unknown_tool" },
    });
  });

  it("refuses an anonymous caller", async () => {
    const res = await runtime.booted.app.request("/api/tools/crm_query_deals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("publishes the enabled plugins' tools, with real input schemas", async () => {
    const res = await runtime.booted.app.request("/api/tools", {
      headers: { "x-embody-org": alpha.orgId, "x-embody-user": alpha.userId },
    });
    const { tools } = (await res.json()) as {
      tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[];
    };
    const names = tools.map((t) => t.name);
    // Two independent plugins contribute, with no bridge change of any kind.
    expect(names).toContain("crm_query_deals");
    expect(names).toContain("b2b_calculate_arr_discount");
    expect(names).not.toContain("acme_flag_hipaa");
    expect(
      tools.find((t) => t.name === "crm_update_deal")?.inputSchema.properties,
    ).toHaveProperty("stage");
  });

  it("signs in with a seeded membership and answers /api/me", async () => {
    const login = await runtime.booted.app.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: alpha.orgId, userId: alpha.userId, roles: ["viewer"] }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";

    const me = await runtime.booted.app.request("/api/me", { headers: { cookie } });
    expect(await me.json()).toMatchObject({
      principal: { orgId: alpha.orgId, roles: ["viewer"] },
      permissions: [{ action: "read", resource: "*" }],
      source: "session",
    });
  });

  it("refuses a login for a user with no membership in that org", async () => {
    const res = await runtime.booted.app.request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: beta.orgId, userId: alpha.userId }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
