import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { startMcpBridge } from "../src/mcp-bridge.js";

async function requestBody(request: IncomingMessage): Promise<unknown> {
  if (request.method !== "POST") return undefined;
  let value = "";
  for await (const chunk of request) value += String(chunk);
  return value ? JSON.parse(value) : undefined;
}

it("bridges stdio-compatible MCP traffic to authenticated Streamable HTTP", async () => {
  let authorization: string | undefined;
  const remote = new Server({ name: "remote", version: "1.0.0" }, { capabilities: { tools: {} } });
  remote.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
  }));
  remote.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: request.params._meta?.progressToken ?? 0, progress: 50 },
    });
    return { content: [{ type: "text", text: JSON.stringify(request.params.arguments) }] };
  });
  const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await remote.connect(httpTransport as unknown as Transport);
  const httpServer = createServer((request, response) => {
    void (async () => {
      authorization = request.headers.authorization;
      await httpTransport.handleRequest(request, response, await requestBody(request));
    })();
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Missing address");

  const [clientTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
  const bridge = await startMcpBridge({
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    token: "secret",
    localTransport: bridgeTransport,
  });
  const client = new Client({ name: "local", version: "1.0.0" });
  try {
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ping"]);
    const progress: number[] = [];
    const result = await client.callTool({ name: "ping", arguments: { ok: true } }, undefined, {
      onprogress: (update) => progress.push(update.progress),
    });
    expect(progress).toEqual([50]);
    expect(result.content).toEqual([{ type: "text", text: '{"ok":true}' }]);
    expect(authorization).toBe("Bearer secret");
  } finally {
    await client.close();
    await bridge.close();
    await remote.close();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
