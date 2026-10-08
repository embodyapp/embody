import { z } from "zod";
import type {
  ActionEffect,
  EmbodyPlugin,
  EntityDefinition,
  WorkflowDefinition,
} from "./contracts.js";
import { compileWorkflow } from "./workflows.js";
import { DuplicateRegistrationError, ValidationError } from "./errors.js";
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

export type { ActionEffect } from "./contracts.js";

export interface ActionManifest {
  /** Short human-readable name, at most 80 characters. */
  readonly title?: string;
  readonly description?: string;
  /** Omitted for custom actions that did not declare one; treat as `write` (see `actionEffect`). */
  readonly effect?: ActionEffect;
  /** True when repeating the call with the same input has no additional effect. */
  readonly idempotent?: boolean;
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

/** Optional human-facing app metadata shown by MCP clients and discovery tools. */
export interface AppMetadata {
  /** At most 80 characters. */
  readonly title?: string;
  /** Plain text, at most 500 characters. */
  readonly description?: string;
  /** Plain-text usage notes for agents, at most 2,048 characters. */
  readonly instructions?: string;
}

export const APP_METADATA_LIMITS = { title: 80, description: 500, instructions: 2_048 } as const;
export const ACTION_TITLE_LIMIT = 80;

export interface AppManifest {
  readonly protocolVersion: 1;
  readonly app?: AppMetadata;
  readonly plugins: readonly { readonly id: string; readonly version: string }[];
  readonly entities: Readonly<Record<string, EntityManifest>>;
  readonly actions: Readonly<Record<string, ActionManifest>>;
  readonly workflows?: Readonly<Record<string, WorkflowManifest>>;
  readonly views?: Readonly<Record<string, ViewManifest>>;
  readonly eventSubscriptions: readonly string[];
}

/** The effective effect of an action; undeclared custom actions are treated as `write`. */
export function actionEffect(action: Pick<ActionManifest, "effect">): ActionEffect {
  return action.effect ?? "write";
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
      effect: "write",
      description: `Start ${definition.description ?? name}`,
      inputSchema: jsonSchema(
        z.object({ input: definition.input, idempotencyKey: z.string().min(1).max(200) }),
      ),
      outputSchema: jsonSchema(workflowStatusSchema),
      generated: true,
    },
    [`${prefix}.status`]: {
      effect: "read",
      description: `Get ${definition.description ?? name} status`,
      inputSchema: jsonSchema(z.object({ id: workflowId })),
      outputSchema: jsonSchema(workflowStatusSchema),
      generated: true,
    },
    [`${prefix}.cancel`]: {
      effect: "destructive",
      description: `Cancel ${definition.description ?? name}`,
      inputSchema: jsonSchema(z.object({ id: workflowId })),
      outputSchema: jsonSchema(workflowStatusSchema),
      generated: true,
    },
    [`${prefix}.retry`]: {
      effect: "write",
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
  const effects: Record<string, Pick<ActionManifest, "effect" | "idempotent">> = {
    create: { effect: "write" },
    get: { effect: "read" },
    list: { effect: "read" },
    update: { effect: "write", idempotent: true },
    delete: { effect: "destructive" },
  };
  return Object.fromEntries(
    Object.entries(schemas).map(([operation, schema]) => [
      formatTarget([pluginId, entityName, operation]),
      {
        ...(descriptions[operation] === undefined ? {} : { description: descriptions[operation] }),
        ...effects[operation],
        inputSchema: jsonSchema(schema),
        generated: true,
      },
    ]),
  );
}

export interface CompileManifestOptions {
  readonly app?: AppMetadata;
}

export function compileManifest(
  plugins: readonly EmbodyPlugin[],
  options: CompileManifestOptions = {},
): AppManifest {
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
      if (definition.title !== undefined)
        assertText("Action title", definition.title, ACTION_TITLE_LIMIT, false);
      registerAction(actions, target, {
        ...(definition.title === undefined ? {} : { title: definition.title }),
        ...(definition.description === undefined ? {} : { description: definition.description }),
        ...(definition.effect === undefined ? {} : { effect: definition.effect }),
        ...(definition.idempotent === undefined ? {} : { idempotent: definition.idempotent }),
        inputSchema: jsonSchema(definition.input),
        ...(definition.output === undefined ? {} : { outputSchema: jsonSchema(definition.output) }),
        generated: false,
      });
    }
    for (const eventName of Object.keys(plugin.events ?? {}))
      subscriptions.add(formatTarget(eventName.split(".")));
  }

  const app = appMetadata(options.app);
  return deepSort({
    protocolVersion: 1,
    ...(app === undefined ? {} : { app }),
    plugins: plugins
      .map(({ id, version }) => ({ id, version }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    entities,
    actions,
    workflows,
    eventSubscriptions: [...subscriptions].sort(),
  }) as AppManifest;
}

// Control characters other than newline and tab, plus bidirectional overrides.
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point.
const UNSAFE_TEXT = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

function assertText(label: string, value: unknown, max: number, multiline: boolean): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    UNSAFE_TEXT.test(value) ||
    (!multiline && /[\n\t]/.test(value))
  )
    throw new ValidationError(`${label} must be non-empty plain text of at most ${max} characters`);
}

function appMetadata(value: AppMetadata | undefined): AppMetadata | undefined {
  if (value === undefined) return undefined;
  const result: { title?: string; description?: string; instructions?: string } = {};
  if (value.title !== undefined) {
    assertText("App title", value.title, APP_METADATA_LIMITS.title, false);
    result.title = value.title;
  }
  if (value.description !== undefined) {
    assertText("App description", value.description, APP_METADATA_LIMITS.description, true);
    result.description = value.description;
  }
  if (value.instructions !== undefined) {
    assertText("App instructions", value.instructions, APP_METADATA_LIMITS.instructions, true);
    result.instructions = value.instructions;
  }
  return Object.keys(result).length === 0 ? undefined : result;
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
