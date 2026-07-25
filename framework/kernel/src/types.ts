/**
 * Core kernel types. These define the contract that every plugin — first-party or
 * customer-authored — must satisfy. The kernel itself contains ZERO business logic;
 * all behaviour comes from plugins registered against these interfaces.
 */
import type { Hono, MiddlewareHandler } from "hono";
import type { Sql } from "@embody/db";
import type { ScopedHookRegistry } from "./hooks.ts";
import type { ScopedServiceRegistry } from "./services.ts";
import type { EventBus } from "./events.ts";
import type { McpRegistrar } from "./mcp.ts";
import type { CliRegistrar } from "./cli.ts";
import type { Logger } from "./logger.ts";

/** A plain JSON value. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/**
 * What a plugin is allowed to touch. The kernel enforces this: a plugin that tries
 * to register a hook, provide/consume a service, or publish/subscribe to an event
 * outside its declared manifest is rejected at load time. This is what sandboxes an
 * untrusted / third-party plugin (Decision D7).
 */
export interface CapabilityManifest {
  /** Entity types this plugin owns or may operate on, e.g. ["crm.deal"]. */
  entities?: string[];
  /** Hook names it may register, e.g. ["crm.deal.beforeCreate"]. */
  hooks?: string[];
  services?: {
    /** Service names this plugin publishes for others. */
    provide?: string[];
    /** Service names this plugin is allowed to consume. */
    consume?: string[];
  };
  events?: {
    /** Event names this plugin may publish. */
    publish?: string[];
    /** Event name patterns this plugin may subscribe to. */
    subscribe?: string[];
  };
}

/** A typed service one plugin publishes for others to consume via the DI registry. */
export interface ServiceDescriptor<T = unknown> {
  /** Globally unique, namespaced name, e.g. "core.parties". */
  name: string;
  /** semver of the service contract. Consumers resolve by name + compatible version. */
  version: string;
  /** The implementation object. */
  impl: T;
}

/**
 * Context handed to a plugin during the registration lifecycle. Everything the
 * plugin needs to wire itself into the kernel, pre-scoped to its capability manifest.
 */
export interface KernelContext {
  /** This plugin's id. */
  readonly pluginId: string;
  /** Structured logger, tagged with the plugin id. */
  readonly logger: Logger;
  /** DI registry, scoped so provide/consume are checked against the manifest. */
  readonly services: ScopedServiceRegistry;
  /** Hook registry, scoped so registrations are checked against the manifest. */
  readonly hooks: ScopedHookRegistry;
  /** Durable event bus. */
  readonly events: EventBus;
  /** This plugin's declared capability manifest (what the kernel scoped it to). */
  readonly capabilities: CapabilityManifest;
  /**
   * The in-flight tenant transaction, present ONLY in the context a hook handler
   * receives (the plugin-sdk adds it when running a chain around an entity write).
   * A hook can use it to read related rows before deciding to veto — anything it
   * writes is rolled back with the operation if any handler throws. Undefined in the
   * registration-time context.
   */
  readonly tx?: Sql;
}

/**
 * A single migration the plugin owns. Kept intentionally abstract in the kernel — the
 * db package supplies the concrete runner. The kernel only guarantees ordering
 * (a plugin's migrations run after its dependencies' migrations).
 */
export interface MigrationSet {
  /** Directory or identifier the db runner understands. */
  readonly dir: string;
  /** The Postgres schema these migrations create/own, e.g. "crm". */
  readonly schema: string;
}

/**
 * The plugin contract. Implement this (usually via the base class in @embody/plugin-sdk)
 * to add an app to embody. Registration methods are called in the lifecycle order
 * documented in ARCHITECTURE.md §4.
 */
export interface EmbodyPlugin {
  /** Unique, namespaced id, e.g. "crm". */
  readonly id: string;
  /** The Postgres schema this plugin owns, e.g. "crm". */
  readonly schema: string;
  /** Ids of plugins that must load before this one, e.g. ["core"]. */
  readonly dependsOn?: readonly string[];
  /** What this plugin is permitted to touch. Enforced by the kernel. */
  readonly capabilities: CapabilityManifest;
  /** Migrations this plugin owns (optional; run before init). */
  readonly migrations?: MigrationSet;

  /** Services this plugin publishes into the DI registry (registered before init). */
  provides?(ctx: KernelContext): ServiceDescriptor[];

  /** Plugin setup. May consume other plugins' services via ctx.services. */
  init?(ctx: KernelContext): Promise<void> | void;

  /** Contribute ordered HTTP middleware. */
  registerMiddleware?(pipeline: MiddlewarePipeline, ctx: KernelContext): void;
  /** Register synchronous, in-transaction, vetoable domain hooks. */
  registerHooks?(hooks: ScopedHookRegistry, ctx: KernelContext): void;
  /** Mount REST routes. All routes go through tenancy + authz middleware. */
  registerRoutes?(router: Hono, ctx: KernelContext): void;
  /** Register MCP/AI tools (Zod-validated, same authz as REST). */
  registerMcpTools?(mcp: McpRegistrar, ctx: KernelContext): void;
  /** Register MCP resources (e.g. crm://deals/pipeline). */
  registerMcpResources?(mcp: McpRegistrar, ctx: KernelContext): void;
  /** Contribute `embody` CLI subcommands (same authz as MCP/REST). */
  registerCliCommands?(cli: CliRegistrar, ctx: KernelContext): void;
  /** Subscribe to async, post-commit domain events. */
  subscribe?(bus: EventBus, ctx: KernelContext): void;
}

/** Ordered collection of HTTP middleware contributed by plugins. */
export interface MiddlewarePipeline {
  /** Append a middleware. Kernel preserves insertion order across plugins. */
  use(pluginId: string, handler: MiddlewareHandler): void;
  /** All registered middleware, in order. */
  all(): readonly { pluginId: string; handler: MiddlewareHandler }[];
}
