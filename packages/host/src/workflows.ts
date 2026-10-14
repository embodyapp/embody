import { randomUUID } from "node:crypto";
import { drain } from "./drain.js";
import {
  ForbiddenError,
  NonRetryableWorkflowError,
  type Kernel,
  type WorkflowSnapshot,
  type WorkflowStepRecord,
} from "@embody/core";
import type { Clock } from "./events.js";
import type { StorageConnection, WorkflowStepClaim } from "@embody/storage";

export interface WorkflowWorkerOptions {
  readonly storage: StorageConnection;
  readonly kernel: Kernel;
  readonly workerId?: string;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly intervalMs?: number;
  readonly leaseMs?: number;
  readonly clock?: Clock;
  /** Caps every step together with its own `timeoutMs`. Unbounded by default (reference mode). */
  readonly stepDeadlineMs?: number;
  /** How often a running step checks for cancellation; 0 disables. Defaults to one second. */
  readonly cancelPollMs?: number;
}

/**
 * Claims persisted DAG steps. Handlers are at-least-once and therefore must make side effects
 * idempotent. Claims cross tenants through the storage claim function; each step is then locked
 * and run in its own tenant transaction, fenced by its claim, so a lost lease never runs twice
 * concurrently and a step never starts after its instance's cancellation commits.
 */
export class WorkflowWorker {
  private readonly workerId: string;
  private readonly clock: Clock;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private readonly active = new Set<Promise<void>>();
  public constructor(private readonly options: WorkflowWorkerOptions) {
    this.workerId = options.workerId ?? randomUUID();
    this.clock = options.clock ?? { now: () => new Date() };
    if (!Number.isInteger(options.batchSize ?? 50) || (options.batchSize ?? 50) < 1)
      throw new RangeError("Workflow batch size must be positive");
  }
  public start(): Promise<void> {
    if (this.timer === undefined) {
      this.stopping = false;
      this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 500);
    }
    return Promise.resolve();
  }
  public async stop(deadlineMs = 30_000): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await drain(this.active, deadlineMs);
  }
  public async tick(): Promise<void> {
    if (this.stopping) return;
    const claimed = await this.options.storage.transaction("system", (tx) =>
      tx.workflows.claimDue({
        limit: this.options.batchSize ?? 50,
        workerId: this.workerId,
        now: this.clock.now().toISOString(),
        ...(this.options.leaseMs === undefined ? {} : { leaseMs: this.options.leaseMs }),
      }),
    );
    let cursor = 0;
    const run = async (): Promise<void> => {
      while (!this.stopping) {
        const step = claimed[cursor++];
        if (step === undefined) return;
        const task = this.process(step);
        this.active.add(task);
        try {
          await task;
        } finally {
          this.active.delete(task);
        }
      }
    };
    const concurrency =
      this.options.storage.dialect === "sqlite" ? 1 : (this.options.concurrency ?? 4);
    await Promise.all(Array.from({ length: Math.min(concurrency, claimed.length) }, run));
  }
  private async process(claim: WorkflowStepClaim): Promise<void> {
    await this.options.storage.transaction(claim.orgId, async (tx) => {
      const step = (await tx.workflows.lockClaim(claim)) as WorkflowStepRecord | null;
      if (step === null) return;
      const snapshot = (await tx.workflows.get(step.instanceId)) as WorkflowSnapshot | null;
      if (snapshot === null) return;
      if (snapshot.cancelRequested && step.status === "running") {
        await tx.workflows.releaseCancelled({ id: step.id, now: this.clock.now().toISOString() });
        return;
      }
      const controller = new AbortController();
      const watch =
        step.status === "running"
          ? this.watchCancellation(claim.orgId, snapshot.id, controller)
          : undefined;
      try {
        const output = await this.options.kernel.executeWorkflowStep(step, snapshot, tx, {
          signal: controller.signal,
          ...(this.options.stepDeadlineMs === undefined
            ? {}
            : { deadlineMs: this.options.stepDeadlineMs }),
        });
        await tx.workflows.completeStep({
          id: step.id,
          output,
          now: this.clock.now().toISOString(),
          resultStep: this.resultStep(snapshot, step.name),
        });
        await tx.outbox.enqueue(step.orgId, {
          eventName: `${snapshot.definition}.${step.status === "compensating" ? "compensated" : "progress"}`,
          payload: { workflowId: snapshot.id, step: step.name, attempt: step.attempt },
          occurredAt: this.clock.now().toISOString(),
          producerPluginId: snapshot.definition.split(".")[0]!,
        });
      } catch (error) {
        const workflow = this.options.kernel.plugins
          .flatMap((plugin) =>
            Object.entries(plugin.workflows ?? {}).map(([name, definition]) => ({
              target: `${plugin.id}.${name}`,
              definition,
            })),
          )
          .find(({ target }) => target === snapshot.definition)?.definition;
        const policy = workflow?.steps[step.name]?.retry ?? { maxAttempts: 1, backoffMs: 1_000 };
        const terminal =
          step.status === "compensating" ||
          error instanceof NonRetryableWorkflowError ||
          error instanceof ForbiddenError ||
          step.attempt >= policy.maxAttempts;
        const retryAt = terminal
          ? undefined
          : new Date(
              this.clock.now().getTime() + 2 ** (step.attempt - 1) * (policy.backoffMs ?? 1_000),
            ).toISOString();
        const code = error instanceof Error && "code" in error ? String(error.code) : "STEP_ERROR";
        await tx.workflows.failStep({
          id: step.id,
          error: `Workflow step failed (${code})`,
          ...(retryAt ? { retryAt } : {}),
          terminal,
          now: this.clock.now().toISOString(),
        });
        await tx.outbox.enqueue(step.orgId, {
          eventName: `${snapshot.definition}.failed`,
          payload: { workflowId: snapshot.id, step: step.name, attempt: step.attempt, terminal },
          occurredAt: this.clock.now().toISOString(),
          producerPluginId: snapshot.definition.split(".")[0]!,
        });
      } finally {
        watch?.();
      }
    });
  }
  /** Aborts a running step once its instance's cancellation commits; returns a stop function. */
  private watchCancellation(
    orgId: string,
    instanceId: string,
    controller: AbortController,
  ): (() => void) | undefined {
    const every = this.options.cancelPollMs ?? 1_000;
    if (every <= 0) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const check = async (): Promise<void> => {
      try {
        const current = await this.options.storage.transaction(orgId, (tx) =>
          tx.workflows.get(instanceId),
        );
        if (current?.cancelRequested) controller.abort();
      } catch {
        // A failed check is retried; it never fails the step.
      }
      if (!stopped && !controller.signal.aborted) timer = setTimeout(() => void check(), every);
    };
    timer = setTimeout(() => void check(), every);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }
  private resultStep(snapshot: WorkflowSnapshot, stepName: string): boolean {
    const workflow = this.options.kernel.plugins
      .flatMap((plugin) =>
        Object.entries(plugin.workflows ?? {}).map(([name, definition]) => ({
          target: `${plugin.id}.${name}`,
          definition,
        })),
      )
      .find(({ target }) => target === snapshot.definition)?.definition;
    if (!workflow) return false;
    if (workflow.resultStep !== undefined) return workflow.resultStep === stepName;
    return !Object.values(workflow.steps).some((step) => step.dependsOn?.includes(stepName));
  }
}
