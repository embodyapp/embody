import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HookVetoError,
  Kernel,
  type z,
  type EmbodyPlugin,
  type EntityRecord,
  type ExecutionAuditEvent,
  type Principal,
  type ProgressUpdate,
} from "@embody/core";
import { OutboxWorker, type OutboxWorkerOptions } from "@embody/host";
import { SqliteStorage, type OutboxEvent } from "@embody/storage";

export interface TestHarnessActor {
  readonly actorId: string;
  readonly actorType: Principal["actorType"];
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TestHarnessOptions<
  TPlugins extends readonly EmbodyPlugin[] = readonly EmbodyPlugin[],
> {
  readonly plugins: TPlugins;
  /** Complete request identity. Takes precedence over `tenantId` and `actor`. */
  readonly principal?: Principal;
  readonly tenantId?: string;
  readonly actor?: TestHarnessActor;
  /** Replaces only services actually provided by a plugin, keyed as `plugin.service`. */
  readonly services?: Readonly<Record<string, unknown>>;
  readonly now?: () => Date;
  readonly eventId?: () => string;
  readonly worker?: Omit<OutboxWorkerOptions, "storage" | "kernel">;
}

export interface CapturedProgress {
  readonly requestId: string;
  readonly principal: Principal;
  readonly update: ProgressUpdate;
}

export interface HarnessCallOptions {
  readonly signal?: AbortSignal;
}

type ActionClient<TAction> = TAction extends {
  readonly input: infer TInput extends z.ZodType;
  readonly output: infer TOutput extends z.ZodType;
}
  ? (input: z.input<TInput>, options?: HarnessCallOptions) => Promise<z.output<TOutput>>
  : TAction extends { readonly input: infer TInput extends z.ZodType }
    ? (input: z.input<TInput>, options?: HarnessCallOptions) => Promise<unknown>
    : never;

type EntityClient<TDefinition> = TDefinition extends {
  readonly schema: infer TSchema extends z.ZodObject;
}
  ? {
      create(
        input: { readonly data: z.input<TSchema> },
        options?: HarnessCallOptions,
      ): Promise<EntityRecord<z.output<TSchema>>>;
      get(
        input: { readonly id: string },
        options?: HarnessCallOptions,
      ): Promise<EntityRecord<z.output<TSchema>>>;
      list(
        input?: {
          readonly filter?: Partial<z.output<TSchema>>;
          readonly sort?: {
            readonly field: keyof z.output<TSchema> & string;
            readonly direction: "asc" | "desc";
          };
          readonly limit?: number;
          readonly offset?: number;
        },
        options?: HarnessCallOptions,
      ): Promise<readonly EntityRecord<z.output<TSchema>>[]>;
      update(
        input: { readonly id: string; readonly data: Partial<z.input<TSchema>> },
        options?: HarnessCallOptions,
      ): Promise<EntityRecord<z.output<TSchema>>>;
      delete(
        input: { readonly id: string },
        options?: HarnessCallOptions,
      ): Promise<EntityRecord<z.output<TSchema>>>;
    }
  : never;

type PluginClient<TPlugin> = (TPlugin extends {
  readonly actions: infer TActions extends Readonly<Record<string, unknown>>;
}
  ? { readonly [TName in keyof TActions]: ActionClient<TActions[TName]> }
  : object) &
  (TPlugin extends {
    readonly entities: infer TEntities extends Readonly<Record<string, unknown>>;
  }
    ? { readonly [TName in keyof TEntities]: EntityClient<TEntities[TName]> }
    : object);

export type HarnessClient<TPlugins extends readonly EmbodyPlugin[]> = {
  readonly [TPlugin in TPlugins[number] as TPlugin["id"]]: PluginClient<TPlugin>;
};

export type ActorOverrides = Partial<Omit<Principal, "actorId" | "actorType">>;

export interface TestHarness<TPlugins extends readonly EmbodyPlugin[] = readonly EmbodyPlugin[]> {
  readonly kernel: Kernel;
  readonly principal: Principal;
  readonly client: HarnessClient<TPlugins>;
  call(target: string, input: unknown, options?: HarnessCallOptions): Promise<unknown>;
  /** A new request view with its own principal; no mutable request context is shared. */
  as(principal: Principal): TestHarness<TPlugins>;
  asAgent(actorId: string, overrides?: ActorOverrides): TestHarness<TPlugins>;
  asHuman(actorId: string, overrides?: ActorOverrides): TestHarness<TPlugins>;
  /** Captures an expected hook veto without depending on a test framework. */
  veto(operation: () => Promise<unknown>): Promise<HookVetoError>;
  tickOutbox(): Promise<void>;
  outbox(): Promise<readonly OutboxEvent[]>;
  /** Event-oriented outbox query, optionally filtered by canonical event name. */
  events(eventName?: string): Promise<readonly OutboxEvent[]>;
  progress(requestId?: string): readonly CapturedProgress[];
  audit(): readonly ExecutionAuditEvent[];
  close(): Promise<void>;
}

function defaultPrincipal(options: TestHarnessOptions): Principal {
  if (options.principal !== undefined) return options.principal;
  const scopes = options.plugins.map((plugin) => `${plugin.id}:*`);
  return {
    orgId: options.tenantId ?? "test",
    actorId: options.actor?.actorId ?? "test-agent",
    actorType: options.actor?.actorType ?? "agent",
    roles: options.actor?.roles ?? ["operator"],
    scopes: options.actor?.scopes ?? scopes,
    ...(options.actor?.metadata === undefined ? {} : { metadata: options.actor.metadata }),
  };
}

class Harness<TPlugins extends readonly EmbodyPlugin[]> implements TestHarness<TPlugins> {
  public readonly client: HarnessClient<TPlugins>;
  public constructor(
    public readonly kernel: Kernel,
    public readonly principal: Principal,
    private readonly plugins: TPlugins,
    private readonly worker: OutboxWorker,
    private readonly storage: SqliteStorage,
    private readonly directory: string,
    private readonly capturedProgress: CapturedProgress[],
    private readonly audits: ExecutionAuditEvent[],
    private readonly requestId: () => string,
    private readonly closeRoot: () => Promise<void>,
  ) {
    this.client = this.createClient();
  }

