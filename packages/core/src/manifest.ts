import { z } from "zod";
import type { EmbodyPlugin, EntityDefinition, WorkflowDefinition } from "./contracts.js";
import { compileWorkflow } from "./workflows.js";
import { DuplicateRegistrationError } from "./errors.js";
import { formatTarget } from "./target.js";

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface EntityManifest {
  readonly description?: string;
  readonly schema: JsonSchema;
  readonly indexes: readonly string[];
  readonly defaultSort?: { readonly field: string; readonly direction: "asc" | "desc" };
}

export interface ActionPresentationManifest {
  readonly view: string;
}

export interface ActionManifest {
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly generated: boolean;
  readonly presentation?: ActionPresentationManifest;
}

export type ViewFallback = "markdown" | "text" | "json";

/** Transport-neutral metadata for one immutable human-facing action-result view. */
export interface ViewManifest {
  readonly protocolVersion: 1;
  readonly id: string;
  readonly kind: "standard" | "custom";
  readonly description?: string;
  readonly propsSchema: JsonSchema;
  readonly resourceUri: string;
  readonly version: string;
  readonly callableTargets: readonly string[];
  readonly fallback: ViewFallback;
  readonly integrity: string;
}

export interface WorkflowManifest {
  readonly description?: string;
  readonly version: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly steps: readonly { readonly name: string; readonly dependsOn: readonly string[] }[];
  readonly controls: Readonly<Record<"start" | "status" | "cancel" | "retry", string>>;
}

export interface AppManifest {
  readonly protocolVersion: 1;
  readonly plugins: readonly { readonly id: string; readonly version: string }[];
  readonly entities: Readonly<Record<string, EntityManifest>>;
  readonly actions: Readonly<Record<string, ActionManifest>>;
  readonly workflows?: Readonly<Record<string, WorkflowManifest>>;
  readonly views?: Readonly<Record<string, ViewManifest>>;
  readonly eventSubscriptions: readonly string[];
}

function jsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: "draft-7", reused: "inline" });
}

const workflowId = z.uuid();
const workflowStatusSchema = z.object({
  id: workflowId,
  definition: z.string(),
  definitionVersion: z.string(),
  status: z.string(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  steps: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      attempt: z.number(),
      scheduledAt: z.string(),
      output: z.unknown().optional(),
      error: z.string().optional(),
    }),
  ),
});
function workflowActions(
  pluginId: string,
  name: string,
  definition: WorkflowDefinition,
): Record<string, ActionManifest> {
  const prefix = formatTarget([pluginId, name]);
  return {
    [`${prefix}.start`]: {
      description: `Start ${definition.description ?? name}`,
      inputSchema: jsonSchema(
        z.object({ input: definition.input, idempotencyKey: z.string().min(1).max(200) }),
      ),
      outputSchema: jsonSchema(workflowStatusSchema),
      generated: true,
    },
    [`${prefix}.status`]: {
      description: `Get ${definition.description ?? name} status`,
      inputSchema: jsonSchema(z.object({ id: workflowId })),
      outputSchema: jsonSchema(workflowStatusSchema),
      generated: true,
    },
    [`${prefix}.cancel`]: {
      description: `Cancel ${definition.description ?? name}`,
      inputSchema: jsonSchema(z.object({ id: workflowId })),
      outputSchema: jsonSchema(workflowStatusSchema),
      generated: true,
    },
    [`${prefix}.retry`]: {
      description: `Retry ${definition.description ?? name}`,
      inputSchema: jsonSchema(z.object({ id: workflowId })),
      outputSchema: jsonSchema(workflowStatusSchema),
      generated: true,
    },
  };
}

