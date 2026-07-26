/**
 * @embody/host — reusable server engine for embody deployments.
 *
 * A deployable service is this package + an `embody.config.ts` selecting apps. The
 * host always registers `core` (foundation) and the config's apps, then boots the
 * kernel. See ARCHITECTURE.md §4 (lifecycle) and §7 (repo map).
 */
export { defineConfig, resolvePlugins } from "./config.ts";
export type { EmbodyConfig } from "./config.ts";
export { startHost } from "./host.ts";
export type { HostMode, StartHostOptions, RunningHost } from "./host.ts";

// Runtime core shared by every transport (HTTP host, MCP server, CLI).
export {
  bootRuntime,
  makeExecutor,
  loadConfig,
  resolveDbUrls,
} from "./runtime.ts";
export type {
  Runtime,
  BootRuntimeOptions,
  Executor,
  ExecutorOptions,
} from "./runtime.ts";

// `embody.runtime`: the DI service a plugin consumes to act without a caller.
export { createRuntimePlugin, RUNTIME_SERVICE } from "./runtime-service.ts";
export type { RuntimeService, RuntimePluginHandle } from "./runtime-service.ts";

// The outbox drain: delivers durable domain events to subscribers, with retries.
export { startWorker } from "./worker.ts";
export type { WorkerOptions, RunningWorker } from "./worker.ts";

// Inbound webhooks: POST /hooks/:token, where the token resolves the tenant.
export {
  mountHooks,
  generateWebhookToken,
  hashWebhookToken,
  safeEqual,
} from "./hooks-route.ts";
export type { MountHooksOptions, WebhookEndpointRow } from "./hooks-route.ts";

// Cron schedules, which fire by publishing an event like anything else.
export { runDueSchedules, nextRun } from "./scheduler.ts";
export type { SchedulerOptions, ScheduleRow } from "./scheduler.ts";

// The HTTP tool bridge: plugin tools over HTTP, on the same executor as MCP and the CLI.
export { mountApi, describeTools } from "./api.ts";
export type { MountApiOptions, ToolDescriptor } from "./api.ts";
export { toHttpError, UnauthenticatedError, UnavailableError } from "./errors.ts";
export type { ApiError, ApiErrorBody, ApiErrorKind, HttpErrorResult } from "./errors.ts";
export { createDevIdentity, SESSION_COOKIE } from "./identity.ts";
export type {
  IdentityProvider,
  IdentitySource,
  ResolvedIdentity,
  DevIdentityOptions,
} from "./identity.ts";
