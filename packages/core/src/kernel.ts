import type {
  ActionDefinition,
  EmbodyPlugin,
  HookHandler,
  KernelContext,
  Principal,
} from "./contracts.js";
import {
  DependencyError,
  DuplicateRegistrationError,
  HookVetoError,
  InternalError,
  ValidationError,
} from "./errors.js";
import { compileManifest, type AppManifest } from "./manifest.js";
import { formatTarget } from "./target.js";

export type KernelState = "created" | "booting" | "ready" | "stopping" | "stopped" | "failed";
export type BootPhase =
  "resolve" | "schema" | "services" | "init" | "registries" | "manifest" | "start";

export interface KernelStorage {
  ensureSchema(): Promise<void>;
  close(): Promise<void>;
}
export interface KernelComponent {
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
export interface KernelOptions {
  readonly plugins: readonly EmbodyPlugin[];
  readonly storage: KernelStorage;
  readonly components?: readonly KernelComponent[];
  readonly principal?: Principal;
  readonly onPhase?: (phase: BootPhase) => void;
}
export interface HookTrace {
  readonly handlerId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: "success" | "veto" | "error";
}

const pluginId = /^[a-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$/;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function sortPlugins(plugins: readonly EmbodyPlugin[]): readonly EmbodyPlugin[] {
  const byId = new Map<string, EmbodyPlugin>();
  for (const plugin of plugins) {
    if (!pluginId.test(plugin.id)) throw new ValidationError(`Invalid plugin ID: ${plugin.id}`);
    if (!semver.test(plugin.version))
      throw new ValidationError(`Invalid plugin version: ${plugin.id}`);
    if (byId.has(plugin.id)) throw new DuplicateRegistrationError(`Duplicate plugin: ${plugin.id}`);
    byId.set(plugin.id, plugin);
  }
  for (const plugin of byId.values())
    for (const dependency of plugin.dependsOn ?? []) {
      if (!byId.has(dependency))
        throw new DependencyError(`Plugin ${plugin.id} depends on missing plugin ${dependency}`);
    }
  const result: EmbodyPlugin[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: readonly string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id))
      throw new DependencyError(`Plugin dependency cycle: ${[...path, id].join(" -> ")}`);
    visiting.add(id);
    const plugin = byId.get(id)!;
    for (const dependency of [...(plugin.dependsOn ?? [])].sort()) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
    result.push(plugin);
  };
  for (const id of [...byId.keys()].sort()) visit(id, []);
  return result;
}

class ServiceRegistry {
  private readonly values = new Map<string, { readonly owner: string; readonly value: unknown }>();
  public register(owner: string, name: string, value: unknown): void {
    const key = formatTarget([owner, name]);
    if (this.values.has(key)) throw new DuplicateRegistrationError(`Duplicate service: ${key}`);
    this.values.set(key, { owner, value });
  }
  public get<T>(requester: string, dependencies: readonly string[], key: string): T {
    const service = this.values.get(key);
    if (service === undefined)
      throw new DependencyError(`Plugin ${requester} requested unavailable service ${key}`);
    if (service.owner !== requester && !dependencies.includes(service.owner)) {
      throw new DependencyError(
        `Plugin ${requester} has not declared dependency on service owner ${service.owner}`,
      );
    }
    return service.value as T;
  }
}

function bootContext(
  registry: ServiceRegistry,
  plugin: EmbodyPlugin,
  principal: Principal,
): KernelContext {
  return {
    principal,
    orgId: principal.orgId,
    entities: {},
    services: { get: <T>(key: string) => registry.get<T>(plugin.id, plugin.dependsOn ?? [], key) },
    events: { publish: () => Promise.resolve() },
    progress: () => undefined,
    can: () => false,
  } as unknown as KernelContext;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item);
  }
  return value;
}

export class Kernel {
  public state: KernelState = "created";
  private bootPromise: Promise<void> | undefined;
  private sorted: readonly EmbodyPlugin[] = [];
  private readonly registry = new ServiceRegistry();
  private readonly started: KernelComponent[] = [];
  private cleaned = false;
  private readonly hooks = new Map<
    string,
    { readonly id: string; readonly handler: HookHandler }[]
  >();
  private readonly actions = new Map<string, ActionDefinition>();
  private _manifest: AppManifest | undefined;

