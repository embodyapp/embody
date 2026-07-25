/**
 * PluginManager: discovery bookkeeping, dependency ordering, and manifest validation.
 * The kernel uses this to decide the order in which plugins are visited during the
 * lifecycle (Decision D6 — `dependsOn` topological sort).
 */
import type { EmbodyPlugin } from "./types.ts";

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

/**
 * Topologically sort plugins so every plugin appears after all of its `dependsOn`
 * dependencies. Throws on unknown dependencies or dependency cycles.
 */
export function topoSort(plugins: readonly EmbodyPlugin[]): EmbodyPlugin[] {
  const byId = new Map<string, EmbodyPlugin>();
  for (const p of plugins) {
    if (byId.has(p.id)) {
      throw new PluginError(`Duplicate plugin id "${p.id}"`);
    }
    byId.set(p.id, p);
  }

  const sorted: EmbodyPlugin[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (plugin: EmbodyPlugin, stack: string[]): void => {
    const mark = state.get(plugin.id);
    if (mark === "done") return;
    if (mark === "visiting") {
      throw new PluginError(
        `Dependency cycle detected: ${[...stack, plugin.id].join(" -> ")}`,
      );
    }
    state.set(plugin.id, "visiting");
    for (const depId of plugin.dependsOn ?? []) {
      const dep = byId.get(depId);
      if (!dep) {
        throw new PluginError(
          `Plugin "${plugin.id}" depends on "${depId}", which is not registered`,
        );
      }
      visit(dep, [...stack, plugin.id]);
    }
    state.set(plugin.id, "done");
    sorted.push(plugin);
  };

  for (const p of plugins) visit(p, []);
  return sorted;
}

/** Structural validation of a plugin manifest. Throws PluginError on problems. */
export function validatePlugin(plugin: EmbodyPlugin): void {
  if (!plugin.id || !/^[a-z][a-z0-9_-]*$/.test(plugin.id)) {
    throw new PluginError(
      `Invalid plugin id "${plugin.id}" (must be lower-kebab/snake, start with a letter)`,
    );
  }
  if (!plugin.schema || !/^[a-z][a-z0-9_]*$/.test(plugin.schema)) {
    throw new PluginError(
      `Plugin "${plugin.id}" has invalid schema "${plugin.schema}"`,
    );
  }
  if (!plugin.capabilities) {
    throw new PluginError(`Plugin "${plugin.id}" must declare a capabilities manifest`);
  }
}
