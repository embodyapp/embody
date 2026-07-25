/**
 * @embody/host — the reusable HTTP server transport. Every deployable service is this
 * engine plus an `embody.config.ts`; there is no per-app server code to fork.
 *
 * `startHost` boots the shared runtime (core + enabled apps, migrations applied) and,
 * in serve mode, mounts `/health` and listens. Two modes give the deploy contract its
 * seam:
 *   - "serve"        boot + serve HTTP (default).
 *   - "migrate-only" boot (which applies migrations) then return without serving.
 */
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createConsoleLogger } from "@embody/kernel";
import type { EmbodyPlugin, Logger } from "@embody/kernel";
import { bootRuntime } from "./runtime.ts";
import type { EmbodyConfig } from "./config.ts";
import { mountApi } from "./api.ts";
import { createDevIdentity, type IdentityProvider } from "./identity.ts";

export type HostMode = "serve" | "migrate-only";

export interface StartHostOptions {
  /** The deployment config: which apps to enable. `core` is always added. */
  config: EmbodyConfig;
  /** "serve" (default) or "migrate-only". */
  mode?: HostMode;
  /** Owner Postgres URL. Defaults to `DATABASE_URL` env, then the local dev default. */
  databaseUrl?: string;
  /** HTTP port for serve mode. Defaults to `PORT` env, then 3000. */
  port?: number;
  /** Override the logger (tests pass a silent one). */
  logger?: Logger;
  /** Mount the `/api` tool bridge in serve mode. Default true. */
  api?: boolean;
  /**
   * How an HTTP request's principal is established. Defaults to the dev provider
   * (session cookie + `EMBODY_DEV_IDENTITY`-gated headers). Supply your own to put a
   * real identity provider in front without touching the bridge.
   */
  identity?: IdentityProvider;
}

export interface RunningHost {
  /** Plugins actually registered, in `dependsOn` order (core first). */
  readonly plugins: readonly EmbodyPlugin[];
  /** Stop the HTTP server and close the db pools. Present only in serve mode. */
  readonly stop?: () => Promise<void>;
}

/**
 * Boot a deployment from its config. Always registers `core` + the config's apps.
 * In serve mode it also mounts `/health` and starts listening.
 */
export async function startHost(opts: StartHostOptions): Promise<RunningHost> {
  const mode = opts.mode ?? "serve";
  const logger = opts.logger ?? createConsoleLogger({ component: "host" });

  const runtime = await bootRuntime({
    config: opts.config,
    databaseUrl: opts.databaseUrl,
    logger,
  });
  const { booted } = runtime;
  const enabled = booted.plugins.map((p) => p.id);

  if (mode === "migrate-only") {
    logger.info("migrate-only complete; not serving", { plugins: enabled });
    await runtime.close();
    return { plugins: booted.plugins };
  }

  const { app } = booted;
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      plugins: enabled,
      mcpTools: booted.mcp.tools.length,
    }),
  );

  // The tool bridge: every enabled plugin's MCP tools, callable over HTTP through the
  // same executor. On by default because it is how a UI talks to a deployment, and safe
  // by default because every route refuses an unresolvable principal.
  if (opts.api !== false) {
    mountApi(app, {
      runtime,
      logger,
      identity: opts.identity ?? createDevIdentity({ sql: runtime.ownerDb.sql, logger }),
    });
  }

  // No static UI is served here on purpose. The framework must not reach across
  // buckets into a sibling directory by relative path — the demo SPA is an example,
  // it is served by its own Vite dev server, and the host stays a pure API surface.

  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  const server: ServerType = serve({ fetch: app.fetch, port }, (info) => {
    logger.info("host listening", { port: info.port, plugins: enabled });
  });

  return {
    plugins: booted.plugins,
    stop: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await runtime.close();
    },
  };
}