  public constructor(private readonly options: KernelOptions) {}
  public get manifest(): AppManifest {
    if (this._manifest === undefined)
      throw new DependencyError("Kernel manifest is unavailable before boot");
    return this._manifest;
  }
  public get plugins(): readonly EmbodyPlugin[] {
    return this.sorted;
  }
  public get actionTargets(): readonly string[] {
    return [...this.actions.keys()].sort();
  }

  public boot(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.bootPromise !== undefined) return this.bootPromise;
    if (this.state !== "created")
      return Promise.reject(new DependencyError(`Cannot boot kernel in ${this.state} state`));
    this.state = "booting";
    this.bootPromise = this.runBoot();
    return this.bootPromise;
  }
  public async stop(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state === "booting") await this.bootPromise;
    if (this.state !== "ready" && this.state !== "failed") {
      this.state = "stopped";
      return;
    }
    this.state = "stopping";
    await this.cleanup();
    this.state = "stopped";
  }
  public async runHooks(
    key: string,
    payload: unknown,
    context: KernelContext,
    now: () => number = Date.now,
  ): Promise<readonly HookTrace[]> {
    const trace: HookTrace[] = [];
    for (const entry of this.hooks.get(key) ?? []) {
      const startedAt = now();
      try {
        await entry.handler(payload, context);
        trace.push({ handlerId: entry.id, startedAt, endedAt: now(), outcome: "success" });
      } catch (error) {
        const outcome = error instanceof HookVetoError ? "veto" : "error";
        trace.push({ handlerId: entry.id, startedAt, endedAt: now(), outcome });
        if (error instanceof HookVetoError) throw error;
        throw new InternalError(`Hook ${entry.id} failed`, { cause: error });
      }
    }
    return trace;
  }

  private async runBoot(): Promise<void> {
    const principal = this.options.principal ?? {
      orgId: "system",
      actorId: "kernel",
      actorType: "system",
      roles: [],
      scopes: [],
    };
    try {
      this.phase("resolve");
      this.sorted = sortPlugins(this.options.plugins);
      if (this.sorted.some((plugin) => Object.keys(plugin.workflows ?? {}).length > 0))
        throw new DependencyError(
          "UNSUPPORTED_WORKFLOW: durable workflows are not available in MVP",
        );
      this.phase("schema");
      await this.options.storage.ensureSchema();
      this.phase("services");
      for (const plugin of this.sorted)
        for (const [name, value] of Object.entries(
          plugin.services?.(bootContext(this.registry, plugin, principal)) ?? {},
        ))
          this.registry.register(plugin.id, name, value);
      this.phase("init");
      for (const plugin of this.sorted)
        await plugin.init?.(bootContext(this.registry, plugin, principal));
      this.phase("registries");
      this.registerDefinitions();
      this.phase("manifest");
      this._manifest = freeze(compileManifest(this.sorted));
      this.phase("start");
      for (const component of this.options.components ?? []) {
        await component.start?.();
        this.started.push(component);
      }
      this.state = "ready";
    } catch (error) {
      await this.cleanup();
      this.state = "failed";
      throw error;
    }
  }
  private phase(phase: BootPhase): void {
    this.options.onPhase?.(phase);
  }
  private registerDefinitions(): void {
    for (const plugin of this.sorted) {
      for (const [hook, handler] of Object.entries(plugin.hooks ?? {})) {
        const handlers = this.hooks.get(hook) ?? [];
        handlers.push({ id: `${plugin.id}.${hook}`, handler });
        this.hooks.set(hook, handlers);
      }
      for (const [name, action] of Object.entries(plugin.actions ?? {})) {
        const target = formatTarget([plugin.id, name]);
        if (this.actions.has(target))
          throw new DuplicateRegistrationError(`Duplicate action: ${target}`);
        this.actions.set(target, action);
      }
    }
  }
  private async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    for (const component of [...this.started].reverse()) await component.stop?.();
    this.started.length = 0;
    await this.options.storage.close();
  }
}
