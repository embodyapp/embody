import { z } from "zod";

import type {
  ActionDefinition,
  EntityDefinition,
  EntityListOptions,
  EntityRecord,
  EntityStoreAccessor,
  KernelContext,
} from "./contracts.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { formatTarget } from "./target.js";
import type { WorkflowRepositoryPort } from "./workflows.js";

/** The portion of a storage transaction used by contextual entity stores. */
export interface EntityLifecycle {
  beforeCreate?(payload: unknown): Promise<void>;
  afterCreate?(payload: unknown): Promise<void>;
  beforeUpdate?(payload: unknown): Promise<void>;
  afterUpdate?(payload: unknown): Promise<void>;
  beforeDelete?(payload: unknown): Promise<void>;
  afterDelete?(payload: unknown): Promise<void>;
  publish?(eventName: string, payload: unknown): Promise<void>;
}

export interface EntityTransaction {
  readonly entities: {
    create<TData>(
      orgId: string,
      entityType: string,
      input: { readonly data: TData },
    ): Promise<EntityRecord<TData>>;
    get<TData>(orgId: string, entityType: string, id: string): Promise<EntityRecord<TData> | null>;
    list<TData>(
      orgId: string,
      entityType: string,
      options?: {
        readonly filter?: Readonly<Record<string, unknown>>;
        readonly sort?: { readonly field: string; readonly direction: "asc" | "desc" };
        readonly limit?: number;
        readonly offset?: number;
      },
    ): Promise<readonly EntityRecord<TData>[]>;
    update<TData>(
      orgId: string,
      entityType: string,
      id: string,
      update: { readonly data: TData; readonly expectedUpdatedAt?: string },
    ): Promise<EntityRecord<TData> | null>;
    delete<TData>(
      orgId: string,
      entityType: string,
      id: string,
    ): Promise<EntityRecord<TData> | null>;
  };
  readonly outbox?: {
    enqueue(
      orgId: string,
      input: {
        readonly id?: string;
        readonly eventName: string;
        readonly payload: unknown;
        readonly occurredAt?: string;
        readonly correlationId?: string;
        readonly causationId?: string;
        readonly producerPluginId?: string;
        readonly schemaVersion?: string;
      },
    ): Promise<unknown>;
  };
  readonly workflows?: WorkflowRepositoryPort;
  readonly inbox?: {
    reserve(eventId: string, handlerId: string): Promise<{ readonly state: string }>;
    complete(eventId: string, handlerId: string): Promise<void>;
    fail(eventId: string, handlerId: string, error: string): Promise<void>;
  };
  /** Runtime lifecycle supplied by the kernel; omitted for standalone stores. */
  readonly lifecycle?: EntityLifecycle;
}

export interface CompiledEntity<TData extends Record<string, unknown> = Record<string, unknown>> {
  readonly target: string;
  readonly entityType: string;
  readonly definition: EntityDefinition<z.ZodObject>;
  createStore(orgId: string, transaction: EntityTransaction): EntityStoreAccessor<TData>;
}

function validationFromZod(error: z.ZodError): ValidationError {
  return new ValidationError(
    "Entity data is invalid",
    error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })),
  );
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw validationFromZod(result.error);
}

function objectShape(schema: z.ZodType): Readonly<Record<string, z.ZodType>> | undefined {
  if (schema instanceof z.ZodObject) return schema.shape;
  const definition = schema._zod.def as { readonly type?: string; readonly innerType?: z.ZodType };
  if (
    definition.type === "optional" ||
    definition.type === "nullable" ||
    definition.type === "default"
  )
    return definition.innerType === undefined ? undefined : objectShape(definition.innerType);
  return undefined;
}

