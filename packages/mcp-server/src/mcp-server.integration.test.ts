/**
 * Proves the agent path end-to-end over a REAL MCP client/server pair (in-memory
 * transport) against a REAL Postgres: an agent lists tools, creates a party + a deal,
 * and finds both via cross-app registry search — all through the same tenant-scoped,
 * RLS-enforced executor a REST call would use.
 *
 * Requires the docker-compose Postgres. Skips cleanly if unreachable.
 * Run: `pnpm --filter @embody/mcp-server exec vitest run`
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSilentLogger, type Principal } from "@embody/kernel";
import { defineConfig, bootRuntime, type Runtime } from "@embody/host";
import { createDb } from "@embody/db";
import { crmPlugin } from "@embody/crm";
import { buildMcpServer } from "./index.ts";

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

function textOf(result: unknown): unknown {
  const content = (result as { content?: { type: string; text: string }[] }).content;
  const first = content?.[0];
  return first ? JSON.parse(first.text) : undefined;
}

const canRun = await reachable(OWNER_URL);
const suite = canRun ? describe : describe.skip;

suite("mcp-server agent path (integration)", () => {
  let runtime: Runtime;
  let client: Client;
  let principal: Principal;

  beforeAll(async () => {
    runtime = await bootRuntime({
      config: defineConfig({ plugins: [crmPlugin] }),
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

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = buildMcpServer({ runtime, principal });
    await server.connect(serverT);
    client = new Client({ name: "test-agent", version: "0.0.0" });
    await client.connect(clientT);
  });

  afterAll(async () => {
    await runtime?.close();
  });

  it("exposes core + crm tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "core_create_party",
        "core_search",
        "crm_create_deal",
        "crm_query_deals",
      ]),
    );
  });

  it("creates a party + deal and finds both via cross-app search", async () => {
    const party = textOf(
      await client.callTool({
        name: "core_create_party",
        arguments: { kind: "organization", displayName: "Acme" },
      }),
    ) as { id: string; displayName: string };
    expect(party.displayName).toBe("Acme");

    const deal = textOf(
      await client.callTool({
        name: "crm_create_deal",
        arguments: { title: "Acme expansion", amount: 5000, partyId: party.id },
      }),
    ) as { id: string; title: string; stage: string };
    expect(deal.title).toBe("Acme expansion");
    expect(deal.stage).toBe("lead");

    const deals = textOf(
      await client.callTool({ name: "crm_query_deals", arguments: {} }),
    ) as { id: string }[];
    expect(deals.some((d) => d.id === deal.id)).toBe(true);

    const hits = textOf(
      await client.callTool({ name: "core_search", arguments: { query: "Acme" } }),
    ) as { type: string; displayLabel: string }[];
    const types = hits.map((h) => h.type);
    expect(types).toEqual(expect.arrayContaining(["core.party", "crm.deal"]));
  });
});
