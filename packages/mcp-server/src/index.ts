/**
 * @embody/mcp-server — the AI-agent transport. It turns a deployment (core + its
 * enabled apps) into an MCP stdio server: every plugin's `registerMcpTools` tool
 * becomes an agent-callable MCP tool, executed through the shared runtime executor so
 * it carries the same tenant scoping + authz as REST (Decision D4).
 *
 * STDOUT is the MCP protocol stream, so the runtime logs to STDERR here.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { z } from "zod";
import { createStderrLogger } from "@embody/kernel";
import type { Principal } from "@embody/kernel";
import { bootRuntime, makeExecutor } from "@embody/host";
import type { EmbodyConfig, Runtime } from "@embody/host";

export interface BuildMcpServerOptions {
  runtime: Runtime;
  principal: Principal;
  name?: string;
  version?: string;
}

/**
 * Build an McpServer exposing every tool the runtime collected, bound to `principal`.
 * Does not connect a transport — callers (stdio, or a test's in-memory transport) do.
 */
export function buildMcpServer(opts: BuildMcpServerOptions): McpServer {
  const executor = makeExecutor({ runtime: opts.runtime, principal: opts.principal });
  const server = new McpServer({
    name: opts.name ?? "embody",
    version: opts.version ?? "0.0.0",
  });

  for (const tool of opts.runtime.booted.mcp.tools) {
    // Every embody tool uses a z.object schema; the SDK wants its raw shape.
    const shape = (tool.input as z.ZodObject<z.ZodRawShape>).shape;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: shape },
      async (args: Record<string, unknown>) => {
        try {
          const result = await executor.invoke(tool.name, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

export interface StartMcpStdioOptions {
  config: EmbodyConfig;
  principal: Principal;
  databaseUrl?: string;
  name?: string;
  version?: string;
}

/** Boot the runtime and serve its tools over stdio MCP. Blocks until the stream closes. */
export async function startMcpStdio(opts: StartMcpStdioOptions): Promise<void> {
  const logger = createStderrLogger({ component: "mcp-server" });
  const runtime = await bootRuntime({ config: opts.config, databaseUrl: opts.databaseUrl, logger });
  const server = buildMcpServer({
    runtime,
    principal: opts.principal,
    name: opts.name,
    version: opts.version,
  });
  await server.connect(new StdioServerTransport());
  logger.info("mcp-server ready over stdio", {
    tools: runtime.booted.mcp.tools.map((t) => t.name),
  });
}