function validateFilter(
  filter: Readonly<Record<string, unknown>>,
  schema: z.ZodType,
  path: readonly string[] = [],
): void {
  const shape = objectShape(schema);
  if (shape === undefined)
    throw new ValidationError("Filter path is not declared", [
      { path, message: "Expected an object field" },
    ]);
  for (const [key, value] of Object.entries(filter)) {
    const field = shape[key];
    const fieldPath = [...path, key];
    if (field === undefined)
      throw new ValidationError("Filter path is not declared", [
        { path: fieldPath, message: "Unknown field" },
      ]);
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      validateFilter(value as Readonly<Record<string, unknown>>, field, fieldPath);
  }
}

function validateListOptions<TData extends Record<string, unknown>>(
  options: EntityListOptions<TData>,
  schema: z.ZodObject,
  defaultSort: EntityDefinition["defaultSort"],
): {
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly sort?: { readonly field: string; readonly direction: "asc" | "desc" };
  readonly limit: number;
  readonly offset: number;
} {
  const filter = options.filter as Readonly<Record<string, unknown>> | undefined;
  if (filter !== undefined) validateFilter(filter, schema);
  const sort = options.sort ?? defaultSort;
  if (sort !== undefined && schema.shape[sort.field] === undefined)
    throw new ValidationError("Sort field is not declared", [
      { path: ["sort", "field"], message: "Unknown field" },
    ]);
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ValidationError("Limit must be an integer from 1 to 100", [
      { path: ["limit"], message: "Out of range" },
    ]);
  if (!Number.isInteger(offset) || offset < 0)
    throw new ValidationError("Offset must be a non-negative integer", [
      { path: ["offset"], message: "Out of range" },
    ]);
  return {
    ...(filter === undefined ? {} : { filter }),
    ...(sort === undefined ? {} : { sort }),
    limit,
    offset,
  };
}

class Store<TData extends Record<string, unknown>> implements EntityStoreAccessor<TData> {
  public constructor(
    private readonly entity: CompiledEntity<TData>,
    private readonly orgId: string,
    private readonly transaction: EntityTransaction,
  ) {}

  public async create(data: TData): Promise<EntityRecord<TData>> {
    const normalized = parse(this.entity.definition.schema, data) as TData;
    await this.transaction.lifecycle?.beforeCreate?.({ data: normalized });
    const created = await this.transaction.entities.create(this.orgId, this.entity.entityType, {
      data: normalized,
    });
    await this.transaction.lifecycle?.afterCreate?.({ record: created });
    await this.transaction.lifecycle?.publish?.(`${this.entity.target}.created`, created);
    return created;
  }
  public async get(id: string): Promise<EntityRecord<TData>> {
    const record = await this.transaction.entities.get<TData>(
      this.orgId,
      this.entity.entityType,
      id,
    );
    if (record === null) throw new NotFoundError("Entity was not found");
    return record;
  }
  public async getMany(ids: readonly string[]): Promise<readonly EntityRecord<TData>[]> {
    return Promise.all(ids.map((id) => this.get(id)));
  }
  public async list(
    options: EntityListOptions<TData> = {},
  ): Promise<readonly EntityRecord<TData>[]> {
    return this.transaction.entities.list<TData>(
      this.orgId,
      this.entity.entityType,
      validateListOptions(
        options,
        this.entity.definition.schema,
        this.entity.definition.defaultSort,
      ),
    );
  }
  public async update(id: string, patch: Partial<TData>): Promise<EntityRecord<TData>> {
    const current = await this.get(id);
    const data = this.validateUpdate(current, patch);
    return this.applyUpdate(current, patch, data);
  }
  public async updateMany(
    updates: readonly { readonly id: string; readonly data: Partial<TData> }[],
  ): Promise<readonly EntityRecord<TData>[]> {
    if (updates.length === 0)
      throw new ValidationError("Bulk entity update must contain at least one item");
    if (new Set(updates.map(({ id }) => id)).size !== updates.length)
      throw new ValidationError("Bulk entity update IDs must be unique");

    // Resolve ownership/existence and validate every merged record before the first mutation.
    const current = await this.getMany(updates.map(({ id }) => id));
    const data = updates.map((update, index) => this.validateUpdate(current[index]!, update.data));
    const result: EntityRecord<TData>[] = [];
    for (let index = 0; index < updates.length; index++)
      result.push(await this.applyUpdate(current[index]!, updates[index]!.data, data[index]!));
    return result;
  }
  private validateUpdate(current: EntityRecord<TData>, patch: Partial<TData>): TData {
    if (Object.keys(patch).length === 0)
      throw new ValidationError("Entity patch must not be empty");
    return parse(this.entity.definition.schema, { ...current.data, ...patch }) as TData;
  }
  private async applyUpdate(
    current: EntityRecord<TData>,
    patch: Partial<TData>,
    data: TData,
  ): Promise<EntityRecord<TData>> {
    await this.transaction.lifecycle?.beforeUpdate?.({ current, patch });
    const updated = await this.transaction.entities.update<TData>(
      this.orgId,
      this.entity.entityType,
      current.id,
      { data, expectedUpdatedAt: current.updatedAt },
    );
    if (updated === null) throw new NotFoundError("Entity was not found");
    await this.transaction.lifecycle?.afterUpdate?.({ current, updated });
    await this.transaction.lifecycle?.publish?.(`${this.entity.target}.updated`, updated);
    return updated;
  }
  public async delete(id: string): Promise<EntityRecord<TData>> {
    const current = await this.get(id);
    await this.transaction.lifecycle?.beforeDelete?.({ current });
    const deleted = await this.transaction.entities.delete<TData>(
      this.orgId,
      this.entity.entityType,
      id,
    );
    if (deleted === null) throw new NotFoundError("Entity was not found");
    await this.transaction.lifecycle?.afterDelete?.({ deleted });
    await this.transaction.lifecycle?.publish?.(`${this.entity.target}.deleted`, deleted);
    return deleted;
  }
}