  public async call(
    target: string,
    input: unknown,
    options: HarnessCallOptions = {},
  ): Promise<unknown> {
    const requestId = this.requestId();
    const updates: ProgressUpdate[] = [];
    try {
      return await this.kernel.execute(target, input, {
        principal: this.principal,
        requestId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        progress: (update) => updates.push(update),
        audit: (entry) => {
          this.audits.push(entry);
        },
      });
    } finally {
      this.capturedProgress.push(
        ...updates.map((update) => ({ requestId, principal: this.principal, update })),
      );
    }
  }

  public as(principal: Principal): TestHarness<TPlugins> {
    return new Harness(
      this.kernel,
      principal,
      this.plugins,
      this.worker,
      this.storage,
      this.directory,
      this.capturedProgress,
      this.audits,
      this.requestId,
      this.closeRoot,
    );
  }

  public asAgent(actorId: string, overrides: ActorOverrides = {}): TestHarness<TPlugins> {
    return this.as(this.actorPrincipal("agent", actorId, overrides));
  }
  public asHuman(actorId: string, overrides: ActorOverrides = {}): TestHarness<TPlugins> {
    return this.as(this.actorPrincipal("human", actorId, overrides));
  }
  public async veto(operation: () => Promise<unknown>): Promise<HookVetoError> {
    try {
      await operation();
    } catch (error) {
      if (error instanceof HookVetoError) return error;
      throw error;
    }
    throw new Error("Expected operation to be vetoed");
  }
  public tickOutbox(): Promise<void> {
    return this.worker.tick();
  }
  public async outbox(): Promise<readonly OutboxEvent[]> {
    return this.storage.transaction("system", (tx) => tx.outbox.list());
  }
  public async events(eventName?: string): Promise<readonly OutboxEvent[]> {
    const events = await this.outbox();
    return eventName === undefined
      ? events
      : events.filter((event) => event.eventName === eventName);
  }
  public progress(requestId?: string): readonly CapturedProgress[] {
    return requestId === undefined
      ? [...this.capturedProgress]
      : this.capturedProgress.filter((entry) => entry.requestId === requestId);
  }
  public audit(): readonly ExecutionAuditEvent[] {
    return [...this.audits];
  }
  public close(): Promise<void> {
    return this.closeRoot();
  }
  private actorPrincipal(
    actorType: "agent" | "human",
    actorId: string,
    overrides: ActorOverrides,
  ): Principal {
    return {
      orgId: overrides.orgId ?? this.principal.orgId,
      actorId,
      actorType,
      roles: overrides.roles ?? this.principal.roles,
      scopes: overrides.scopes ?? this.principal.scopes,
      ...(overrides.metadata === undefined ? {} : { metadata: overrides.metadata }),
    };
  }
  private createClient(): HarnessClient<TPlugins> {
    const entityTargets = new Set(
      this.plugins.flatMap((plugin) =>
        Object.keys(plugin.entities ?? {}).map((entity) => `${plugin.id}.${entity}`),
      ),
    );
    return new Proxy(
      {},
      {
        get: (_target, pluginId: string) =>
          new Proxy(
            {},
            {
              get: (_plugin, name: string) => {
                if (entityTargets.has(`${pluginId}.${name}`))
                  return new Proxy(
                    {},
                    {
                      get:
                        (_entity, operation: string) =>
                        (input: unknown = {}, options?: HarnessCallOptions) =>
                          this.call(`${pluginId}.${name}.${operation}`, input, options),
                    },
                  );
                return (input: unknown = {}, options?: HarnessCallOptions) =>
                  this.call(`${pluginId}.${name}`, input, options);
              },
            },
          ),
      },
    ) as HarnessClient<TPlugins>;
  }
}

/**
 * Boots the production kernel, SQLite adapter, execution pipeline, and deterministic outbox worker.
 * Each harness owns an isolated temporary directory; `close()` always stops workers, closes SQLite,
 * and removes it. See `README.md` for the warm-start benchmark methodology.
 */
export async function createTestHarness<const TPlugins extends readonly EmbodyPlugin[]>(
  options: TestHarnessOptions<TPlugins>,
): Promise<TestHarness<TPlugins>> {
  const directory = await mkdtemp(join(tmpdir(), "embody-test-"));
  const storage = new SqliteStorage({ filename: join(directory, "embody.sqlite") });
  const kernel = new Kernel({
    plugins: options.plugins,
    storage,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
    ...(options.services === undefined ? {} : { serviceOverrides: options.services }),
  });
  let closed = false;
  let worker: OutboxWorker | undefined;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await worker?.stop(0);
      await kernel.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    await kernel.boot();
    worker = new OutboxWorker({ storage, kernel, ...options.worker });
    const progress: CapturedProgress[] = [];
    const audits: ExecutionAuditEvent[] = [];
    let sequence = 0;
    return new Harness(
      kernel,
      defaultPrincipal(options),
      options.plugins,
      worker,
      storage,
      directory,
      progress,
      audits,
      () => `test-${++sequence}`,
      close,
    );
  } catch (error) {
    await close();
    throw error;
  }
}
