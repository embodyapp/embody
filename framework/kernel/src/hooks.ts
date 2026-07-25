/**
 * Domain hooks: synchronous, in-transaction, and *vetoable* extension points.
 *
 * A hook handler runs in the middle of an operation (e.g. `crm.deal.beforeCreate`).
 * It receives the payload and may:
 *   - return a (possibly modified) payload to mutate it, or
 *   - return nothing to leave it unchanged, or
 *   - throw to VETO the whole operation.
 *
 * This is how one plugin extends another's behaviour without editing its code
 * (Decision D7). Contrast with the EventBus, which is async, post-commit, and cannot
 * veto.
 *
 * Plugins receive a ScopedHookRegistry (via ctx.hooks) that auto-binds their plugin
 * id and enforces their capability manifest — a plugin can only register hooks it
 * declared. The plugin-sdk base class calls `run()` around entity operations.
 */
import type { KernelContext } from "./types.ts";

export type HookHandler<T> = (
  payload: T,
  ctx: KernelContext,
) => T | void | Promise<T | void>;

interface Registration {
  pluginId: string;
  handler: HookHandler<unknown>;
}

/**
 * Thrown by a hook handler (or surfaced by the kernel) when an operation is vetoed.
 *
 * `HookRegistry.run` wraps *every* throw from a handler in this, carrying the original
 * on `cause`. That is what lets a transport tell a domain veto (a rule doing its job —
 * safe to show a user, HTTP 409) from a bug (redacted, HTTP 500) without asking plugin
 * authors — least of all customers under `custom/` — to throw a particular class.
 */
export class HookVetoError extends Error {
  constructor(
    public readonly hook: string,
    public readonly pluginId: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`Hook "${hook}" vetoed by plugin "${pluginId}": ${reason}`, options);
    this.name = "HookVetoError";
  }
}

/** The global registry. Plugins never touch this directly — they use a scoped view. */
export class HookRegistry {
  #handlers = new Map<string, Registration[]>();

  register<T>(pluginId: string, hook: string, handler: HookHandler<T>): void {
    const list = this.#handlers.get(hook) ?? [];
    list.push({ pluginId, handler: handler as HookHandler<unknown> });
    this.#handlers.set(hook, list);
  }

  /** True if at least one handler is registered for the hook. */
  has(hook: string): boolean {
    return (this.#handlers.get(hook)?.length ?? 0) > 0;
  }

  /**
   * Run every handler for `hook` in order, threading the (possibly mutated) payload
   * through each. If a handler throws, the error propagates — callers run hooks
   * inside their DB transaction so a throw rolls everything back (the veto).
   *
   * The throw is wrapped in a `HookVetoError` naming the hook and the plugin that
   * registered the handler. This is the only place that knows both, and doing it here
   * means every existing veto — first-party or a customer's under `custom/` — is typed
   * without editing a single plugin. A handler that already threw a HookVetoError
   * (richer detail, or a re-thrown veto from a nested run) passes through untouched.
   */
  async run<T>(hook: string, payload: T, ctx: KernelContext): Promise<T> {
    const list = this.#handlers.get(hook);
    if (!list) return payload;
    let current = payload;
    for (const { pluginId, handler } of list) {
      let result: unknown;
      try {
        result = await handler(current, ctx);
      } catch (err) {
        if (err instanceof HookVetoError) throw err;
        throw new HookVetoError(
          hook,
          pluginId,
          err instanceof Error ? err.message : String(err),
          { cause: err },
        );
      }
      if (result !== undefined) current = result as T;
    }
    return current;
  }

  /** Create a per-plugin view that enforces the plugin's declared hook capabilities. */
  scopedFor(pluginId: string, allowed: readonly string[]): ScopedHookRegistry {
    return new ScopedHookRegistry(this, pluginId, allowed);
  }
}

/**
 * A capability-checked, plugin-bound view of the hook registry. This is what a plugin
 * gets as `ctx.hooks` and as the argument to `registerHooks`.
 */
export class ScopedHookRegistry {
  constructor(
    private readonly registry: HookRegistry,
    private readonly pluginId: string,
    private readonly allowed: readonly string[],
  ) {}

  /** Register a handler for a hook this plugin declared under capabilities.hooks. */
  register<T>(hook: string, handler: HookHandler<T>): void {
    if (!this.allowed.includes(hook)) {
      throw new Error(
        `Plugin "${this.pluginId}" tried to register undeclared hook "${hook}". ` +
          `Add it to capabilities.hooks.`,
      );
    }
    this.registry.register(this.pluginId, hook, handler);
  }

  /** Run a hook chain. Used by the plugin-sdk around entity writes. */
  run<T>(hook: string, payload: T, ctx: KernelContext): Promise<T> {
    return this.registry.run(hook, payload, ctx);
  }

  has(hook: string): boolean {
    return this.registry.has(hook);
  }
}
