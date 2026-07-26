/**
 * @embody/host — the reusable HTTP server transport. Every deployable service is this
 * engine plus an `embody.config.ts`; there is no per-app server code to fork.
 *
 * `startHost` boots the shared runtime (core + enabled apps, migrations applied) and,
 * in serve mode, mounts `/health` and listens. Three modes give the deploy contract
 * its seam:
 *   - "serve"        boot + serve HTTP (default). `worker: true` co-locates the
 *                    outbox drain, which is a dev convenience, not a deploy shape.
 *   - "migrate-only" boot (which applies migrations) then return without serving.
 *   - "worker"       boot + drain the event outbox. No HTTP.
 */
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createConsoleLogger } from "@embody/kernel";
import type { EmbodyPlugin, Logger } from "@embody/kernel";
import { bootRuntime } from "./runtime.ts";
import type { EmbodyConfig } from "./config.ts";
import { mountApi } from "./api.ts";
import { createDevIdentity, type IdentityProvider } from "./identity.ts";
import { startWorker } from "./worker.ts";
import { RUNTIME_PLUGIN_ID } from "./runtime-service.ts";
import { mountHooks } from "./hooks-route.ts";

export type HostMode = "serve" | "migrate-only" | "worker";

export interface StartHostOptions {
  /** The deployment config: which apps to enable. `core` is always added. */
  config: EmbodyConfig;
  /** "serve" (default), "migrate-only", or "worker". */
  mode?: HostMode;
  /**
   * In serve mode, also run the outbox worker in this process. Off by default: a
   * deployment should run `--mode worker` separately so the web tier stays stateless
   * and dispatch scales on its own. On for local dev, where two processes to see an
   * event fire is a poor trade.
   */
  worker?: boolean;
  /** Owner Postgres URL. Defaults to `DATABASE_URL` env, then the local dev default. */
  databaseUrl?: string;
  /** HTTP port for serve mode. Defaults to `PORT` env, then 3000. */
  port?: number;
  /** Override the logger (tests pass a silent one). */
  logger?: Logger;
  /** Mount the `/api` tool bridge in serve mode. Default true. */
  api?: boolean;
  /**
   * Mount `POST /hooks/:token` for plugin webhooks. Default true, and a no-op unless
   * a plugin registered one — so enabling an email plugin does not silently require a
   * config change to make its endpoint reachable.
   */
  hooks?: boolean;
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
  // The framework's own plugin is always registered and never selectable, so it is not
  // part of the answer to "which apps are enabled".
  const appPlugins = booted.plugins.filter((p) => p.id !== RUNTIME_PLUGIN_ID);
  const enabled = appPlugins.map((p) => p.id);

  if (mode === "migrate-only") {
    logger.info("migrate-only complete; not serving", { plugins: enabled });
    await runtime.close();
    return { plugins: appPlugins };
  }

  // Worker mode: no HTTP surface at all, just the outbox drain. The same boot, the
  // same plugins, the same subscriptions — only the transport differs.
  if (mode === "worker") {
    const worker = startWorker({ runtime, logger });
    return {
      plugins: appPlugins,
      stop: async () => {
        await worker.stop();
        await runtime.close();
      },
    };
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

  // Inbound webhooks, when any plugin registered one. Mounted outside the /api bridge:
  // the caller is a third party with no session, so it cannot inherit the bridge's
  // principal requirement or its CSRF content-type guard.
  if (booted.webhooks.webhooks.length > 0 && opts.hooks !== false) {
    mountHooks(app, { runtime, logger });
    logger.info("webhook ingress mounted", {
      endpoints: booted.webhooks.webhooks.map((w) => `${w.pluginId}/${w.def.name}`),
    });
  }

  // No static UI is served here on purpose. The framework must not reach across
  // buckets into a sibling directory by relative path — the demo SPA is an example,
  // it is served by its own Vite dev server, and the host stays a pure API surface.

  const coWorker = opts.worker ? startWorker({ runtime, logger }) : undefined;

  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  const server: ServerType = serve({ fetch: app.fetch, port }, (info) => {
    logger.info("host listening", { port: info.port, plugins: enabled });
  });

  return {
    plugins: appPlugins,
    stop: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await coWorker?.stop();
      await runtime.close();
    },
  };
}
