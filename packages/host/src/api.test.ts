/**
 * The bridge, end to end, with no database.
 *
 * A fake Runtime supplies tools with REAL Zod schemas and handlers that throw the
 * interesting failures. Nothing calls `req.tx`, so no connection is ever taken — which
 * means these run in milliseconds and cover the whole request path: envelopes, schema
 * publication, identity, CSRF, and every status the taxonomy can produce. The parts
 * that genuinely need Postgres (RLS, real vetoes) are proven in
 * `examples/service-crm/src/api.integration.test.ts`.
 *
 * Run: `pnpm --filter @embody/host exec vitest run`
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import {
  AuthorizationError,
  HookVetoError,
  createSilentLogger,
  type McpToolDefinition,
} from "@embody/kernel";
import { mountApi, describeTools } from "./api.ts";
import { createDevIdentity } from "./identity.ts";
import type { Runtime } from "./runtime.ts";

const tools: McpToolDefinition[] = [
  {
    name: "crm_query_deals",
    description: "List deals in the current org, optionally filtered by stage.",
    input: z.object({
      stage: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    handler: (input) => [{ id: "deal-1", stage: (input as { stage?: string }).stage ?? "lead" }],
  },
  {
    name: "crm_update_deal",
    description: "Update a deal.",
    input: z.object({ id: z.string().uuid(), stage: z.string().optional() }),
    handler: () => {
      throw new HookVetoError(
        "crm.deal.beforeUpdate",
        "b2b-saas",
        "Enterprise deals over $50,000 require an approved security review.",
        { cause: new Error("Enterprise deals over $50,000 require an approved security review.") },
      );
    },
  },
  {
    name: "crm_delete_deal",
    description: "Delete a deal.",
    input: z.object({ id: z.string().uuid() }),
    handler: () => {
      throw new AuthorizationError("delete", "crm:deal");
    },
  },
  {
    name: "crm_explode",
    description: "A tool with a bug in it.",
    input: z.object({}),
    handler: () => {
      throw new TypeError("cannot read properties of undefined (reading 'secretInternalPath')");
    },
  },
];

/** Only the parts of Runtime the bridge touches. Nothing here opens a connection. */
const fakeRuntime = (): Runtime =>
  ({
    booted: { mcp: { tools } },
    logger: createSilentLogger(),
  }) as unknown as Runtime;

function testApp(): Hono {
  const app = new Hono();
  mountApi(app, {
    runtime: fakeRuntime(),
    logger: createSilentLogger(),
    identity: createDevIdentity({ allowUnauthenticatedIdentity: true }),
  });
  return app;
}

const AUTH = { "x-embody-org": "org-1", "x-embody-user": "user-1" };
const JSON_HEADERS = { "content-type": "application/json" };

const call = (app: Hono, tool: string, input: unknown, headers: Record<string, string> = AUTH) =>
  app.request(`/api/tools/${tool}`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify({ input }),
  });

describe("describeTools", () => {
  it("publishes real JSON Schema, not just parameter names", () => {
    const [deals] = describeTools(tools);
    expect(deals?.name).toBe("crm_query_deals");
    // Optionality, type and bounds all survive — that is the difference between a UI
    // contract and a list of strings.
    expect(deals?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        stage: { type: "string" },
        limit: { type: "integer", maximum: 100 },
      },
    });
    expect((deals?.inputSchema as { required?: string[] }).required).toBeUndefined();
  });

  it("degrades to a permissive schema rather than failing the catalogue", () => {
    const broken = {
      name: "weird",
      description: "",
      // A schema whose conversion throws must not take the other tools with it.
      input: new Proxy(z.object({}), {
        get() {
          throw new Error("nope");
        },
      }),
      handler: () => null,
    } as unknown as McpToolDefinition;
    expect(describeTools([broken])[0]?.inputSchema).toEqual({ type: "object" });
  });
});

