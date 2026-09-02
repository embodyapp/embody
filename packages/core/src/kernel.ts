import type {
  ActionDefinition,
  EmbodyPlugin,
  EntityStoreAccessor,
  HookHandler,
  KernelContext,
  Principal,
} from "./contracts.js";
import {
  DependencyError,
  DuplicateRegistrationError,
  HookVetoError,
  InternalError,
  NotFoundError,
  ValidationError,
} from "./errors.js";
import {
  compileEntity,
  generatedEntityActions,
  type CompiledEntity,
  type EntityTransaction,
} from "./entities.js";
import { compileManifest, type AppManifest } from "./manifest.js";
import { formatTarget } from "./target.js";

export type KernelState = "created" | "booting" | "ready" | "stopping" | "stopped" | "failed";
export type BootPhase =
  "resolve" | "schema" | "services" | "init" | "registries" | "manifest" | "start";

export interface KernelStorage {
  ensureSchema(): Promise<void>;
  transaction?<T>(orgId: string, callback: (tx: EntityTransaction) => Promise<T>): Promise<T>;
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
  private readonly entities = new Map<string, CompiledEntity>();
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
  /** Executes a registered action in an org-bound transaction. */
  public async execute(target: string, input: unknown, principal: Principal): Promise<unknown> {
    if (this.state !== "ready") throw new DependencyError("Kernel is not ready");
    const action = this.actions.get(target);
    if (action === undefined) throw new NotFoundError(`Action was not found: ${target}`);
    const parsed = action.input.safeParse(input);
    if (!parsed.success)
      throw new ValidationError(
        "Action input is invalid",
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      );
    const run = async (tx: EntityTransaction): Promise<unknown> => {
      const context = this.executionContext(principal, tx);
      const result = await action.handler(parsed.data as never, context);
      if (action.output === undefined) return result;
      const output = action.output.safeParse(result);
      if (output.success) return output.data;
      throw new InternalError(`Action ${target} returned invalid output`);
    };
    if (this.options.storage.transaction === undefined)
      throw new DependencyError("Storage does not support transactions");
    return this.options.storage.transaction(principal.orgId, run);
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
      for (const plugin of this.sorted)
        for (const [name, definition] of Object.entries(plugin.entities ?? {})) {
          const entity = compileEntity(plugin.id, name, definition);
          this.entities.set(entity.target, entity);
        }
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
      for (const [name, entity] of Object.entries(plugin.entities ?? {})) {
        const compiled = this.entities.get(formatTarget([plugin.id, name]))!;
        for (const [operation, action] of Object.entries(generatedEntityActions(compiled)))
          this.registerAction(formatTarget([plugin.id, name, operation]), action);
        // Keep schema compilation and registration coupled even if manifests are inspected alone.
        void entity;
      }
      for (const [name, action] of Object.entries(plugin.actions ?? {}))
        this.registerAction(formatTarget([plugin.id, name]), action);
    }
  }
  private registerAction(target: string, action: ActionDefinition): void {
    if (this.actions.has(target))
      throw new DuplicateRegistrationError(`Duplicate action: ${target}`);
    this.actions.set(target, action);
  }
  private executionContext(principal: Principal, tx: EntityTransaction): KernelContext {
    const entities: Record<string, EntityStoreAccessor<never>> = {};
    for (const entity of this.entities.values()) {
      const lifecycle = {
        beforeCreate: (payload: unknown) =>
          this.runHooks(`${entity.target}.beforeCreate`, payload, context).then(() => undefined),
        afterCreate: (payload: unknown) =>
          this.runHooks(`${entity.target}.afterCreate`, payload, context).then(() => undefined),
        beforeUpdate: (payload: unknown) =>
          this.runHooks(`${entity.target}.beforeUpdate`, payload, context).then(() => undefined),
        afterUpdate: (payload: unknown) =>
          this.runHooks(`${entity.target}.afterUpdate`, payload, context).then(() => undefined),
        beforeDelete: (payload: unknown) =>
          this.runHooks(`${entity.target}.beforeDelete`, payload, context).then(() => undefined),
        afterDelete: (payload: unknown) =>
          this.runHooks(`${entity.target}.afterDelete`, payload, context).then(() => undefined),
        publish: (eventName: string, payload: unknown) =>
          context.events.publish(eventName, payload),
      };
      entities[entity.entityType] = entity.createStore(principal.orgId, {
        ...tx,
        lifecycle,
      }) as EntityStoreAccessor<never>;
    }
    const context = {
      principal,
      orgId: principal.orgId,
      entities,
      services: {
        get: <T>(key: string) =>
          this.registry.get<T>(
            "runtime",
            this.sorted.map(({ id }) => id),
            key,
          ),
      },
      events: {
        publish: async (eventName: string, payload: unknown) => {
          if (tx.outbox === undefined)
            throw new DependencyError("Storage transaction does not support outbox");
          await tx.outbox.enqueue(principal.orgId, { eventName, payload });
        },
      },
      progress: () => undefined,
      can: () => false,
    } as unknown as KernelContext;
    return context;
  }
  private async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    for (const component of [...this.started].reverse()) await component.stop?.();
    this.started.length = 0;
    await this.options.storage.close();
  }
}
