import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { expect, it } from "vitest";
import type { AppManifest } from "@embody/core";
import { genUiResourceIntegrity } from "@embody/genui";
import { createMcpCatalog, McpHttpHandler } from "../src/index.js";

const html = "<!doctype html><main>Immutable UI code</main>";
const manifest: AppManifest = {
  protocolVersion: 1,
  plugins: [{ id: "cards", version: "1.0.0" }],
  entities: {},
  eventSubscriptions: [],
  actions: {
    "cards.board": {
      generated: false,
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { title: { type: "string" } } },
      presentation: { view: "board" },
    },
    "cards.ping": { generated: false, inputSchema: { type: "object", properties: {} } },
  },
  views: {
    board: {
      protocolVersion: 1,
      id: "board",
      kind: "standard",
      version: "1.0.0",
      propsSchema: { type: "object", properties: { title: { type: "string" } } },
      resourceUri: "ui://cards/board@1.0.0",
      callableTargets: ["cards.board"],
      fallback: "text",
      integrity: genUiResourceIntegrity({ text: html }),
    },
  },
};
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.method !== "POST") return undefined;
  let value = "";
  for await (const chunk of request) value += String(chunk);
  return value ? JSON.parse(value) : undefined;
}

it.each(["supported", "absent", "partial", "malformed"])(
  "adds standard Apps tool metadata only for %s capabilities, never vendor names",
  async (capability) => {
    const handler = new McpHttpHandler<string>({
      catalog: () => createMcpCatalog([{ appId: "cards", manifest }]),
      readResource: () => Promise.resolve({ text: html }),
      execute: async function* () {
        await Promise.resolve();
        yield { type: "result", value: { title: "Current board" } };
      },
    });
    const server = createServer((request, response) => {
      void (async () => {
        await handler.handle({
          request,
          response,
          body: await body(request),
          identity: "verified-principal",
          context: "principal",
        });
      })();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    const mimeTypes =
      capability === "supported"
        ? [RESOURCE_MIME_TYPE]
        : capability === "malformed"
          ? RESOURCE_MIME_TYPE
          : ["text/plain"];
    const capabilities: ClientCapabilities & { extensions?: Record<string, unknown> } =
      capability === "absent" ? {} : { extensions: { [EXTENSION_ID]: { mimeTypes } } };
    const client = new Client(
      { name: capability === "supported" ? "unknown-host" : "Claude", version: "fixture" },
      { capabilities },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );
    try {
      await client.connect(transport as unknown as Transport);
      const listed = await client.listTools();
      const board = listed.tools.find((tool) => tool.name === "cards__cards_board");
      if (capability === "supported")
        expect(board?._meta).toEqual({
          ui: { resourceUri: "ui://cards/board@1.0.0", visibility: ["model", "app"] },
        });
      else expect(board?._meta).toBeUndefined();
      expect(listed.tools.find((tool) => tool.name === "cards__cards_ping")?._meta).toBeUndefined();
      const result = await client.callTool({ name: "cards__cards_board", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: '{"title":"Current board"}' }]);
      if (capability === "supported") {
        expect(result.structuredContent).toEqual({ title: "Current board" });
        const resource = await client.readResource({ uri: "ui://cards/board@1.0.0" });
        expect(resource.contents).toEqual([
          { uri: "ui://cards/board@1.0.0", mimeType: RESOURCE_MIME_TYPE, text: html },
        ]);
      } else {
        expect(result.structuredContent).toBeUndefined();
        await expect(client.readResource({ uri: "ui://cards/board@1.0.0" })).rejects.toThrow(
          "Resource not found or unavailable",
        );
      }
    } finally {
      await client.close();
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
