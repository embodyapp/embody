import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import type { AppManifest, Principal } from "@embody/core";
import {
  apiKeyProvider,
  AuthChain,
  createGateway,
  delegatedAgentPrincipal,
  GatewayRegistry,
  hashApiKey,
  MemoryAuditLog,
  type GatewayOptions,
} from "../src/index.js";

const manifest: AppManifest = {
  protocolVersion: 1,
  plugins: [{ id: "kanban", version: "1.0.0" }],
  entities: {},
  actions: {
    "kanban.ping": { generated: false, inputSchema: { type: "object", properties: {} } },
  },
  eventSubscriptions: [],
};
const human: Principal = {
  orgId: "org-1",
  actorId: "alice",
  actorType: "human",
  roles: ["member"],
  scopes: ["kanban:*"],
  metadata: { client: "claude" },
};
const closers: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(closers.splice(0).map((close) => close())));

function fixture(principal: Principal, mcp?: GatewayOptions["mcp"]) {
  const registry = new GatewayRegistry({
    allowPrivateEndpoints: true,
    credentials: { kanban: "registration-secret" },
  });
  registry.register(
    {
      protocolVersion: 1,
      appId: "kanban",
      version: "1.0.0",
      endpoint: "http://127.0.0.1:8081",
      healthCheckUrl: "http://127.0.0.1:8081/health",
      manifest,
    },
    "registration-secret",
  );
  const audit = new MemoryAuditLog();
  const forwarded: Record<string, unknown>[] = [];
  const gateway = createGateway({
    registry,
    auth: new AuthChain([apiKeyProvider([{ id: "key", hash: hashApiKey("api-key"), principal }])]),
    token: { issuer: "test", key: new TextEncoder().encode("12345678901234567890123456789012") },
    fetch: (url, init) => {
      const header = new Headers(init?.headers).get("x-gateway-auth") ?? "";
      forwarded.push(decodeJwt(header.replace(/^Bearer /, "")));
      const body = "event: result\ndata: {}\n\n";
      return Promise.resolve(
        (url instanceof Request ? new URL(url.url) : new URL(url)).pathname === "/execute/stream"
          ? new Response(body, { headers: { "content-type": "text/event-stream" } })
          : Response.json({}),
      );
    },
    audit,
    ...(mcp === undefined ? {} : { mcp }),
  });
  closers.push(() => gateway.close());
  return { gateway, audit, forwarded };
}

async function callOverMcp(principal: Principal, mcp?: GatewayOptions["mcp"]) {
  const { gateway, audit, forwarded } = fixture(principal, mcp);
  const address = await gateway.listen({ port: 0, host: "127.0.0.1" });
  const client = new Client({ name: "untrusted-name", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: "Bearer api-key" } },
    }) as unknown as Transport,
  );
  closers.unshift(() => client.close());
  await client.callTool({ name: "kanban__kanban_ping", arguments: {} });
  return { audit, forwarded };
}

describe("delegatedAgentPrincipal", () => {
  it("turns a human credential into an agent acting for that person", () => {
    expect(delegatedAgentPrincipal(human)).toEqual({
      ...human,
      actorType: "agent",
      actorId: "claude:alice",
      delegation: { subjectId: "alice", subjectType: "human", client: "claude" },
    });
  });

  it("keeps agent credentials unchanged", () => {
    const agent: Principal = { ...human, actorType: "agent", actorId: "bot" };
    expect(delegatedAgentPrincipal(agent)).toBe(agent);
  });

  it("ignores unusable client labels", () => {
    for (const client of ["", "has space", "a:b", 7, "x".repeat(201)])
      expect(delegatedAgentPrincipal({ ...human, metadata: { client } }).delegation).toEqual({
        subjectId: "alice",
        subjectType: "human",
      });
    expect(delegatedAgentPrincipal({ ...human, metadata: {} }).actorId).toBe("mcp:alice");
  });
});

describe("MCP actor attribution", () => {
  it("forwards a delegated agent to the app host and audits the subject", async () => {
    const { audit, forwarded } = await callOverMcp(human);
    expect(forwarded[0]).toMatchObject({
      actorType: "agent",
      actorId: "claude:alice",
      delegation: { subjectId: "alice", subjectType: "human", client: "claude" },
    });
    expect(audit.records[0]).toMatchObject({
      surface: "mcp",
      actorId: "claude:alice",
      subjectId: "alice",
      client: "claude",
    });
  });

  it("keeps the credential's actor in deprecated token mode", async () => {
    const { forwarded } = await callOverMcp(human, { actor: "token" });
    expect(forwarded[0]).toMatchObject({ actorType: "human", actorId: "alice" });
    expect(forwarded[0]?.["delegation"]).toBeUndefined();
  });

  it("does not change attribution on the HTTP API", async () => {
    const { gateway, forwarded } = fixture(human);
    await gateway.inject({
      method: "POST",
      url: "/api/execute/kanban/kanban.ping",
      headers: { authorization: "Bearer api-key" },
      payload: {},
    });
    expect(forwarded[0]).toMatchObject({ actorType: "human", actorId: "alice" });
    expect(forwarded[0]?.["delegation"]).toBeUndefined();
  });
});