function generatedActions(
  pluginId: string,
  entityName: string,
  definition: EntityDefinition,
): Record<string, ActionManifest> {
  const id = z.uuid();
  const list = z.object({
    filter: z.record(z.string(), z.unknown()).optional(),
    sort: z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) }).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  });
  const descriptions: Record<string, string> = {
    create: `Create ${definition.description ?? entityName}`,
    get: `Get ${definition.description ?? entityName}`,
    list: `List ${definition.description ?? entityName}`,
    update: `Update ${definition.description ?? entityName}`,
    delete: `Delete ${definition.description ?? entityName}`,
  };
  const schemas: Record<string, z.ZodType> = {
    create: z.object({ data: definition.schema }),
    get: z.object({ id }),
    list,
    update: z.object({ id, data: definition.schema.partial() }),
    delete: z.object({ id }),
  };
  return Object.fromEntries(
    Object.entries(schemas).map(([operation, schema]) => [
      formatTarget([pluginId, entityName, operation]),
      {
        ...(descriptions[operation] === undefined ? {} : { description: descriptions[operation] }),
        inputSchema: jsonSchema(schema),
        generated: true,
      },
    ]),
  );
}

export function compileManifest(plugins: readonly EmbodyPlugin[]): AppManifest {
  const entities: Record<string, EntityManifest> = {};
  const actions: Record<string, ActionManifest> = {};
  const workflows: Record<string, WorkflowManifest> = {};
  const subscriptions = new Set<string>();
  const pluginIds = new Set<string>();

  for (const plugin of plugins) {
    if (pluginIds.has(plugin.id))
      throw new DuplicateRegistrationError(`Duplicate plugin: ${plugin.id}`);
    pluginIds.add(plugin.id);
    for (const [name, definition] of Object.entries(plugin.entities ?? {})) {
      const target = formatTarget([plugin.id, name]);
      if (entities[target] !== undefined)
        throw new DuplicateRegistrationError(`Duplicate entity: ${target}`);
      entities[target] = {
        ...(definition.description === undefined ? {} : { description: definition.description }),
        schema: jsonSchema(definition.schema),
        indexes: [...(definition.indexes ?? [])].sort(),
        ...(definition.defaultSort === undefined ? {} : { defaultSort: definition.defaultSort }),
      };
      for (const [actionTarget, action] of Object.entries(
        generatedActions(plugin.id, name, definition),
      )) {
        registerAction(actions, actionTarget, action);
      }
    }
    for (const [name, definition] of Object.entries(plugin.workflows ?? {})) {
      const compiled = compileWorkflow(plugin.id, name, definition);
      workflows[compiled.target] = {
        ...(definition.description === undefined ? {} : { description: definition.description }),
        version: definition.version,
        inputSchema: jsonSchema(definition.input),
        ...(definition.output === undefined ? {} : { outputSchema: jsonSchema(definition.output) }),
        steps: compiled.order.map((stepName) => ({
          name: stepName,
          dependsOn: [...(definition.steps[stepName]!.dependsOn ?? [])].sort(),
        })),
        controls: {
          start: `${compiled.target}.start`,
          status: `${compiled.target}.status`,
          cancel: `${compiled.target}.cancel`,
          retry: `${compiled.target}.retry`,
        },
      };
      for (const [target, action] of Object.entries(workflowActions(plugin.id, name, definition)))
        registerAction(actions, target, action);
    }
    for (const [name, definition] of Object.entries(plugin.actions ?? {})) {
      const target = formatTarget([plugin.id, name]);
      registerAction(actions, target, {
        ...(definition.description === undefined ? {} : { description: definition.description }),
        inputSchema: jsonSchema(definition.input),
        ...(definition.output === undefined ? {} : { outputSchema: jsonSchema(definition.output) }),
        generated: false,
      });
    }
    for (const eventName of Object.keys(plugin.events ?? {}))
      subscriptions.add(formatTarget(eventName.split(".")));
  }

  return deepSort({
    protocolVersion: 1,
    plugins: plugins
      .map(({ id, version }) => ({ id, version }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    entities,
    actions,
    workflows,
    eventSubscriptions: [...subscriptions].sort(),
  }) as AppManifest;
}

function registerAction(
  actions: Record<string, ActionManifest>,
  target: string,
  action: ActionManifest,
): void {
  if (actions[target] !== undefined)
    throw new DuplicateRegistrationError(`Duplicate action: ${target}`);
  actions[target] = action;
}

function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, deepSort(child)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(deepSort(value));
}
