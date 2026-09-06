import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  EmbodyPlugin,
  Principal,
  WorkflowDefinition,
  WorkflowStepDefinition,
} from "./contracts.js";
import { DuplicateRegistrationError, ValidationError } from "./errors.js";
import { stableStringify } from "./manifest.js";
import { formatTarget } from "./target.js";

export const workflowStepName = /^[a-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$/;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const WORKFLOW_VALUE_LIMIT = 256 * 1024;

export interface CompiledWorkflow {
  readonly target: string;
  readonly pluginId: string;
  readonly name: string;
  readonly definition: WorkflowDefinition;
  readonly order: readonly string[];
  readonly resultStep: string;
}

export interface WorkflowInstanceRecord {
  readonly id: string;
  readonly orgId: string;
  readonly definition: string;
  readonly definitionVersion: string;
  readonly idempotencyKey: string;
  readonly inputHash: string;
  readonly input: unknown;
  readonly principal: Principal;
  readonly status: string;
  readonly output?: unknown;
  readonly error?: string;
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly optimisticVersion: number;
}
export interface WorkflowStepRecord {
  readonly id: string;
  readonly instanceId: string;
  readonly orgId: string;
  readonly name: string;
  readonly status: string;
  readonly dependencies: readonly string[];
  readonly attempt: number;
  readonly scheduledAt: string;
  readonly compensatable: boolean;
  readonly output?: unknown;
  readonly error?: string;
  readonly claimedAt?: string;
  readonly claimedBy?: string;
}
export interface WorkflowSnapshot extends WorkflowInstanceRecord {
  readonly steps: readonly WorkflowStepRecord[];
}

export interface WorkflowRepositoryPort {
  start(input: {
    readonly id: string;
    readonly orgId: string;
    readonly definition: string;
    readonly definitionVersion: string;
    readonly idempotencyKey: string;
    readonly inputHash: string;
    readonly input: unknown;
    readonly principal: Principal;
    readonly now: string;
    readonly steps: readonly {
      readonly id: string;
      readonly name: string;
      readonly dependencies: readonly string[];
      readonly scheduledAt: string;
      readonly compensatable: boolean;
    }[];
  }): Promise<{ readonly instance: WorkflowInstanceRecord; readonly created: boolean }>;
  get(id: string): Promise<WorkflowSnapshot | null>;
  cancel(id: string, now: string): Promise<WorkflowSnapshot | null>;
  retry(id: string, now: string): Promise<WorkflowSnapshot | null>;
  claimBatch(options: {
    readonly limit: number;
    readonly workerId: string;
    readonly now: string;
    readonly leaseMs?: number;
  }): Promise<readonly WorkflowStepRecord[]>;
  completeStep(input: {
    readonly id: string;
    readonly output: unknown;
    readonly now: string;
    readonly resultStep: boolean;
  }): Promise<void>;
  failStep(input: {
    readonly id: string;
    readonly error: string;
    readonly retryAt?: string;
    readonly terminal: boolean;
    readonly now: string;
  }): Promise<void>;
}

export function compileWorkflow(
  pluginId: string,
  name: string,
  definition: WorkflowDefinition,
): CompiledWorkflow {
  if (!workflowStepName.test(name)) throw new ValidationError(`Invalid workflow name: ${name}`);
  if (!semver.test(definition.version))
    throw new ValidationError(`Invalid workflow version: ${pluginId}.${name}`);
  if (!(definition.input instanceof z.ZodType))
    throw new ValidationError(`Workflow ${pluginId}.${name} requires an input schema`);
  if (definition.output !== undefined && !(definition.output instanceof z.ZodType))
    throw new ValidationError(`Workflow ${pluginId}.${name} has an invalid output schema`);
  const names = Object.keys(definition.steps);
  if (names.length === 0) throw new ValidationError(`Workflow ${pluginId}.${name} has no steps`);
  for (const stepName of names) {
    if (!workflowStepName.test(stepName))
      throw new ValidationError(`Invalid workflow step: ${stepName}`);
    const step = definition.steps[stepName]!;
    if (typeof step.handler !== "function")
      throw new ValidationError(`Workflow step ${stepName} has no handler`);
    const retry = step.retry ?? { maxAttempts: 1, backoffMs: 1_000 };
    if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1 || retry.maxAttempts > 100)
      throw new ValidationError(`Workflow step ${stepName} has invalid maxAttempts`);
    if (retry.backoffMs !== undefined && (!Number.isFinite(retry.backoffMs) || retry.backoffMs < 0))
      throw new ValidationError(`Workflow step ${stepName} has invalid backoffMs`);
    if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0))
      throw new ValidationError(`Workflow step ${stepName} has invalid timeoutMs`);
    if (step.delayMs !== undefined && (!Number.isFinite(step.delayMs) || step.delayMs < 0))
      throw new ValidationError(`Workflow step ${stepName} has invalid delayMs`);
    const dependencies = step.dependsOn ?? [];
    if (new Set(dependencies).size !== dependencies.length)
      throw new ValidationError(`Workflow step ${stepName} has duplicate dependencies`);
    for (const dependency of dependencies)
      if (!(dependency in definition.steps))
        throw new ValidationError(
          `Workflow step ${stepName} depends on missing step ${dependency}`,
        );
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (stepName: string, path: readonly string[]): void => {
    if (visited.has(stepName)) return;
    if (visiting.has(stepName))
      throw new ValidationError(`Workflow cycle: ${[...path, stepName].join(" -> ")}`);
    visiting.add(stepName);
    for (const dependency of [...(definition.steps[stepName]!.dependsOn ?? [])].sort())
      visit(dependency, [...path, stepName]);
    visiting.delete(stepName);
    visited.add(stepName);
    order.push(stepName);
  };
  for (const stepName of [...names].sort()) visit(stepName, []);
  const sinks = names.filter(
    (candidate) => !names.some((other) => definition.steps[other]!.dependsOn?.includes(candidate)),
  );
  const resultStep = definition.resultStep ?? (sinks.length === 1 ? sinks[0] : undefined);
  if (resultStep === undefined || !(resultStep in definition.steps))
    throw new ValidationError(`Workflow ${pluginId}.${name} requires a valid resultStep`);
  return {
    target: formatTarget([pluginId, name]),
    pluginId,
    name,
    definition,
    order,
    resultStep,
  };
}

export function compileWorkflows(plugins: readonly EmbodyPlugin[]): readonly CompiledWorkflow[] {
  const result: CompiledWorkflow[] = [];
  const targets = new Set<string>();
  for (const plugin of plugins)
    for (const [name, definition] of Object.entries(plugin.workflows ?? {})) {
      const compiled = compileWorkflow(plugin.id, name, definition);
      if (targets.has(compiled.target))
        throw new DuplicateRegistrationError(`Duplicate workflow: ${compiled.target}`);
      targets.add(compiled.target);
      result.push(compiled);
    }
  return result.sort((left, right) => left.target.localeCompare(right.target));
}

export function safeWorkflowValue(value: unknown, label: string): unknown {
  let encoded: string;
  try {
    encoded = stableStringify(value);
  } catch {
    throw new ValidationError(`${label} must be JSON serializable`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > WORKFLOW_VALUE_LIMIT)
    throw new ValidationError(`${label} exceeds ${WORKFLOW_VALUE_LIMIT} bytes`);
  return JSON.parse(encoded) as unknown;
}

export function workflowInputHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stepDefinition(workflow: CompiledWorkflow, name: string): WorkflowStepDefinition {
  const step = workflow.definition.steps[name];
  if (step === undefined) throw new ValidationError(`Unknown workflow step: ${name}`);
  return step;
}
