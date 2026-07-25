/**
 * The HTTP tool bridge — the browser's transport onto the one executor.
 *
 * A plugin registers a tool once (`registerMcpTools`) and it becomes callable by an AI
 * agent over MCP, by a script over the CLI, and — through this file — by a UI over
 * HTTP. All four go through `makeExecutor`, so a fetch from a React component gets the
 * same RLS scoping, the same `can()` check, and the same vetoable hook chain as an
 * agent's tool call. That is Decision D4 made literal: there is no REST back door,
 * because REST is not a separate door.
 *
 * Consequence worth stating: this is not a REST API and shouldn't be read as one.
 * Everything is POST (the executor draws no read/write distinction, and query strings
 * cannot carry a tool's nested input losslessly), so nothing here is HTTP-cacheable —
 * caching is the client's job (`@embody/react`).
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Logger, McpToolDefinition, Principal } from "@embody/kernel";
import { RbacAuthorizer } from "@embody/auth";
import type { Permission } from "@embody/auth";
import { makeExecutor, type Runtime } from "./runtime.ts";
import { toHttpError, UnauthenticatedError } from "./errors.ts";
import type { IdentityProvider, IdentitySource } from "./identity.ts";

/** What `GET /api/tools` reports for one tool. */
export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema (draft 7) derived from the tool's Zod input schema. */
  inputSchema: unknown;
}

export interface MountApiOptions {
  runtime: Runtime;
  logger: Logger;
  identity: IdentityProvider;
  /** Defaults to "/api". */
  basePath?: string;
}

/**
 * Describe the deployment's tools for a client. Computed once at mount: the tool set is
 * frozen after boot, and the payload is identical for every principal.
 *
 * No per-tool "may I call this?" flag. The permission a tool needs lives inside its
 * handler (`req.assert("write", "crm:deal")`) and is not declaratively knowable, so any
 * flag here would be a guess. Clients get grants from `/api/me` instead and treat them
 * as affordance, not authority.
 */
export function describeTools(tools: readonly McpToolDefinition[]): ToolDescriptor[] {
  return tools.map((tool) => {
    let inputSchema: unknown;
    try {
      // $refStrategy "none" inlines everything, so a client never resolves $ref.
      inputSchema = zodToJsonSchema(tool.input, { target: "jsonSchema7", $refStrategy: "none" });
    } catch {
      // One exotic schema must not take down the whole catalogue.
      inputSchema = { type: "object" };
    }
    return { name: tool.name, description: tool.description, inputSchema };
  });
}

export function mountApi(app: Hono, opts: MountApiOptions): void {
  const { runtime, logger, identity } = opts;
  const base = opts.basePath ?? "/api";
  // One policy object for the whole process; makeExecutor is called per request.
  const authorizer = new RbacAuthorizer();
  const catalogue = describeTools(runtime.booted.mcp.tools);

  const identityOf = async (c: Context): Promise<{ principal: Principal; source: IdentitySource }> => {
    const resolved = await identity.resolve(c);
    if (!resolved) throw new UnauthenticatedError();
    return resolved;
  };

  const describeIdentity = (
    principal: Principal,
    source: IdentitySource,
  ): { principal: Principal; permissions: Permission[]; source: IdentitySource } => ({
    principal,
    // Grants, not just role names: the client can answer "enable this button?" locally
    // instead of a round-trip per control. The server still decides on every call.
    permissions: authorizer.grantsFor(principal),
    source,
  });

  /** Uniform failure handling: map, log only what's redacted, never leak. */
  const fail = (c: Context, err: unknown, tool?: string) => {
    const { status, body, logAs } = toHttpError(err, tool);
    if (logAs !== undefined) {
      logger.error("api request failed", {
        tool,
        path: c.req.path,
        error: logAs instanceof Error ? logAs.stack ?? logAs.message : String(logAs),
      });
    }
    return c.json(body, status as ContentfulStatusCode);
  };

  // Nothing under /api is cacheable: tool calls are POSTs whose results are tenant- and
  // principal-specific. Say so explicitly rather than relying on defaults.
  app.use(`${base}/*`, async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.post(`${base}/session`, async (c) => {
    try {
      if (!identity.login) {
        throw new UnauthenticatedError("This deployment has no interactive login route.");
      }
      const body = await c.req.json().catch(() => ({}));
      const principal = await identity.login(c, body);
      return c.json(describeIdentity(principal, "session"));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.delete(`${base}/session`, async (c) => {
    try {
      await identity.logout?.(c);
      return c.body(null, 204);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get(`${base}/me`, async (c) => {
    try {
      const { principal, source } = await identityOf(c);
      return c.json(describeIdentity(principal, source));
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get(`${base}/tools`, async (c) => {
    try {
      await identityOf(c);
      return c.json({ tools: catalogue });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post(`${base}/tools/:name`, async (c) => {
    const name = c.req.param("name");
    try {
      // CSRF: a cross-site HTML form cannot set this content type, and the session
      // cookie is SameSite=Lax. Together that covers the browser attack surface
      // without a token round-trip.
      const contentType = c.req.header("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        return c.json(
          {
            error: {
              kind: "invalid_input" as const,
              message: "Tool calls must be sent as application/json.",
              tool: name,
            },
          },
          415,
        );
      }

      const { principal } = await identityOf(c);
      const body = await c.req.json().catch(() => ({}));
      const input = (body as { input?: unknown }).input ?? {};

      // Per request: the RequestContext binds one principal, and withTenant pins
      // app.current_org from it. Allocation only — no connection is taken until a
      // handler runs `req.tx`.
      const executor = makeExecutor({ runtime, principal, authorizer });
      const result = await executor.invoke(name, input);
      return c.json({ result });
    } catch (err) {
      return fail(c, err, name);
    }
  });
}
