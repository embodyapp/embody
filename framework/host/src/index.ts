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
