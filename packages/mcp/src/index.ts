import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ActionManifest, AppManifest, ProgressUpdate } from "@embody/core";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface McpCatalogEntry {
  readonly appId: string;
  readonly target: string;
  readonly tool: McpTool;
}
export type McpExecutionEvent =
  | { readonly type: "progress"; readonly update: ProgressUpdate }
  | { readonly type: "result"; readonly value: unknown }
  | { readonly type: "error"; readonly message: string };

/** Maps canonical dotted targets to MCP-safe, stable snake-case names. */
export function mcpTargetName(target: string): string {
  return target
    .split(".")
    .map((part) =>
      part
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase(),
    )
    .join("_");
}

function tool(name: string, action: ActionManifest): McpTool {
  return {
    name,
    ...(action.description === undefined ? {} : { description: action.description }),
    inputSchema: action.inputSchema,
  };
}

/** Builds a catalog and rejects lossy name mappings before any tool is exposed. */
export function createMcpCatalog(
  apps: readonly { readonly appId: string; readonly manifest: AppManifest }[],
  scopedAppId?: string,
): readonly McpCatalogEntry[] {
  const entries: McpCatalogEntry[] = [];
  const names = new Set<string>();
  for (const app of apps) {
    if (scopedAppId !== undefined && app.appId !== scopedAppId) continue;
    for (const [target, action] of Object.entries(app.manifest.actions).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const mapped = mcpTargetName(target);
      const name = scopedAppId === undefined ? `${app.appId}__${mapped}` : mapped;
      if (names.has(name)) throw new Error(`MCP tool name collision: ${name}`);
      names.add(name);
      entries.push({ appId: app.appId, target, tool: tool(name, action) });
    }
  }
  return entries;
}

export function mcpError(message = "Tool execution failed"): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
export function mcpResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export interface McpHttpOptions<TContext> {
  readonly catalog: (context: TContext, scopedAppId?: string) => readonly McpCatalogEntry[];
  readonly execute: (
    context: TContext,
    entry: McpCatalogEntry,
    input: unknown,
    signal: AbortSignal,
  ) => AsyncIterable<McpExecutionEvent>;
}
export interface McpHttpRequest<TContext> {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly body?: unknown;
  readonly scopedAppId?: string;
  readonly identity: string;
  readonly context: TContext;
}
interface Session<TContext> {
  readonly server: Server;
  readonly transport: StreamableHTTPServerTransport;
  readonly identity: string;
  readonly scopedAppId?: string;
  context: TContext;
}

/** Stateful official-SDK Streamable HTTP adapter with identity and endpoint pinning. */
export class McpHttpHandler<TContext> {
  private readonly sessions = new Map<string, Session<TContext>>();
  public constructor(private readonly options: McpHttpOptions<TContext>) {}

  public async handle(input: McpHttpRequest<TContext>): Promise<void> {
    const header = input.request.headers["mcp-session-id"];
    const sessionId = typeof header === "string" ? header : undefined;
    if (sessionId !== undefined) {
      const session = this.sessions.get(sessionId);
      if (
        !session ||
        session.identity !== input.identity ||
        session.scopedAppId !== input.scopedAppId
      ) {
        this.jsonError(input.response, 404, -32_001, "Session not found");
        return;
      }
      session.context = input.context;
      await session.transport.handleRequest(input.request, input.response, input.body);
      return;
    }
    const message = input.body as { method?: unknown } | undefined;
    if (input.request.method !== "POST" || message?.method !== "initialize") {
      this.jsonError(input.response, 400, -32_000, "MCP session ID is required");
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    const server = new Server(
      { name: "embody", version: "0.0.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    const session: Session<TContext> = {
      server,
      transport,
      identity: input.identity,
      ...(input.scopedAppId === undefined ? {} : { scopedAppId: input.scopedAppId }),
      context: input.context,
    };
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.options.catalog(session.context, session.scopedAppId).map((entry) => entry.tool),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const entry = this.options
        .catalog(session.context, session.scopedAppId)
        .find((candidate) => candidate.tool.name === request.params.name);
      if (!entry) return mcpError("Tool not found or no longer authorized");
      let terminal: CallToolResult | undefined;
      try {
        for await (const event of this.options.execute(
          session.context,
          entry,
          request.params.arguments ?? {},
          extra.signal,
        )) {
          if (event.type === "progress") {
            const token = request.params._meta?.progressToken;
            if (token !== undefined)
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken: token,
                  progress: event.update.percent ?? 0,
                  total: 100,
                  message: event.update.message,
                },
              });
          } else if (event.type === "result") terminal = mcpResult(event.value);
          else terminal = mcpError(event.message);
        }
        return terminal ?? mcpError("Remote stream ended without a result");
      } catch {
        if (extra.signal.aborted) return mcpError("Cancelled");
        return mcpError();
      }
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    // SDK 1.x transport declarations are not exactOptionalPropertyTypes-compatible.
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(input.request, input.response, input.body);
    if (transport.sessionId) this.sessions.set(transport.sessionId, session);
  }

  public async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.server.close()));
    this.sessions.clear();
  }
  private jsonError(response: ServerResponse, status: number, code: number, message: string): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
  }
}
