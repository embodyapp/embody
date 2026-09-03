import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AppManifest } from "@embody/core";
import {
  createMcpCatalog,
  McpHttpHandler,
  mcpTargetName,
  type McpHttpOptions,
} from "../src/index.js";

const manifest: AppManifest = {
  protocolVersion: 1,
  plugins: [{ id: "cards", version: "1.0.0" }],
  entities: {},
  actions: {
    "cards.sendBatch": {
      description: "Send cards",
      inputSchema: { type: "object", properties: { count: { type: "number" } } },
      generated: false,
    },
  },
  eventSubscriptions: [],
};
const closers: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(closers.splice(0).map((close) => close())));

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.method !== "POST") return undefined;
  let value = "";
  for await (const chunk of request) value += String(chunk);
  return value ? JSON.parse(value) : undefined;
}

async function fixture(execute?: McpHttpOptions<string>["execute"]) {
  const catalog = createMcpCatalog([{ appId: "kanban", manifest }]);
  const handler = new McpHttpHandler<string>({
    catalog: () => catalog,
    execute:
      execute ??
      async function* (_context, _entry, input) {
        await Promise.resolve();
        yield { type: "progress", update: { percent: 50, message: "Halfway" } };
        yield { type: "result", value: input };
      },
  });
  const server = createServer((request, response) => {
    void (async () => {
      await handler.handle({
        request,
        response,
        body: await body(request),
        identity: String(request.headers.authorization),
        context: "principal",
      });
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  closers.push(async () => {
    await handler.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return url;
}

describe("MCP surface", () => {
  it("normalizes camel case and rejects collisions", () => {
    expect(mcpTargetName("cards.sendBatchURL")).toBe("cards_send_batch_url");
    expect(createMcpCatalog([{ appId: "one", manifest }])[0]?.tool.name).toBe(
      "one__cards_send_batch",
    );
    expect(createMcpCatalog([{ appId: "one", manifest }], "one")[0]?.tool.name).toBe(
      "cards_send_batch",
    );
    expect(() =>
      createMcpCatalog(
        [
          {
            appId: "one",
            manifest: {
              ...manifest,
              actions: {
                "cards.sendBatch": manifest.actions["cards.sendBatch"]!,
                "cards.send_batch": manifest.actions["cards.sendBatch"]!,
              },
            },
          },
        ],
        "one",
      ),
    ).toThrow(/collision/);
  });

  it("initializes, lists, calls and forwards progress with the official client", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const url = await fixture();
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: "Bearer test" } },
    });
    await client.connect(transport as unknown as Transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["kanban__cards_send_batch"]);
    const progress: number[] = [];
    const result = await client.callTool(
      { name: "kanban__cards_send_batch", arguments: { count: 2 } },
      undefined,
      { onprogress: (update) => progress.push(update.progress) },
    );
    expect(progress).toEqual([50]);
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: '{"count":2}' }]);
    const wrongIdentity = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": transport.sessionId ?? "missing",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(wrongIdentity.status).toBe(404);
    await client.close();
  });

  it("propagates client cancellation to execution", async () => {
    let cancelled = false;
    const url = await fixture(async function* (_context, _entry, _input, signal) {
      if (!signal.aborted)
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      cancelled = signal.aborted;
      if (!signal.aborted) yield { type: "result", value: null };
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: "Bearer test" } },
    });
    await client.connect(transport as unknown as Transport);
    const controller = new AbortController();
    const call = client.callTool({ name: "kanban__cards_send_batch", arguments: {} }, undefined, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(call).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelled).toBe(true);
    await client.close();
  });
});
