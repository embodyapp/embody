import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;

export interface McpBridgeOptions {
  readonly url: URL;
  readonly token?: string;
  /** Primarily useful for embedding and tests. Defaults to process stdio. */
  readonly localTransport?: Transport;
}

export interface McpBridge {
  close(): Promise<void>;
}

/** Bridges a local MCP stdio client to a remote Streamable HTTP MCP endpoint. */
export async function startMcpBridge(options: McpBridgeOptions): Promise<McpBridge> {
  if (options.url.protocol !== "http:" && options.url.protocol !== "https:")
    throw new Error("MCP URL must use http or https");

  const remote = new Client({ name: "embody-cli", version: packageVersion });
  const headers = options.token ? { authorization: `Bearer ${options.token}` } : undefined;
  const remoteTransport = new StreamableHTTPClientTransport(options.url, {
    ...(headers ? { requestInit: { headers } } : {}),
  });
  await remote.connect(remoteTransport as unknown as Transport);

  const local = new Server(
    { name: "embody", version: packageVersion },
    { capabilities: { tools: { listChanged: true } } },
  );
  local.setRequestHandler(ListToolsRequestSchema, (request) => remote.listTools(request.params));
  local.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    remote.callTool(request.params, undefined, {
      signal: extra.signal,
      resetTimeoutOnProgress: true,
      onprogress: (progress) => {
        const progressToken = request.params._meta?.progressToken;
        if (progressToken === undefined) return;
        void extra
          .sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: progress.progress,
              ...(progress.total === undefined ? {} : { total: progress.total }),
              ...(progress.message === undefined ? {} : { message: progress.message }),
            },
          })
          .catch(() => undefined);
      },
    }),
  );

  const localTransport = options.localTransport ?? new StdioServerTransport();
  local.onclose = () => void remote.close();
  try {
    await local.connect(localTransport);
  } catch (error) {
    await remote.close();
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    close: () => {
      closing ??= local.close().finally(() => remote.close());
      return closing;
    },
  };
}
