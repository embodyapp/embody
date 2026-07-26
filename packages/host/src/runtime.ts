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
import {
  EmbodyKernel,
  createConsoleLogger,
  InMemoryEventBus,
  OutboxEventBus,
} from "@embody/kernel";
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
import { createRuntimePlugin } from "./runtime-service.ts";
import { generateWebhookToken, hashWebhookToken } from "./hooks-route.ts";

const DEFAULT_DATABASE_URL = "postgres://embody:embody@localhost:5432/embody";

/** Resolve the owner + app-role Postgres URLs from options/env, deriving app from owner. */
export function resolveDbUrls(databaseUrl?: string): { owner: string; app: string } {
  const owner = databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const app =
    process.env.APP_DATABASE_URL ?? owner.replace("embody:embody@", "embody_app:embody_app@");
  return { owner, app };
}

/** Set once we have installed the TypeScript loader, so we never install it twice. */
let typeScriptLoaderInstalled = false;

/**
 * Make `import()` able to load TypeScript, and say so only when it is actually needed.
 *
 * An app's `embody.config.ts` is TypeScript, and it imports the app's own plugins,
 * which are TypeScript too. Three things can be true of the process loading it:
 *
 *   - it is already running under `tsx` (the dev path) — nothing to do;
 *   - it is Node 22.6+ with type stripping — also nothing to do;
 *   - it is plain Node running our published, compiled bin — which throws on a `.ts`
 *     file, and is the case that would otherwise break every developer's first command.
 *
 * Rather than detect which, we try the import and install the loader only if it fails.
 * That way the fast paths stay free and we never register a redundant ESM hook.
 */
async function importWithTypeScriptSupport(href: string): Promise<unknown> {
  try {
    return await import(href);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Node refuses TypeScript in two distinct ways, and which one you get depends on
    // the version: older Node does not know the extension at all, while Node 22.6+
    // strips types natively and then rejects anything that needs real transformation
    // (parameter properties, enums, namespaces). Both mean "install the loader".
    const isLoaderGap =
      code === "ERR_UNKNOWN_FILE_EXTENSION" ||
      code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" ||
      code === "ERR_MODULE_NOT_FOUND";
    if (typeScriptLoaderInstalled || !isLoaderGap) throw err;

    const { register } = await import("tsx/esm/api");
    register();
    typeScriptLoaderInstalled = true;
    return await import(href);
  }
}

/**
 * Load a deployment config module (`embody.config.ts`) and return its default export.
 * Shared by the CLI and the host bin so config loading behaves identically everywhere.
 */
export async function loadConfig(configPath: string): Promise<EmbodyConfig> {
  const absolute = resolve(process.cwd(), configPath);
  const module = (await importWithTypeScriptSupport(
    pathToFileURL(absolute).href,
  )) as { default?: EmbodyConfig };
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
  /**
   * How domain events are carried.
   *
   * `"durable"` (default) appends to `embody.outbox` inside the publishing
   * transaction; a worker process delivers them. This is the only correct setting for
   * a deployment — and it means nothing is delivered unless a worker is running.
   *
   * `"inline"` delivers in-process, losing events on a crash and decoupling them from
   * the transaction. For tests that assert on a subscriber without standing up a
   * worker.
   */
  events?: "durable" | "inline";
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

  // Constructed before bootstrap() creates the outbox tables, which is fine: the bus
  // touches the database only on publish, long after boot.
  const eventBus =
    (opts.events ?? "durable") === "durable"
      ? new OutboxEventBus({ sql: ownerDb.sql, publishedBy: "host" })
      : new InMemoryEventBus(logger);

  const kernel = new EmbodyKernel({
    logger,
    eventBus,
    runMigrations: async (set, pluginId) => {
      const ran = await runMigrations(ownerDb.sql, pluginId, set.dir, set.schema);
      if (ran.length) logger.info("applied migrations", { plugin: pluginId, ran });
    },
  });

  // `embody-runtime` provides the `embody.runtime` service (self-directed tool calls
  // and tenant transactions, for plugins that act without a caller); `core` is
  // foundation. Both are always registered; the config selects the rest.
  const runtimePlugin = createRuntimePlugin();
  const plugins: EmbodyPlugin[] = [
    runtimePlugin.plugin,
    corePlugin,
    ...resolvePlugins(opts.config, logger),
  ];
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

  const runtime: Runtime = {
    booted,
    ownerDb,
    appDb,
    logger,
    close: async () => {
      await appDb.close();
      await ownerDb.close();
    },
  };

  // Now that the tool registry and the app-role pool exist, the service handed out
  // during boot can do its job.
  runtimePlugin.bind({
    invoke: (principal, toolName, input) =>
      makeExecutor({ runtime, principal }).invoke(toolName, input),
    tx: (orgId, userId, fn) => withTenant(appDb.sql, orgId, userId, fn),
    toolNames: () => booted.mcp.tools.map((t) => t.name),
    webhookToken: () => {
      const token = generateWebhookToken();
      return { token, hash: hashWebhookToken(token) };
    },
  });

  return runtime;
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
