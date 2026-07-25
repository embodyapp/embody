/**
 * @embody/kernel — the microkernel public API.
 *
 * Contains ZERO business logic. Everything here is machinery for loading plugins and
 * exposing the four extension surfaces (middleware, hooks, services, events) plus MCP
 * and REST registration. See ARCHITECTURE.md.
 */

// Kernel + lifecycle
export { EmbodyKernel } from "./kernel.ts";
export type { KernelOptions, BootedKernel } from "./kernel.ts";

// Plugin contract + shared types
export type {
  EmbodyPlugin,
  KernelContext,
  CapabilityManifest,
  ServiceDescriptor,
  MigrationSet,
  MiddlewarePipeline,
  Json,
} from "./types.ts";

// Extension surfaces
export {
  HookRegistry,
  ScopedHookRegistry,
  HookVetoError,
} from "./hooks.ts";
export type { HookHandler } from "./hooks.ts";
export {
  ServiceRegistry,
  ScopedServiceRegistry,
  ServiceResolutionError,
} from "./services.ts";
export { InMemoryEventBus } from "./events.ts";
export type { EventBus, DomainEvent, EventHandler } from "./events.ts";
export { OrderedMiddlewarePipeline } from "./middleware.ts";

// MCP
export { CollectingMcpRegistrar } from "./mcp.ts";
export type {
  McpRegistrar,
  McpToolDefinition,
  McpToolHandler,
  McpResourceDefinition,
  McpResourceHandler,
} from "./mcp.ts";

// CLI extension surface
export { CollectingCliRegistrar } from "./cli.ts";
export type {
  CliRegistrar,
  CliCommandDefinition,
  CliCommandContext,
  CliCommandHandler,
  CliOptionDefinition,
} from "./cli.ts";

// Request context + authz
export {
  createRequestContext,
  AllowAllAuthorizer,
  AuthorizationError,
} from "./request-context.ts";
export type {
  RequestContext,
  Principal,
  Authorizer,
  TenantRunner,
} from "./request-context.ts";

// Plugin manager utilities
export { topoSort, validatePlugin, PluginError } from "./plugin-manager.ts";

// Logging
export {
  createConsoleLogger,
  createStderrLogger,
  createSilentLogger,
} from "./logger.ts";
export type { Logger } from "./logger.ts";
