import type { z } from "zod";

export type ActorType = "agent" | "human" | "system";

export interface Principal {
  readonly orgId: string;
  readonly actorId: string;
  readonly actorType: ActorType;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EntityRecord<TData = Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly orgId: string;
  readonly entityType: string;
  readonly data: TData;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EntityListOptions<TData> {
  readonly filter?: Partial<TData>;
  readonly sort?: { readonly field: keyof TData & string; readonly direction: "asc" | "desc" };
  readonly limit?: number;
  readonly offset?: number;
}

export interface EntityBulkUpdate<TData> {
  readonly id: string;
  readonly data: Partial<TData>;
}

export interface EntityStoreAccessor<TData = Record<string, unknown>> {
  create(data: TData): Promise<EntityRecord<TData>>;
  get(id: string): Promise<EntityRecord<TData>>;
  /** Returns records in input order. Empty input is allowed; any missing record rejects the call. */
  getMany(ids: readonly string[]): Promise<readonly EntityRecord<TData>[]>;
  list(options?: EntityListOptions<TData>): Promise<readonly EntityRecord<TData>[]>;
  update(id: string, data: Partial<TData>): Promise<EntityRecord<TData>>;
  /** Updates at least one unique ID atomically in input order using normal hooks and events. */
  updateMany(updates: readonly EntityBulkUpdate<TData>[]): Promise<readonly EntityRecord<TData>[]>;
  delete(id: string): Promise<EntityRecord<TData>>;
}

export interface ProgressUpdate {
  readonly percent?: number;
  readonly message: string;
}

/** Per-request controls for the transport-neutral action execution pipeline. */
export interface ExecutionOptions {
  readonly principal: Principal;
  readonly requestId?: string;
  readonly traceparent?: string;
  readonly signal?: AbortSignal;
  readonly progress?: (update: ProgressUpdate) => void;
  readonly audit?: (event: ExecutionAuditEvent) => void | Promise<void>;
}

export interface ExecutionAuditEvent {
  readonly target: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly requestId?: string;
  readonly traceparent?: string;
  readonly durationMs: number;
  readonly outcome: "success" | "failure" | "cancelled";
  readonly errorCode?: string;
}

export interface KernelServices {
  get<T = unknown>(serviceKey: string): T;
}

declare const kernelContextBrand: unique symbol;

export interface KernelContext {
  /** @internal Constructed only by the kernel runtime. */
  readonly [kernelContextBrand]: true;
  readonly principal: Principal;
  readonly orgId: string;
  readonly requestId?: string;
  readonly traceparent?: string;
  readonly signal?: AbortSignal;
  readonly entities: Readonly<Record<string, EntityStoreAccessor<never>>>;
  readonly services: KernelServices;
  readonly events: {
    publish<T = unknown>(eventName: string, payload: T): Promise<void>;
  };
  progress(update: ProgressUpdate): void;
  can(action: string, resource?: string): Promise<boolean> | boolean;
}

export interface EntityDefinition<TSchema extends z.ZodObject = z.ZodObject> {
  readonly description?: string;
  readonly schema: TSchema;
  readonly indexes?: readonly (keyof z.output<TSchema> & string)[];
  readonly defaultSort?: {
    readonly field: keyof z.output<TSchema> & string;
    readonly direction: "asc" | "desc";
  };
}

export type ActionInput<TInput extends z.ZodType> = z.ZodType extends TInput
  ? never
  : z.output<TInput>;
export type ActionResult<TOutput extends z.ZodType | undefined> = TOutput extends z.ZodType
  ? z.output<TOutput>
  : unknown;

export type ActionHandler<TInput extends z.ZodType, TOutput extends z.ZodType | undefined> = (
  input: ActionInput<TInput>,
  ctx: KernelContext,
) => Promise<ActionResult<TOutput>> | ActionResult<TOutput>;

export interface ActionDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType | undefined = z.ZodType | undefined,
> {
  readonly description?: string;
  readonly input: TInput;
  readonly output?: TOutput;
  readonly handler: ActionHandler<TInput, TOutput>;
}

export type HookHandler<TPayload = unknown> = (
  payload: TPayload,
  ctx: KernelContext,
) => Promise<void> | void;

export interface DomainEvent<TPayload = unknown> {
  readonly id: string;
  readonly name: string;
  readonly orgId: string;
  readonly payload: TPayload;
  readonly occurredAt: string;
}

export type EventHandler<TPayload = unknown> = (
  event: DomainEvent<TPayload>,
  ctx: KernelContext,
) => Promise<void> | void;

export interface WorkflowDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType | undefined = z.ZodType | undefined,
> {
  readonly description?: string;
  readonly input: TInput;
  readonly output?: TOutput;
  readonly steps: Readonly<Record<string, unknown>>;
}

export interface EmbodyPlugin<
  TConfig = unknown,
  TEntities extends Readonly<Record<string, EntityDefinition>> = Readonly<
    Record<string, EntityDefinition>
  >,
  TActions extends Readonly<Record<string, ActionDefinition>> = Readonly<
    Record<string, ActionDefinition>
  >,
> {
  readonly id: string;
  readonly version: string;
  readonly dependsOn?: readonly string[];
  readonly config?: TConfig;
  readonly services?: (ctx: KernelContext) => Readonly<Record<string, unknown>>;
  readonly entities?: TEntities;
  readonly actions?: TActions;
  readonly hooks?: Readonly<Record<string, HookHandler>>;
  readonly workflows?: Readonly<Record<string, WorkflowDefinition>>;
  readonly events?: Readonly<Record<string, EventHandler>>;
  readonly init?: (ctx: KernelContext) => Promise<void> | void;
}

export type CheckedActionDefinition<TAction> = TAction extends {
  readonly input: infer TInput extends z.ZodType;
  readonly output?: infer TOutput extends z.ZodType;
}
  ? TAction & {
      readonly handler: (
        input: z.output<TInput>,
        ctx: KernelContext,
      ) => Promise<z.output<TOutput>> | z.output<TOutput>;
    }
  : TAction extends { readonly input: infer TInput extends z.ZodType }
    ? TAction & {
        readonly handler: (input: z.output<TInput>, ctx: KernelContext) => unknown;
      }
    : never;

export type CheckedPluginDefinition<TPlugin> = TPlugin extends {
  readonly actions: infer TActions extends Readonly<Record<string, unknown>>;
}
  ? {
      readonly actions: {
        readonly [TName in keyof TActions]: CheckedActionDefinition<TActions[TName]>;
      };
    }
  : unknown;

export function definePlugin<const TPlugin extends EmbodyPlugin>(
  plugin: TPlugin & CheckedPluginDefinition<TPlugin>,
): TPlugin {
  return plugin;
}
