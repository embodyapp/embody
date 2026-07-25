/**
 * @embody/react — React hooks for an embody deployment.
 *
 * A UI is the fourth transport over the one executor. A plugin registers a tool once;
 * an AI agent calls it over MCP, a script calls it over the CLI, and a component calls
 * it with `useToolQuery` / `useToolMutation`. All four get the same tenant scoping
 * (RLS), the same authorization, and the same vetoable hook chain — so a rule another
 * plugin registered refuses a write from this UI without the UI knowing it exists.
 *
 * ```tsx
 * <EmbodyProvider>
 *   <Deals />
 * </EmbodyProvider>
 *
 * function Deals() {
 *   const { data, status } = useToolQuery("crm_query_deals", { limit: 50 });
 *   const close = useToolMutation("crm_update_deal", { invalidates: ["crm_query_deals"] });
 *   const canWrite = useCan("write", "crm:deal");
 *   ...
 *   const res = await close.mutate({ id, stage: "closed_won" });
 *   if (!res.ok && res.error.isVeto) toast.error(res.error.message);
 * }
 * ```
 *
 * Requires the host's `/api` bridge (@embody/host mounts it by default).
 * See docs/react-hooks.md.
 */

// Values
export { EmbodyError } from "./types.ts";
export { EmbodyProvider, useEmbody } from "./context.ts";
export { createEmbodyClient } from "./client.ts";
export { createQueryCache } from "./cache.ts";
export { useTool, useToolQuery, useToolMutation } from "./use-tool.ts";
export { useTools } from "./use-catalog.ts";
export { useIdentity, usePrincipal, useCan } from "./use-identity.ts";
export { matchesPermission } from "./can.ts";
export { toolKey, stableStringify } from "./key.ts";

// Types
export type {
  EmbodyErrorKind,
  Identity,
  IdentitySource,
  InputOf,
  OutputOf,
  Permission,
  Principal,
  QueryStatus,
  Result,
  ToolDescriptor,
  ToolMap,
  ToolName,
} from "./types.ts";
export type { EmbodyClient, EmbodyClientOptions, CallOptions } from "./client.ts";
export type { EmbodyProviderProps, UseEmbody } from "./context.ts";
export type { QueryCache, Snapshot, InvalidateTarget } from "./cache.ts";
export type {
  OptimisticTx,
  UseToolQueryOptions,
  UseToolQueryResult,
  UseToolMutationOptions,
  UseToolMutationResult,
} from "./use-tool.ts";
export type { UseToolsResult } from "./use-catalog.ts";
export type { UseIdentityResult } from "./use-identity.ts";
