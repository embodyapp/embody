/**
 * `embody.runtime` — the DI service that lets a plugin act on its own behalf.
 *
 * Almost every plugin is *reactive*: something calls its tool, and `RequestContext`
 * arrives with the caller's identity and transaction. An automation engine is not. It
 * wakes up in a worker with a domain event and has to (a) read its own configuration
 * and (b) invoke somebody else's tool as a principal it chooses. Neither is reachable
 * from `KernelContext`.
 *
 * This is deliberately a *service* rather than a new field on `KernelContext`. Putting
 * `invoke` on the context would hand every plugin the ability to call every tool with
 * any principal, silently. As a service it must be declared —
 * `services: { consume: ["embody.runtime"] }` — so "this plugin can act as anyone" is
 * visible in the capability manifest and enforced by the kernel, which is exactly what
 * the manifest is for (Decision D7).
 *
 * The implementation is bound after `kernel.boot()` returns, because the executor needs
 * the booted tool registry. Nothing can call it before then: services are consumed
 * during boot but invoked during request/event handling, long after.
 */
import type { Sql } from "@embody/db";
import type { EmbodyPlugin, Principal, ServiceDescriptor } from "@embody/kernel";

export const RUNTIME_SERVICE = "embody.runtime";

/**
 * Id of the internal plugin that provides it. Registered unconditionally by
 * `bootRuntime`, so it is filtered out of the "which apps are enabled" answer — it is
 * framework plumbing nobody selected, and listing it in `/health` would be noise in
 * every deployment. It remains in `booted.plugins`, which is the kernel's truth.
 */
export const RUNTIME_PLUGIN_ID = "embody-runtime";

export interface RuntimeService {
  /**
   * Run a registered tool as `principal`, through the same executor MCP, the CLI, and
   * the HTTP bridge use — so the tool's own `assert` still decides, and RLS still
   * scopes the transaction. Choosing the principal is the caller's responsibility;
   * this does not widen what the tool permits.
   */
  invoke(principal: Principal, toolName: string, input: unknown): Promise<unknown>;
  /** A tenant-scoped transaction on the app role (RLS active), for a plugin's own tables. */
  tx<T>(orgId: string, userId: string | null, fn: (tx: Sql) => Promise<T>): Promise<T>;
  /**
   * Every registered tool name. Enumerating the tool list is close to enumerating the
   * deployment's capabilities, which is why it is behind this declared service rather
   * than on `KernelContext`. It exists so a plugin wiring up a tool call by name can
   * reject a typo when the automation is created instead of when it finally fires.
   */
  toolNames(): string[];
  /**
   * Mint a webhook endpoint credential: the token to hand the sender, and the hash to
   * store. Both come from here rather than from the plugin creating the endpoint,
   * because `POST /hooks/:token` looks rows up by that hash — two implementations
   * would diverge the moment either changed, and the failure would be "the webhook
   * silently 404s", which is a miserable thing to debug.
   */
  webhookToken(): { token: string; hash: string };
}

export interface RuntimePluginHandle {
  /** Register this before the rest; it provides `embody.runtime`. */
  readonly plugin: EmbodyPlugin;
  /** Supply the real implementation once the runtime exists. */
  bind(impl: RuntimeService): void;
}

export function createRuntimePlugin(): RuntimePluginHandle {
  let bound: RuntimeService | undefined;

  const notReady = (): never => {
    throw new Error(
      "embody.runtime was used before boot finished. Consume it during registration, " +
        "but only call it from a request, event, or CLI handler.",
    );
  };

  const impl: RuntimeService = {
    invoke: (principal, toolName, input) =>
      bound ? bound.invoke(principal, toolName, input) : notReady(),
    tx: (orgId, userId, fn) => (bound ? bound.tx(orgId, userId, fn) : notReady()),
    toolNames: () => (bound ? bound.toolNames() : notReady()),
    webhookToken: () => (bound ? bound.webhookToken() : notReady()),
  };

  return {
    plugin: {
      id: RUNTIME_PLUGIN_ID,
      schema: "embody",
      capabilities: { services: { provide: [RUNTIME_SERVICE] } },
      provides: (): ServiceDescriptor[] => [
        { name: RUNTIME_SERVICE, version: "1.0.0", impl },
      ],
    },
    bind: (real) => {
      bound = real;
    },
  };
}