describe("POST /api/tools/:name", () => {
  it("invokes a tool and wraps the result in an envelope", async () => {
    const res = await call(testApp(), "crm_query_deals", { stage: "proposal" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: [{ id: "deal-1", stage: "proposal" }] });
  });

  it("treats a missing body as empty input", async () => {
    const res = await testApp().request("/api/tools/crm_query_deals", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...AUTH },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: [{ id: "deal-1", stage: "lead" }] });
  });

  it("refuses a request that is not application/json (CSRF)", async () => {
    // A cross-site <form> can only send urlencoded/multipart/text — so it can't get here.
    const res = await testApp().request("/api/tools/crm_query_deals", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...AUTH },
      body: "input=%7B%7D",
    });
    expect(res.status).toBe(415);
  });

  it("requires an identity", async () => {
    const app = new Hono();
    mountApi(app, {
      runtime: fakeRuntime(),
      logger: createSilentLogger(),
      identity: createDevIdentity({ allowUnauthenticatedIdentity: false }),
    });
    const res = await call(app, "crm_query_deals", {}, {});
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: { kind: string } }).toMatchObject({
      error: { kind: "unauthenticated" },
    });
  });

  it("rejects input the tool's schema refuses, with the issues attached", async () => {
    const res = await call(testApp(), "crm_update_deal", { id: "not-a-uuid" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { kind: string; details: unknown[] } };
    expect(body.error.kind).toBe("invalid_input");
    expect(body.error.details.length).toBeGreaterThan(0);
  });

  it("404s an unknown tool, naming it", async () => {
    const res = await call(testApp(), "crm_teleport", {});
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { kind: string } }).toMatchObject({
      error: { kind: "unknown_tool", tool: "crm_teleport" },
    });
  });

  it("surfaces a domain veto as 409 with the rule's own message", async () => {
    const res = await call(testApp(), "crm_update_deal", {
      id: "11111111-1111-4111-8111-111111111111",
      stage: "closed_won",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { kind: string; message: string; details: unknown } };
    expect(body.error.kind).toBe("veto");
    expect(body.error.message).toMatch(/security review/);
    expect(body.error.details).toEqual({ hook: "crm.deal.beforeUpdate", plugin: "b2b-saas" });
  });

  it("surfaces an authorization failure as 403", async () => {
    const res = await call(testApp(), "crm_delete_deal", {
      id: "11111111-1111-4111-8111-111111111111",
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { kind: string } }).toMatchObject({
      error: { kind: "denied" },
    });
  });

  it("redacts an internal failure", async () => {
    const res = await call(testApp(), "crm_explode", {});
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/secretInternalPath/);
    expect(JSON.parse(text) as { error: { message: string } }).toMatchObject({
      error: { kind: "internal", message: "Internal error" },
    });
  });

  it("marks every response no-store", async () => {
    const res = await call(testApp(), "crm_query_deals", {});
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/tools and /api/me", () => {
  it("lists the deployment's tools to an authenticated caller", async () => {
    const res = await testApp().request("/api/tools", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: { name: string }[] };
    expect(body.tools.map((t) => t.name)).toEqual([
      "crm_query_deals",
      "crm_update_deal",
      "crm_delete_deal",
      "crm_explode",
    ]);
  });

  it("does not list tools to an anonymous caller", async () => {
    const app = new Hono();
    mountApi(app, {
      runtime: fakeRuntime(),
      logger: createSilentLogger(),
      identity: createDevIdentity({ allowUnauthenticatedIdentity: false }),
    });
    expect((await app.request("/api/tools")).status).toBe(401);
  });

  it("reports the principal and its effective grants", async () => {
    const res = await testApp().request("/api/me", {
      headers: { ...AUTH, "x-embody-roles": "viewer" },
    });
    expect(await res.json()).toEqual({
      principal: { orgId: "org-1", userId: "user-1", roles: ["viewer"] },
      permissions: [{ action: "read", resource: "*" }],
      source: "header",
    });
  });
});
