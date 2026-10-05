import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpHttpHandler, type McpHttpOptions } from "../src/index.js";

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.method !== "POST") return undefined;
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text ? JSON.parse(text) : undefined;
}

/** Official-client conformance seam; gateway authentication is tested separately. */
export async function withApps(
  options: McpHttpOptions<string>,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const handler = new McpHttpHandler(options);
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
  const client = new Client(
    { name: "reference-conformance", version: "fixture" },
    { capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${address.port}/mcp`),
      ) as unknown as Transport,
    );
    await run(client);
  } finally {
    await client.close();
    await handler.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
