/** Concrete MiddlewarePipeline: preserves plugin registration order. */
import type { MiddlewareHandler } from "hono";
import type { MiddlewarePipeline } from "./types.ts";

export class OrderedMiddlewarePipeline implements MiddlewarePipeline {
  #entries: { pluginId: string; handler: MiddlewareHandler }[] = [];

  use(pluginId: string, handler: MiddlewareHandler): void {
    this.#entries.push({ pluginId, handler });
  }

  all(): readonly { pluginId: string; handler: MiddlewareHandler }[] {
    return this.#entries;
  }
}
