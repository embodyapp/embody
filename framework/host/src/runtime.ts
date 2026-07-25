/**
 * The runtime core shared by every transport (HTTP host, MCP server, CLI).
 *
 * `bootRuntime` implements config-driven plugin selection (core + enabled apps) and
 * opens the two DB roles: OWNER (migrations/control-plane, bypasses RLS) and APP
 * (request-path, subject to RLS). `makeExecutor` turns a booted runtime + a principal
 * into the single place an action runs: it builds a RequestContext whose `tx` is a
 * tenant-scoped `withTenant` transaction on the app role, and invokes a plugin's MCP
 * tool through it — same authz + RLS whether the caller is an agent, the CLI, or REST.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { EmbodyKernel, createConsoleLogger } from "@embody/kernel";
import type {
  BootedKernel,
  EmbodyPlugin,
  Logger,
  Principal,
  Authorizer,
  RequestContext,
} from "@embody/kernel";
import { createRequestContext } from "@embody/kernel";
import {
  createDb,
  bootstrap,
  runMigrations,
  withMigrationLock,
  withTenant,
  type DbHandle,
} from "@embody/db";
import { RbacAuthorizer } from "@embody/auth";
import { corePlugin } from "@embody/core";
import { resolvePlugins, type EmbodyConfig } from "./config.ts";

const DEFAULT_DATABASE_URL = "postgres://embody:embody@localhost:5432/embody";

/** Resolve the owner + app-role Postgres URLs from options/env, deriving app from owner. */
export function resolveDbUrls(databaseUrl?: string): { owner: string; app: string } {
  const owner = databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const app =
    process.env.APP_DATABASE_URL ?? owner.replace("embody:embody@", "embody_app:embody_app@");
  return { owner, app };
}

/**
 * Load a deployment config module (`embody.config.ts`) and return its default export.
 * Shared by the CLI and the host bin so config loading behaves identically everywhere.
 */
export async function loadConfig(configPath: string): Promise<EmbodyConfig> {
  const absolute = resolve(process.cwd(), configPath);
  const module = (await import(pathToFileURL(absolute).href)) as { default?: EmbodyConfig };
  const config = module.default;
  if (!config || !(Array.isArray(config.plugins) || Array.isArray(config.apps))) {
    throw new Error(
      `Config at ${configPath} must default-export defineConfig({ plugins: [...] })`,
    );
  }
  return config;
}

export interface BootRuntimeOptions {
  config: EmbodyConfig;
  databaseUrl?: string;
  logger?: Logger;
}

export interface Runtime {
  readonly booted: BootedKernel;
  /** Owner-role handle: migrations + control plane (bypasses RLS). */
  readonly ownerDb: DbHandle;
  /** App-role handle: request-path queries (subject to RLS via withTenant). */
  readonly appDb: DbHandle;
  readonly logger: Logger;
  /** Close both DB pools. */
  close(): Promise<void>;
}

/**
 * Boot the kernel from a config: always registers `core` + the config's apps, runs
 * migrations (owner role), and returns the wired runtime plus both DB handles.
 */
export async function bootRuntime(opts: BootRuntimeOptions): Promise<Runtime> {
  const logger = opts.logger ?? createConsoleLogger({ component: "runtime" });
  const { owner: ownerUrl, app: appUrl } = resolveDbUrls(opts.databaseUrl);

  const ownerDb = createDb(ownerUrl);

  const kernel = new EmbodyKernel({
    logger,
    runMigrations: async (set, pluginId) => {
      const ran = await runMigrations(ownerDb.sql, pluginId, set.dir, set.schema);
      if (ran.length) logger.info("applied migrations", { plugin: pluginId, ran });
    },
  });

  // `core` is foundation and always registered; the config selects the rest.
  const plugins: EmbodyPlugin[] = [corePlugin, ...resolvePlugins(opts.config, logger)];
  for (const plugin of plugins) kernel.register(plugin);

  // Bootstrap and every plugin's migrations touch shared objects (the app role, the
  // migration ledger, per-schema grants), so the phase runs under one advisory lock —
  // otherwise two deployables booting against the same database race each other.
  const booted = await withMigrationLock(ownerDb.sql, async () => {
    await bootstrap(ownerDb.sql);
    return kernel.boot();
  });
  // App-role handle created after bootstrap (which creates the app role).
  const appDb = createDb(appUrl);

  return {
    booted,
    ownerDb,
    appDb,
    logger,
    close: async () => {
      await appDb.close();
      await ownerDb.close();
    },
  };
}

export interface ExecutorOptions {
  runtime: Runtime;
  principal: Principal;
  /** Defaults to RBAC with the default policy. */
  authorizer?: Authorizer;
}

export interface Executor {
  /** A reusable RequestContext for this principal (each `tx` opens its own txn). */
  readonly request: RequestContext;
  /** Validate `rawInput` against the tool's Zod schema and run its handler. */
  invoke(toolName: string, rawInput: unknown): Promise<unknown>;
}

/**
 * Build the action executor for a principal: the RequestContext binds `tx` to a
 * withTenant transaction on the app role, so every tool call is org-scoped by RLS and
 * checked by the authorizer. This is the one code path MCP, the CLI, and REST share.
 */
export function makeExecutor(opts: ExecutorOptions): Executor {
  const { runtime, principal } = opts;
  const authorizer = opts.authorizer ?? new RbacAuthorizer();

  const request = createRequestContext(
    principal,
    authorizer,
    runtime.logger,
    (fn) => withTenant(runtime.appDb.sql, principal.orgId, principal.userId || null, fn),
  );

  return {
    request,
    async invoke(toolName, rawInput) {
      const tool = runtime.booted.mcp.tools.find((t) => t.name === toolName);
      if (!tool) {
        throw new Error(`Unknown tool "${toolName}"`);
      }
      const input = tool.input.parse(rawInput);
      return tool.handler(input, request);
    },
  };
}