export function generatedEntityActions(
  entity: CompiledEntity,
): Readonly<Record<string, ActionDefinition>> {
  const id = z.uuid();
  const list = z.object({
    filter: z.record(z.string(), z.unknown()).optional(),
    sort: z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) }).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  });
  const store = (context: KernelContext): EntityStoreAccessor => {
    const value = context.entities[entity.entityType];
    if (value === undefined)
      throw new ValidationError(`Entity store is unavailable: ${entity.target}`);
    return value;
  };
  return {
    create: {
      input: z.object({ data: entity.definition.schema }),
      handler: ({ data }, context) => store(context).create(data),
    },
    get: {
      input: z.object({ id }),
      handler: ({ id: recordId }, context) => store(context).get(recordId),
    },
    list: { input: list, handler: (input, context) => store(context).list(input) },
    update: {
      input: z.object({ id, data: entity.definition.schema.partial() }),
      handler: ({ id: recordId, data }, context) => store(context).update(recordId, data),
    },
    delete: {
      input: z.object({ id }),
      handler: ({ id: recordId }, context) => store(context).delete(recordId),
    },
  };
}

export function compileEntity<TData extends Record<string, unknown>>(
  pluginId: string,
  entityType: string,
  definition: EntityDefinition<z.ZodObject>,
): CompiledEntity<TData> {
  const target = formatTarget([pluginId, entityType]);
  if (!(definition.schema instanceof z.ZodObject))
    throw new ValidationError(`Entity ${target} schema must be a Zod object`);
  for (const index of definition.indexes ?? [])
    if (definition.schema.shape[index] === undefined)
      throw new ValidationError(`Entity ${target} index is not a declared field: ${index}`);
  if (
    definition.defaultSort !== undefined &&
    definition.schema.shape[definition.defaultSort.field] === undefined
  )
    throw new ValidationError(
      `Entity ${target} default sort is not a declared field: ${definition.defaultSort.field}`,
    );
  const compiled: CompiledEntity<TData> = {
    target,
    entityType,
    definition,
    createStore: (orgId, transaction) => new Store(compiled, orgId, transaction),
  };
  return compiled;
}
