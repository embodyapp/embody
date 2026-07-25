/**
 * Proves the agent path end-to-end over a REAL MCP client/server pair (in-memory
 * transport) against a REAL Postgres: an agent lists tools, creates a party and a
 * second plugin's entity, and finds both via cross-plugin registry search — all
 * through the same tenant-scoped, RLS-enforced executor a REST call would use.
 *
 * The second plugin is a fixture defined below rather than a real one. This package
 * must not depend on any plugin: plugins depend on the runtime, so a runtime package
 * reaching back for one would be a circular dependency the moment both are published.
 * A fixture also states the requirement honestly — what is under test is that ANY
 * plugin's entities join the graph, not that one particular plugin's do.
 *
 * Requires the docker-compose Postgres. Skips cleanly if unreachable.
 * Run: `pnpm --filter @embody/mcp-server exec vitest run`
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSilentLogger, type EmbodyPlugin, type Principal } from "@embody/kernel";
import { defineConfig, bootRuntime, type Runtime } from "@embody/host";
import { createDb } from "@embody/db";
import type { RegistryService } from "@embody/core";
import { buildMcpServer } from "./index.ts";

/**
 * A minimal plugin: one MCP tool that writes a registry pointer. It needs no schema
 * and no migrations, because `core.registry` records source coordinates without a
 * foreign key to the source row.
 */
const fixturePlugin: EmbodyPlugin = {
  id: "fixture",
  // Declared but never created: with no `migrations` the kernel never runs a migration
  // pass for this plugin, so no schema is touched. Same shape as any hook-only plugin.
  schema: "fixture",
  dependsOn: ["core"],
  capabilities: {
    entities: ["fixture.widget"],
    services: { consume: ["core.registry"] },
  },

  registerMcpTools(mcp, ctx) {
    const registry = ctx.services.get<RegistryService>("core.registry");

    mcp.tool({
      name: "fixture_create_widget",
      description: "Create a widget and register it in the cross-plugin entity graph.",
      input: z.object({ label: z.string().min(1) }),
      handler: async (input, req) => {
        req.assert("write", "fixture:widget");
        return req.tx(async (tx) => {
          const sourceId = randomUUID();
          const entityId = await registry.register(tx, {
            orgId: req.orgId,
            type: "fixture.widget",
            sourceSchema: "fixture",
            sourceTable: "widgets",
            sourceId,
            displayLabel: input.label,
          });
          return { id: sourceId, entityId, label: input.label };
        });
      },
    });
  },
};

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
      config: defineConfig({ plugins: [fixturePlugin] }),
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

  it("exposes core's tools alongside the enabled plugin's", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["core_create_party", "core_search", "fixture_create_widget"]),
    );
  });

  it("creates entities in two plugins and finds both via cross-plugin search", async () => {
    const party = textOf(
      await client.callTool({
        name: "core_create_party",
        arguments: { kind: "organization", displayName: "Acme" },
      }),
    ) as { id: string; displayName: string };
    expect(party.displayName).toBe("Acme");

    const widget = textOf(
      await client.callTool({
        name: "fixture_create_widget",
        arguments: { label: "Acme expansion" },
      }),
    ) as { id: string; entityId: string; label: string };
    expect(widget.label).toBe("Acme expansion");

    // One search spans both plugins' entity types — neither knows about the other.
    const hits = textOf(
      await client.callTool({ name: "core_search", arguments: { query: "Acme" } }),
    ) as { type: string; displayLabel: string }[];
    const types = hits.map((h) => h.type);
    expect(types).toEqual(expect.arrayContaining(["core.party", "fixture.widget"]));
  });
});
