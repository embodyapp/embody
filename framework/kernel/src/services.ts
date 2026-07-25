/**
 * Inter-plugin service registry (typed Dependency Injection).
 *
 * Plugins publish services (`core.parties`, `email.send`) and consume each other's
 * by name. This is what lets plugins compose instead of being isolated silos
 * (Decision D7). Resolution is by name with a compatible major version (semver).
 */

interface Entry {
  version: string;
  impl: unknown;
  providerPluginId: string;
}

/** Thrown when a required service is missing or version-incompatible. */
export class ServiceResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceResolutionError";
  }
}

function major(version: string): number {
  const first = version.split(".")[0];
  const n = Number(first);
  return Number.isFinite(n) ? n : 0;
}

/** The global registry. Plugins never touch this directly — they use a scoped view. */
export class ServiceRegistry {
  #services = new Map<string, Entry>();

  register(
    providerPluginId: string,
    name: string,
    version: string,
    impl: unknown,
  ): void {
    if (this.#services.has(name)) {
      throw new ServiceResolutionError(
        `Service "${name}" is already provided by "${this.#services.get(name)!.providerPluginId}"`,
      );
    }
    this.#services.set(name, { version, impl, providerPluginId });
  }

  /** Resolve a service by name, optionally requiring a compatible major version. */
  get<T>(name: string, requiredVersion?: string): T {
    const entry = this.#services.get(name);
    if (!entry) {
      throw new ServiceResolutionError(`No service registered for "${name}"`);
    }
    if (requiredVersion && major(requiredVersion) !== major(entry.version)) {
      throw new ServiceResolutionError(
        `Service "${name}" is v${entry.version}, incompatible with required v${requiredVersion}`,
      );
    }
    return entry.impl as T;
  }

  has(name: string): boolean {
    return this.#services.has(name);
  }

  /** Create a per-plugin view that enforces the plugin's capability manifest. */
  scopedFor(
    pluginId: string,
    allowProvide: readonly string[],
    allowConsume: readonly string[],
  ): ScopedServiceRegistry {
    return new ScopedServiceRegistry(this, pluginId, allowProvide, allowConsume);
  }
}

/**
 * A capability-checked view of the registry handed to a single plugin. A plugin can
 * only provide services it declared under `capabilities.services.provide`, and only
 * consume ones under `capabilities.services.consume`.
 */
export class ScopedServiceRegistry {
  constructor(
    private readonly registry: ServiceRegistry,
    private readonly pluginId: string,
    private readonly allowProvide: readonly string[],
    private readonly allowConsume: readonly string[],
  ) {}

  provide(name: string, version: string, impl: unknown): void {
    if (!this.allowProvide.includes(name)) {
      throw new ServiceResolutionError(
        `Plugin "${this.pluginId}" tried to provide undeclared service "${name}". ` +
          `Add it to capabilities.services.provide.`,
      );
    }
    this.registry.register(this.pluginId, name, version, impl);
  }

  get<T>(name: string, requiredVersion?: string): T {
    if (!this.allowConsume.includes(name)) {
      throw new ServiceResolutionError(
        `Plugin "${this.pluginId}" tried to consume undeclared service "${name}". ` +
          `Add it to capabilities.services.consume.`,
      );
    }
    return this.registry.get<T>(name, requiredVersion);
  }
}
