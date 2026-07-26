/**
 * EmbodyKernel — the microkernel. It contains ZERO business logic. Its whole job is
 * to take a set of plugins and run them through the registration lifecycle in the
 * right order, wiring each into the shared extension surfaces (hooks, services,
 * middleware, events, MCP, routes).
 *
 * Lifecycle (see ARCHITECTURE.md §4):
 *   discover -> topo-sort -> [per plugin: validate caps -> (migrate) -> provide
 *   services -> init -> middleware -> hooks -> routes -> mcp tools -> mcp resources]
 *   -> subscribe -> ready
 *
 * Migration execution is delegated: the kernel calls an optional `runMigrations`
 * callback (supplied by @embody/db in M2) so the kernel stays database-agnostic.
 */
import { Hono } from "hono";
import type { EmbodyPlugin, KernelContext, MigrationSet } from "./types.ts";
import type { EventBus } from "./events.ts";
import { InMemoryEventBus, ScopedEventBus } from "./events.ts";
import type { Logger } from "./logger.ts";
import { createConsoleLogger } from "./logger.ts";
import { HookRegistry } from "./hooks.ts";
import { ServiceRegistry } from "./services.ts";
import { OrderedMiddlewarePipeline } from "./middleware.ts";
import { CollectingMcpRegistrar } from "./mcp.ts";
import { CollectingCliRegistrar } from "./cli.ts";
import { CollectingWebhookRegistrar } from "./webhooks.ts";
import { topoSort, validatePlugin } from "./plugin-manager.ts";

export interface KernelOptions {
  logger?: Logger;
  eventBus?: EventBus;
  /** Supplied by @embody/db. Called once per plugin that declares migrations. */
  runMigrations?: (set: MigrationSet, pluginId: string) => Promise<void>;
}

/** The assembled result of booting the kernel: everything the api-server needs. */
export interface BootedKernel {
  readonly app: Hono;
  readonly events: EventBus;
  readonly services: ServiceRegistry;
  readonly hooks: HookRegistry;
  readonly mcp: CollectingMcpRegistrar;
  readonly cli: CollectingCliRegistrar;
  readonly webhooks: CollectingWebhookRegistrar;
  readonly middleware: OrderedMiddlewarePipeline;
  readonly plugins: readonly EmbodyPlugin[];
}

export class EmbodyKernel {
  #plugins: EmbodyPlugin[] = [];
  readonly #logger: Logger;
  readonly #events: EventBus;
  readonly #services = new ServiceRegistry();
  readonly #hooks = new HookRegistry();
  readonly #middleware = new OrderedMiddlewarePipeline();
  readonly #mcp = new CollectingMcpRegistrar();
  readonly #cli = new CollectingCliRegistrar();
  readonly #webhooks = new CollectingWebhookRegistrar();
  readonly #runMigrations?: KernelOptions["runMigrations"];

  constructor(opts: KernelOptions = {}) {
    this.#logger = opts.logger ?? createConsoleLogger({ component: "kernel" });
    this.#events = opts.eventBus ?? new InMemoryEventBus(this.#logger);
    this.#runMigrations = opts.runMigrations;
  }

  /** Register a plugin instance. Call before boot(). */
  register(plugin: EmbodyPlugin): this {
    validatePlugin(plugin);
    this.#plugins.push(plugin);
    return this;
  }

  /** Build the KernelContext handed to a plugin, scoped to its capability manifest. */
  #contextFor(plugin: EmbodyPlugin): KernelContext {
    const caps = plugin.capabilities;
    const scopedServices = this.#services.scopedFor(
      plugin.id,
      caps.services?.provide ?? [],
      caps.services?.consume ?? [],
    );
    return {
      pluginId: plugin.id,
      logger: this.#logger.child({ plugin: plugin.id }),
      services: scopedServices,
      hooks: this.#hooks.scopedFor(plugin.id, caps.hooks ?? []),
      events: new ScopedEventBus(
        this.#events,
        plugin.id,
        caps.events?.publish ?? [],
        caps.events?.subscribe ?? [],
        caps.entities ?? [],
      ),
      capabilities: caps,
    };
  }

  /** Run the full lifecycle and return the wired-up application. */
  async boot(): Promise<BootedKernel> {
    const ordered = topoSort(this.#plugins);
    this.#logger.info("booting kernel", {
      plugins: ordered.map((p) => p.id),
    });

    const app = new Hono();
    const contexts = new Map<string, KernelContext>();

    // Pass 1: migrate + provide services (dependencies first, so a plugin can consume
    // a dependency's service during its own init in pass 2).
    for (const plugin of ordered) {
      const ctx = this.#contextFor(plugin);
      contexts.set(plugin.id, ctx);

      if (plugin.migrations) {
        if (this.#runMigrations) {
          await this.#runMigrations(plugin.migrations, plugin.id);
        } else {
          this.#logger.warn("plugin has migrations but no runner configured", {
            plugin: plugin.id,
          });
        }
      }

      if (plugin.provides) {
        for (const svc of plugin.provides(ctx)) {
          ctx.services.provide(svc.name, svc.version, svc.impl);
        }
      }
    }

    // Pass 2: init (may consume services registered above).
    for (const plugin of ordered) {
      await plugin.init?.(contexts.get(plugin.id)!);
    }

    // Pass 3a: collect middleware from every plugin, then apply to the app IN ORDER.
    // Middleware must be mounted before routes for Hono to run it, so this is a
    // distinct pass ahead of route registration.
    for (const plugin of ordered) {
      plugin.registerMiddleware?.(this.#middleware, contexts.get(plugin.id)!);
    }
    for (const { handler } of this.#middleware.all()) {
      app.use("*", handler);
    }

    // Pass 3b: hooks, routes, and MCP tools/resources.
    for (const plugin of ordered) {
      const ctx = contexts.get(plugin.id)!;
      // ctx.hooks is already scoped + capability-checked for this plugin.
      plugin.registerHooks?.(ctx.hooks, ctx);
      plugin.registerRoutes?.(app, ctx);
      plugin.registerMcpTools?.(this.#mcp, ctx);
      plugin.registerMcpResources?.(this.#mcp, ctx);
      plugin.registerCliCommands?.(this.#cli, ctx);
      plugin.registerWebhooks?.(this.#webhooks.forPlugin(plugin.id), ctx);
    }

    // Pass 4: subscribe to async events. Hand over ctx.events, not the raw bus: that
    // is what binds the plugin id onto each subscription (the worker needs it to name
    // deliveries) and what enforces capabilities.events.subscribe.
    for (const plugin of ordered) {
      const ctx = contexts.get(plugin.id)!;
      plugin.subscribe?.(ctx.events, ctx);
    }

    this.#logger.info("kernel ready", {
      routes: "mounted",
      mcpTools: this.#mcp.tools.length,
      mcpResources: this.#mcp.resources.length,
      cliCommands: this.#cli.commands.length,
      webhooks: this.#webhooks.webhooks.length,
    });

    return {
      app,
      events: this.#events,
      services: this.#services,
      hooks: this.#hooks,
      mcp: this.#mcp,
      cli: this.#cli,
      webhooks: this.#webhooks,
      middleware: this.#middleware,
      plugins: ordered,
    };
  }
}
