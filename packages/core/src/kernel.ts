import type {
  ActionDefinition,
  EmbodyPlugin,
  EntityStoreAccessor,
  ExecutionOptions,
  HookHandler,
  KernelContext,
  Principal,
  ProgressUpdate,
  DomainEvent,
  EventHandler,
} from "./contracts.js";
import {
  DependencyError,
  DuplicateRegistrationError,
  ForbiddenError,
  HookVetoError,
  InternalError,
  NotFoundError,
  UnavailableError,
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
import { progressUpdateSchema } from "./protocol.js";

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
  private readonly eventHandlers = new Map<string, { readonly id: string; readonly handler: EventHandler }[]>();
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
  public async execute(
    target: string,
    input: unknown,
    options: ExecutionOptions | Principal,
  ): Promise<unknown> {
    const execution = this.normalizeExecutionOptions(options);
    const startedAt = Date.now();
    let outcome: "success" | "failure" | "cancelled" = "failure";
    let errorCode: string | undefined;
    try {
      if (this.state !== "ready") throw new DependencyError("Kernel is not ready");
      this.assertPrincipal(execution.principal);
      this.throwIfAborted(execution.signal);
      const action = this.actions.get(target);
      if (action === undefined) throw new NotFoundError("Action was not found");
      const parsed = action.input.safeParse(input);
      if (!parsed.success)
        throw new ValidationError(
          "Action input is invalid",
          parsed.error.issues.map((issue) => ({
            path: issue.path.map(String),
            message: issue.message,
          })),
        );
      if (!execution.legacy && !this.scopeAllows(execution.principal.scopes, target))
        throw new ForbiddenError("Permission denied");
      const run = async (tx: EntityTransaction): Promise<unknown> => {
        this.throwIfAborted(execution.signal);
        const context = this.executionContext(execution.principal, tx, execution);
        const result = await action.handler(parsed.data as never, context);
        this.throwIfAborted(execution.signal);
        if (action.output === undefined) return result;
        const output = action.output.safeParse(result);
        if (output.success) return output.data;
        throw new InternalError("Action returned invalid output");
      };
      if (this.options.storage.transaction === undefined)
        throw new DependencyError("Storage does not support transactions");
      const result = await this.options.storage.transaction(execution.principal.orgId, run);
      outcome = "success";
      return result;
    } catch (error) {
      if (execution.signal?.aborted) outcome = "cancelled";
      errorCode = error instanceof Error && "code" in error ? String(error.code) : "INTERNAL_ERROR";
      throw error;
    } finally {
      await execution.audit?.({
        target,
        orgId: execution.principal.orgId,
        actorId: execution.principal.actorId,
        ...(execution.requestId === undefined ? {} : { requestId: execution.requestId }),
        ...(execution.traceparent === undefined ? {} : { traceparent: execution.traceparent }),
        durationMs: Date.now() - startedAt,
        outcome,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    }
  }
  /** Delivers an already-persisted event to this app's matching handlers in registration order. */
  public async handleEvent(event: DomainEvent, tx: EntityTransaction): Promise<void> {
    if (this.state !== "ready") throw new DependencyError("Kernel is not ready");
    const principal: Principal = {
      orgId: event.orgId,
      actorId: "event-worker",
      actorType: "system",
      roles: [],
      scopes: ["*"],
    };
    const context = this.executionContext(principal, tx, { principal });
    for (const entry of this.eventHandlers.get(event.name) ?? []) {
      const reservation = await tx.inbox?.reserve(event.id, entry.id);
      if (reservation?.state === "duplicate" || reservation?.state === "completed") continue;
      try {
        await entry.handler(event, context);
        await tx.inbox?.complete(event.id, entry.id);
      } catch (error) {
        await tx.inbox?.fail(event.id, entry.id, "Event handler failed");
        throw error;
      }
    }
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
      for (const [name, handler] of Object.entries(plugin.events ?? {})) {
        const handlers = this.eventHandlers.get(name) ?? [];
        handlers.push({ id: `${plugin.id}.${name}`, handler });
        this.eventHandlers.set(name, handlers);
      }
    }
  }
  private registerAction(target: string, action: ActionDefinition): void {
    if (this.actions.has(target))
      throw new DuplicateRegistrationError(`Duplicate action: ${target}`);
    this.actions.set(target, action);
  }
  private executionContext(
    principal: Principal,
    tx: EntityTransaction,
    execution: ExecutionOptions,
  ): KernelContext {
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
      ...(execution.requestId === undefined ? {} : { requestId: execution.requestId }),
      ...(execution.traceparent === undefined ? {} : { traceparent: execution.traceparent }),
      ...(execution.signal === undefined ? {} : { signal: execution.signal }),
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
          this.validateEvent(eventName, payload);
          await tx.outbox.enqueue(principal.orgId, { eventName, payload });
        },
      },
      progress: (update: ProgressUpdate) => {
        const parsed = progressUpdateSchema.safeParse(update);
        if (!parsed.success) throw new ValidationError("Progress update is invalid");
        execution.progress?.({
          message: parsed.data.message,
          ...(parsed.data.percent === undefined ? {} : { percent: parsed.data.percent }),
        });
      },
      can: (action: string) => this.scopeAllows(principal.scopes, action),
    } as unknown as KernelContext;
    return context;
  }
  private validateEvent(eventName: string, payload: unknown): void {
    if (!/^[a-z][A-Za-z0-9_-]*(?:\.[a-z][A-Za-z0-9_-]*)+$/.test(eventName))
      throw new ValidationError("Event name is invalid");
    let encoded: string;
    try {
      encoded = JSON.stringify(payload);
    } catch {
      throw new ValidationError("Event payload must be JSON serializable");
    }
    if (encoded === undefined || encoded.length > 256 * 1024)
      throw new ValidationError("Event payload must be JSON serializable and at most 256 KiB");
  }
  private normalizeExecutionOptions(
    options: ExecutionOptions | Principal,
  ): ExecutionOptions & { readonly legacy: boolean } {
    if ("principal" in options) return { ...options, legacy: false };
    return { principal: options, legacy: true };
  }
  private assertPrincipal(principal: Principal): void {
    if (
      !principal ||
      typeof principal.orgId !== "string" ||
      !principal.orgId ||
      typeof principal.actorId !== "string" ||
      !principal.actorId ||
      !["agent", "human", "system"].includes(principal.actorType) ||
      !Array.isArray(principal.roles) ||
      !Array.isArray(principal.scopes) ||
      !principal.roles.every((role) => typeof role === "string") ||
      !principal.scopes.every((scope) => typeof scope === "string")
    )
      throw new ValidationError("Principal is invalid");
  }
  private scopeAllows(scopes: readonly string[], target: string): boolean {
    const parts = target.split(".");
    return scopes.some((scope) => {
      if (scope === target || scope === parts.join(":")) return true;
      if (!scope.endsWith(":*")) return false;
      const prefix = scope.slice(0, -2).split(":");
      return prefix.length < parts.length && prefix.every((part, index) => part === parts[index]);
    });
  }
  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new UnavailableError("Execution cancelled");
  }
  private async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    for (const component of [...this.started].reverse()) await component.stop?.();
    this.started.length = 0;
    await this.options.storage.close();
  }
}
