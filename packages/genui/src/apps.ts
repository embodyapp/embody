import { AppBridge, isToolVisibilityModelOnly } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolRequest, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export interface GenUiHostedTool {
  readonly target: string;
  readonly appId?: string;
  readonly tool: Tool;
  readonly effect?: "read" | "mutation";
}
export interface GenUiHostOutcome {
  readonly target: string;
  readonly status: "confirmed" | "rejected" | "uncertain";
  readonly reconciliation: "read-required";
  readonly code?: string;
}
export interface GenUiAppBridgeOptions {
  readonly appId: string;
  readonly generation: string;
  readonly currentGeneration: () => string;
  readonly callableTargets: readonly string[];
  /** Trusted authorized catalog, never supplied by the iframe. */
  readonly tools: readonly GenUiHostedTool[];
  /** Authenticated ordinary MCP dispatch; credentials stay in this host callback. */
  readonly callTool: (
    name: string,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<CallToolResult>;
  /** Must record minimal outcomes in the real host's next-agent-request context, without triggering a turn. */
  readonly publishOutcome: (outcome: GenUiHostOutcome) => Promise<void>;
}
// ext-apps 1.7.5 ships extensionless inherited declaration imports. Describe only its documented
// public lifecycle methods for NodeNext consumers; the actual runtime remains the official SDK.
export type GenUiOfficialBridge = AppBridge & {
  addEventListener(event: "initialized", handler: () => void): void;
  onclose: (() => void) | undefined;
  close(): Promise<void>;
};
export interface GenUiAppHost {
  readonly bridge: GenUiOfficialBridge;
  dispose(): void;
}
function appVisible(tool: Tool): boolean {
  const ui: unknown = tool._meta?.["ui"];
  if (ui === undefined) return true;
  if (ui === null || typeof ui !== "object" || Array.isArray(ui)) return false;
  if (!("visibility" in ui) || ui.visibility === undefined) return true;
  const visibility: unknown = ui.visibility;
  return (
    Array.isArray(visibility) &&
    visibility.length > 0 &&
    visibility.length <= 2 &&
    visibility.every((value: unknown) => value === "model" || value === "app") &&
    visibility.includes("app") &&
    !isToolVisibilityModelOnly(tool)
  );
}
const unavailable = (): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: "View action is unavailable" }],
});

/** One instance per initialized view. No automatic broad MCP forwarding or model-context proxying. */
export function createGenUiAppBridge(options: GenUiAppBridgeOptions): GenUiAppHost {
  const appId = options.appId;
  const generation = options.generation;
  const allowed = new Set(options.callableTargets);
  const tools = structuredClone(options.tools);
  const bridge = new AppBridge(
    null,
    { name: "Embody GenUI host", version: "1.0.0" },
    { serverTools: {} },
  ) as GenUiOfficialBridge;
  const lifetime = new AbortController();
  let initialized = false;
  let disposed = false;
  let busy = false;
  bridge.addEventListener("initialized", () => {
    if (!disposed) initialized = true;
  });
  bridge.onclose = () => {
    initialized = false;
    disposed = true;
    lifetime.abort();
  };
  bridge.oncalltool = async (params: CallToolRequest["params"], extra: { signal: AbortSignal }) => {
    const entry = tools.find((item) => item.tool.name === params.name);
    if (
      disposed ||
      !initialized ||
      busy ||
      options.currentGeneration() !== generation ||
      !entry ||
      (entry.appId !== undefined && entry.appId !== appId) ||
      !allowed.has(entry.target) ||
      !appVisible(entry.tool)
    )
      return unavailable();
    busy = true;
    const signal = AbortSignal.any([extra.signal, lifetime.signal]);
    let result: CallToolResult;
    let status: GenUiHostOutcome["status"];
    let safeCode: string | undefined;
    try {
      result = await options.callTool(entry.tool.name, params.arguments ?? {}, signal);
      // Cancellation is not rollback. Do not deliver late props or claim confirmation
      // after the request/view lifetime (or its manifest generation) has ended.
      if (signal.aborted || disposed || options.currentGeneration() !== generation)
        throw new Error();
      const code: unknown = result._meta?.["embody/errorCode"];
      const definitive =
        typeof code === "string" &&
        ["HOOK_VETO", "VALIDATION_ERROR", "FORBIDDEN", "NOT_FOUND"].includes(code);
      status = result.isError ? (definitive ? "rejected" : "uncertain") : "confirmed";
      if (result.isError && definitive && typeof code === "string") safeCode = code;
    } catch {
      result = {
        isError: true,
        content: [{ type: "text", text: "Outcome uncertain; read current state" }],
      };
      status = "uncertain";
    }
    try {
      if (entry.effect !== "read") {
        try {
          await options.publishOutcome(
            Object.freeze({
              target: entry.target,
              status,
              reconciliation: "read-required",
              ...(safeCode === undefined ? {} : { code: safeCode }),
            }),
          );
        } catch {
          result = {
            ...result,
            _meta: { ...result._meta, "embody/reconciliation": "read-required" },
          };
        }
      }
      return result;
    } finally {
      busy = false;
    }
  };
  return {
    bridge,
    dispose() {
      if (disposed) return;
      disposed = true;
      initialized = false;
      lifetime.abort();
      void bridge.close();
    },
  };
}
