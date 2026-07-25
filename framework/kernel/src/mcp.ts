/**
 * MCP registrar interface. Plugins register AI-callable tools and resources through
 * this; the concrete implementation (stdio server) lives in @embody/mcp-server (M5).
 *
 * Every tool is Zod-validated and — critically — routed through the SAME authz as
 * REST. The AI tools are not a back door around permissions (Decision D4).
 */
import type { z } from "zod";
import type { RequestContext } from "./request-context.ts";

export type McpToolHandler<TInput> = (
  input: TInput,
  ctx: RequestContext,
) => Promise<unknown> | unknown;

export interface McpToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Namespaced tool name, e.g. "crm_query_deals". */
  name: string;
  description: string;
  /** Zod schema validating the tool input. */
  input: TSchema;
  handler: McpToolHandler<z.infer<TSchema>>;
}

export type McpResourceHandler = (
  params: Record<string, string>,
  ctx: RequestContext,
) => Promise<unknown> | unknown;

export interface McpResourceDefinition {
  /** URI template, e.g. "crm://accounts/{id}" or "crm://deals/pipeline". */
  uri: string;
  description: string;
  handler: McpResourceHandler;
}

export interface McpRegistrar {
  tool<TSchema extends z.ZodTypeAny>(def: McpToolDefinition<TSchema>): void;
  resource(def: McpResourceDefinition): void;
}

/** A collecting registrar the kernel uses to gather definitions during registration. */
export class CollectingMcpRegistrar implements McpRegistrar {
  readonly tools: McpToolDefinition[] = [];
  readonly resources: McpResourceDefinition[] = [];

  tool<TSchema extends z.ZodTypeAny>(def: McpToolDefinition<TSchema>): void {
    this.tools.push(def as unknown as McpToolDefinition);
  }

  resource(def: McpResourceDefinition): void {
    this.resources.push(def);
  }
}
