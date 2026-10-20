import {
  DependencyError,
  ForbiddenError,
  RateLimitedError,
  UnavailableError,
  ValidationError,
  z,
} from "@embody/core";
import type {
  OutboxEvent,
  StorageConnection,
  StorageTransaction,
  WorkflowRepository,
  WorkflowSnapshot,
  WorkflowStep,
} from "@embody/storage";
import type { Kernel } from "@embody/core";
import { OutboxWorker, type Clock } from "./events.js";
import { WorkflowWorker } from "./workflows.js";
import {
  MemoryTaskQueue,
  cloudTasksQueue,
  deterministicTaskName,
  type CloudTasksQueueOptions,
  type QueueTask,
  type TaskQueue,
} from "./tasks.js";
export { metadataAccessToken } from "./tasks.js";

const DAY_MS = 24 * 60 * 60_000;

/** Limits of the hosted durable profile. See docs/mvp/DURABLE.md. */
export const DURABLE_LIMITS = Object.freeze({
  /** Wake tasks one transaction may create; more fails the write. */
  maxTasksPerTransaction: 100,
  /** Completed outbox, delivery and inbox records are kept this long (ADR 0004). */
  retentionMs: 30 * DAY_MS,
  /** A claim older than this is recoverable. Longer than the 30-second step deadline. */
  leaseMs: 60_000,
  /** Events and steps one drain claims. Each holds a database connection while it runs. */
  eventBatch: 4,
  stepBatch: 2,
  /** More step wakes than this in one transaction collapse into sweeps. */
  stepWakesPerTransaction: 4,
  /** Work this late with no drain is re-enqueued after an inbound request (MD12). */
  overdueGraceMs: 60_000,
  /** Retained records one cleanup deletes before it schedules a follow-up. */
  purgeBatch: 1_000,
});

const MAX_SCHEDULE_MS = 30 * DAY_MS;

export const drainRequestSchema = z
  .object({
    v: z.literal(1),
    app: z.string().min(1).max(63),
    org: z.string().min(1).max(200),
    kind: z.enum(["event", "step", "sweep", "cleanup"]),
    id: z.uuid().optional(),
    instance: z.uuid().optional(),
    due: z.iso.datetime(),
    txid: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
    name: z.string().regex(/^[A-Za-z0-9_-]{1,500}$/),
  })
  .strict()
  .refine((value) => value.kind !== "event" || value.id !== undefined, "Event wake needs an id")
  .refine((value) => value.kind !== "step" || value.id !== undefined, "Step wake needs an id");
export type DrainRequest = z.output<typeof drainRequestSchema>;

/** One wake-up: a named task that calls this app's drain endpoint at `scheduleAt`. */
export type WakeTask = QueueTask<DrainRequest>;
/** The wake queue port: the shared {@link TaskQueue} carrying drain requests. */
export type WakeQueue = TaskQueue<DrainRequest>;

/** In-memory queue with Cloud Tasks name semantics, for tests and local development. */
export class MemoryWakeQueue extends MemoryTaskQueue<DrainRequest> {}

const taskName = deterministicTaskName;

export interface WakingStorageOptions {
  readonly appId: string;
  readonly queue: WakeQueue;
  readonly clock?: Clock;
  readonly maxTasksPerTransaction?: number;
  /** Claims older than this are recoverable. Each claim's lease wake fires just after it. */
  readonly leaseMs?: number;
}

type Wake = Omit<DrainRequest, "v" | "app" | "name" | "txid">;

/** Forward steps a drain could claim now or later, keyed by what makes a wake for them distinct. */
function runnable(snapshot: WorkflowSnapshot | null): Map<string, WorkflowStep> {
  const steps = new Map<string, WorkflowStep>();
  if (snapshot === null || snapshot.cancelRequested) return steps;
  for (const step of snapshot.steps)
    if (step.status === "pending" || step.status === "waiting")
      steps.set(`${step.id}:${step.status}:${step.attempt}:${step.scheduledAt}`, step);
  return steps;
}
function compensationState(snapshot: WorkflowSnapshot | null): string {
  return (snapshot?.steps ?? [])
    .filter((step) => step.status === "compensating" || step.status === "running")
    .map((step) => `${step.id}:${step.status}`)
    .sort()
    .join(",");
}
/**
 * Wakes one instance needs after this transaction. A forward step gets its own wake when it
 * becomes runnable. Compensations run one at a time in reverse order, so any change to them gets
 * a single sweep and the claim picks the one that may run: O(1) tasks per change, not O(n).
 */
function instanceWakes(before: WorkflowSnapshot | null, after: WorkflowSnapshot): Wake[] {
  const prior = runnable(before);
  const wakes: Wake[] = [...runnable(after)]
    .filter(([key]) => !prior.has(key))
    .map(([, step]) => ({
      kind: "step",
      org: after.orgId,
      id: step.id,
      instance: after.id,
      due: step.scheduledAt,
    }));
  const compensating = after.steps.filter((step) => step.status === "compensating");
  if (compensating.length > 0 && compensationState(before) !== compensationState(after))
    wakes.push({
      kind: "sweep",
      org: after.orgId,
      due: compensating.map((step) => step.scheduledAt).sort()[0]!,
    });
  return wakes;
}
/**
 * Beyond a few step wakes, one transaction's steps collapse into one sweep per tenant and due
 * time. A sweep claims globally and chains while due work remains, so fan-out never meets the
 * per-transaction quota.
 */
function collapse(wakes: readonly Wake[]): Wake[] {
  const steps = wakes.filter((wake) => wake.kind === "step").length;
  const result: Wake[] = [];
  const sweeps = new Set<string>();
  for (const wake of wakes) {
    const sweep =
      wake.kind === "sweep" ||
      (wake.kind === "step" && steps > DURABLE_LIMITS.stepWakesPerTransaction);
    if (!sweep) result.push(wake);
    else if (!sweeps.has(`${wake.org}:${wake.due}`)) {
      sweeps.add(`${wake.org}:${wake.due}`);
      result.push({ kind: "sweep", org: wake.org, due: wake.due });
    }
  }
  return result;
}
/** Cloud Tasks schedules at most 30 days ahead; a later task arrives early and reschedules. */
function scheduleTime(due: string, now: Date): string {
  const latest = now.getTime() + MAX_SCHEDULE_MS - 60_000;
  return Date.parse(due) > latest ? new Date(latest).toISOString() : due;
}

/** Records what one transaction changes and enqueues its wake tasks before it commits. */
class WakeTracker {
  public readonly transaction: StorageTransaction;
  private readonly events: OutboxEvent[] = [];
  private readonly instances = new Map<string, WorkflowSnapshot | null>();
  /** One lease wake per claim, so every claimed item has a successor if its drain dies. */
  private readonly leases: { readonly wake: Wake; readonly attempt: number }[] = [];
  private completed = false;
  public constructor(
    private readonly tx: StorageTransaction,
    private readonly options: WakingStorageOptions,
  ) {
    const { outbox, workflows } = tx;
    const leaseEnd = (claimedAt?: string): string =>
      new Date(
        Date.parse(claimedAt ?? this.now().toISOString()) +
          (options.leaseMs ?? DURABLE_LIMITS.leaseMs) +
          1_000,
      ).toISOString();
    const tracked: WorkflowRepository = {
      ...workflows,
      start: async (input) => {
        const started = await workflows.start(input);
        if (started.created) this.instances.set(started.instance.id, null);
        return started;
      },
      cancel: async (id, now) => {
        await this.capture(id);
        return workflows.cancel(id, now);
      },
      retry: async (id, now) => {
        await this.capture(id);
        return workflows.retry(id, now);
      },
      claimDue: async (claimOptions) => {
        const claims = await workflows.claimDue(claimOptions);
        for (const claim of claims)
          this.leases.push({
            wake: { kind: "step", org: claim.orgId, id: claim.id, due: leaseEnd(claimOptions.now) },
            attempt: claim.attempt,
          });
        return claims;
      },
      lockClaim: async (claim) => {
        const step = await workflows.lockClaim(claim);
        if (step !== null) await this.capture(step.instanceId);
        return step;
      },
    };
    this.transaction = {
      orgId: tx.orgId,
      entities: tx.entities,
      inbox: tx.inbox,
      eventDeliveries: tx.eventDeliveries,
      ...(tx.durable === undefined ? {} : { durable: tx.durable }),
      ...(tx.savepoint === undefined
        ? {}
        : { savepoint: <T>(callback: () => Promise<T>) => tx.savepoint!(callback) }),
      outbox: {
        ...outbox,
        enqueue: async (orgId, input) => {
          const event = await outbox.enqueue(orgId, input);
          this.events.push(event);
          return event;
        },
        claimBatch: async (claimOptions) => {
          const claimed = await outbox.claimBatch(claimOptions);
          for (const event of claimed)
            this.leases.push({
              wake: {
                kind: "event",
                org: event.orgId,
                id: event.id,
                due: leaseEnd(event.claimedAt),
              },
              attempt: event.attempts,
            });
          return claimed;
        },
        fail: async (id, error, retryAt) => {
          const event = await outbox.fail(id, error, retryAt);
          if (event !== null) this.events.push(event);
          return event;
        },
        complete: async (id) => {
          await outbox.complete(id);
          this.completed = true;
        },
      },
      workflows: tracked,
    };
  }
  private now(): Date {
    return (this.options.clock ?? { now: () => new Date() }).now();
  }
  private async capture(instanceId: string): Promise<void> {
    if (this.instances.has(instanceId)) return;
    this.instances.set(instanceId, await this.tx.workflows.get(instanceId));
  }
  /** Enqueues every wake this transaction needs. Throwing rolls the transaction back. */
  public async flush(): Promise<void> {
    const now = this.now();
    const wakes: Wake[] = [];
    for (const event of this.events)
      if (event.status === "pending" || event.status === "failed")
        wakes.push({ kind: "event", org: event.orgId, id: event.id, due: event.scheduledAt });
    for (const [id, before] of this.instances) {
      const after = await this.tx.workflows.get(id);
      if (after !== null) wakes.push(...instanceWakes(before, after));
    }
    const work = collapse(wakes);
    if (work.length === 0 && this.leases.length === 0 && !this.completed) return;
    const maximum = this.options.maxTasksPerTransaction ?? DURABLE_LIMITS.maxTasksPerTransaction;
    if (work.length > maximum)
      throw new RateLimitedError(
        `One transaction may schedule at most ${maximum} wake tasks; split the work across actions or steps`,
      );
    if (this.tx.durable === undefined)
      throw new DependencyError("The durable profile requires PostgreSQL storage");
    const txid = work.length === 0 ? undefined : await this.tx.durable.transactionId();
    const app = this.options.appId;
    const tasks: WakeTask[] = work.map((wake) => {
      const name = taskName(wake.kind, app, wake.org, wake.id, wake.due, txid);
      return {
        name,
        scheduleAt: scheduleTime(wake.due, now),
        body: { v: 1, app, ...wake, ...(txid === undefined ? {} : { txid }), name },
      };
    });
    // Lease wakes carry no transaction ID: if the claim rolled back, the drain finds nothing.
    for (const { wake, attempt } of this.leases) {
      const name = taskName("lease", app, wake.org, wake.kind, wake.id, attempt);
      tasks.push({
        name,
        scheduleAt: scheduleTime(wake.due, now),
        body: { v: 1, app, ...wake, name },
      });
    }
    if (this.completed) {
      // One cleanup per tenant and day; it runs just inside the queue's 30-day limit.
      const due = new Date(now.getTime() + MAX_SCHEDULE_MS - 60_000).toISOString();
      const name = taskName("cleanup", app, this.tx.orgId, Math.floor(now.getTime() / DAY_MS));
      tasks.push({
        name,
        scheduleAt: due,
        body: { v: 1, app, kind: "cleanup", org: this.tx.orgId, due, name },
      });
    }
    try {
      await Promise.all(tasks.map((task) => this.options.queue.enqueue(task)));
    } catch {
      throw new UnavailableError("Wake queue is unavailable; the write was not committed");
    }
  }
}

/**
 * Wraps storage so every transaction that records an outbox event, makes a workflow step
 * runnable or claims work enqueues its wake tasks before it commits. A queue failure rolls the
 * transaction back.
 */
export function wakingStorage(
  storage: StorageConnection,
  options: WakingStorageOptions,
): StorageConnection {
  return {
    dialect: storage.dialect,
    ensureSchema: () => storage.ensureSchema(),
    close: () => storage.close(),
    ...(storage.transactionStatus === undefined
      ? {}
      : { transactionStatus: (id: string) => storage.transactionStatus!(id) }),
    transaction: (orgId, callback) =>
      storage.transaction(orgId, async (tx) => {
        const tracker = new WakeTracker(tx, options);
        const value = await callback(tracker.transaction);
        await tracker.flush();
        return value;
      }),
  };
}

export interface DrainResult {
  /** True when the task must be retried later; the host answers 503. */
  readonly retry: boolean;
  readonly outcome: "processed" | "uncommitted" | "rolled-back" | "early" | "cleaned";
  readonly events: number;
  readonly steps: number;
  readonly followUps: number;
}
export interface DrainAuditRecord extends DrainResult {
  readonly task: string;
  readonly kind: DrainRequest["kind"];
  readonly orgId: string;
  readonly durationMs: number;
}
export interface DurableDrainOptions {
  readonly appId: string;
  /** Waking storage: processing a batch enqueues the wakes it makes necessary. */
  readonly storage: StorageConnection;
  readonly queue: WakeQueue;
  readonly outbox: OutboxWorker;
  readonly workflows: WorkflowWorker;
  readonly clock?: Clock;
  readonly leaseMs?: number;
  readonly audit?: (record: DrainAuditRecord) => void | Promise<void>;
}

/**
 * Processes one bounded batch per wake task. Workers never run on timers in the durable profile;
 * a drain runs only when a task arrives, and recovery runs only after an inbound request.
 *
 * Every item has a successor task at all times: its own wake until it is claimed, a lease wake
 * (enqueued with the claim) while it is claimed, and a follow-up whenever a drain leaves due work
 * behind for its tenant.
 */
export class DurableDrain {
  private readonly clock: Clock;
  private readonly leaseMs: number;
  /** Last recovery check per tenant, so recovery costs at most one query per tenant a minute. */
  private readonly checked = new Map<string, number>();
  public constructor(private readonly options: DurableDrainOptions) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.leaseMs = options.leaseMs ?? DURABLE_LIMITS.leaseMs;
  }

  public async drain(input: unknown): Promise<DrainResult> {
    const startedAt = Date.now();
    const parsed = drainRequestSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError("Drain request is invalid");
    const request = parsed.data;
    if (request.app !== this.options.appId)
      throw new ForbiddenError("Drain request is for another app");
    const result = await this.run(request);
    await this.options.audit?.({
      ...result,
      task: request.name,
      kind: request.kind,
      orgId: request.org,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  /**
   * After an inbound request: if this tenant has work that is overdue with no drain in sight (a
   * task that was lost or gave up), enqueue one sweep. At most one check per tenant and minute.
   */
  public async recover(orgId: string): Promise<boolean> {
    const now = this.clock.now().getTime();
    const last = this.checked.get(orgId);
    if (last !== undefined && now - last < 60_000) return false;
    if (this.checked.size >= 1_000) this.checked.clear();
    this.checked.set(orgId, now);
    const overdue = await this.overdue(orgId, now - DURABLE_LIMITS.overdueGraceMs);
    if (!overdue) return false;
    const due = new Date(now).toISOString();
    const name = taskName("sweep", this.options.appId, orgId, "recover", Math.floor(now / 60_000));
    await this.options.queue.enqueue({
      name,
      scheduleAt: due,
      body: { v: 1, app: this.options.appId, kind: "sweep", org: orgId, due, name },
    });
    return true;
  }

  private overdue(orgId: string, before: number): Promise<boolean> {
    return this.options.storage.transaction(orgId, (tx) => {
      if (tx.durable === undefined)
        throw new DependencyError("The durable profile requires PostgreSQL storage");
      return tx.durable.overdue({
        before: new Date(before).toISOString(),
        expired: new Date(before - this.leaseMs).toISOString(),
      });
    });
  }

  private async run(request: DrainRequest): Promise<DrainResult> {
    const idle = { events: 0, steps: 0, followUps: 0 };
    if (request.txid !== undefined) {
      if (this.options.storage.transactionStatus === undefined)
        throw new DependencyError("The durable profile requires PostgreSQL storage");
      const status = await this.options.storage.transactionStatus(request.txid);
      // Enqueued before its transaction committed: retry until the outcome is known.
      if (status === "in progress") return { retry: true, outcome: "uncommitted", ...idle };
      // Rolled back: the work it announced never existed.
      if (status === "aborted") return { retry: false, outcome: "rolled-back", ...idle };
    }
    if (request.kind === "cleanup") return this.cleanup(request);
    const followUps: WakeTask[] = [];
    const enqueue = async () => {
      await Promise.all(followUps.map((task) => this.options.queue.enqueue(task)));
      return followUps.length;
    };
    if (request.kind === "sweep" && Date.parse(request.due) > this.clock.now().getTime()) {
      // Scheduled sooner than its due time (the queue's 30-day horizon, or clock skew).
      followUps.push(this.followUp(request, "sweep", "due", new Date(request.due)));
      return { retry: false, outcome: "early", ...idle, followUps: await enqueue() };
    }
    const events = await this.options.outbox.tick({
      orgId: request.org,
      limit: DURABLE_LIMITS.eventBatch,
    });
    const steps = await this.options.workflows.tick({ limit: DURABLE_LIMITS.stepBatch });
    let early = false;
    const sweep = (): void => {
      if (followUps.some((task) => task.body.kind === "sweep")) return;
      followUps.push(this.followUp(request, "sweep", "sweep", this.clock.now()));
    };
    if (events === DURABLE_LIMITS.eventBatch || steps === DURABLE_LIMITS.stepBatch) sweep();
    const now = this.clock.now();
    const state = await this.options.storage.transaction(request.org, async (tx) => {
      if (request.kind === "event") return this.eventState(tx, request.id!);
      if (request.kind === "step") return this.stepState(tx, request.id!);
      return undefined;
    });
    if (state?.status === "leased") {
      const expires = Date.parse(state.claimedAt) + this.leaseMs;
      if (expires <= now.getTime()) sweep();
      else
        followUps.push(
          this.followUp(request, request.kind, `lease:${state.attempt}`, new Date(expires + 1_000)),
        );
    } else if (state?.status === "scheduled") {
      if (Date.parse(state.scheduledAt) > now.getTime()) {
        // A later schedule has its own wake; the same schedule means this task came early.
        if (Date.parse(request.due) >= Date.parse(state.scheduledAt)) {
          early = true;
          const due = scheduleTime(state.scheduledAt, now);
          followUps.push(this.followUp(request, request.kind, `due:${due}`, new Date(due)));
        }
      } else if (state.claimable) sweep();
    }
    // Never leave due work for this tenant without a successor.
    if (!followUps.some((task) => task.body.kind === "sweep")) {
      if (await this.overdue(request.org, now.getTime())) sweep();
    }
    return {
      retry: false,
      outcome: early ? "early" : "processed",
      events,
      steps,
      followUps: await enqueue(),
    };
  }

  private async cleanup(request: DrainRequest): Promise<DrainResult> {
    const now = this.clock.now();
    const purged = await this.options.storage.transaction(request.org, (tx) => {
      if (tx.durable === undefined)
        throw new DependencyError("The durable profile requires PostgreSQL storage");
      return tx.durable.purge({
        before: new Date(now.getTime() - DURABLE_LIMITS.retentionMs).toISOString(),
        limit: DURABLE_LIMITS.purgeBatch,
      });
    });
    const followUps: WakeTask[] = [];
    if (purged.deleted >= DURABLE_LIMITS.purgeBatch)
      followUps.push(this.followUp(request, "cleanup", "more", now));
    else if (purged.oldest !== undefined) {
      // Keep one cleanup scheduled while retained records exist, inside the 30-day queue limit.
      const due = new Date(
        Math.min(
          Date.parse(purged.oldest) + DURABLE_LIMITS.retentionMs + 60_000,
          now.getTime() + MAX_SCHEDULE_MS - 60_000,
        ),
      );
      const name = taskName("cleanup", this.options.appId, request.org, "at", due.toISOString());
      followUps.push({
        name,
        scheduleAt: due.toISOString(),
        body: { ...this.base(request), kind: "cleanup", due: due.toISOString(), name },
      });
    }
    await Promise.all(followUps.map((task) => this.options.queue.enqueue(task)));
    return {
      retry: false,
      outcome: "cleaned",
      events: 0,
      steps: 0,
      followUps: followUps.length,
    };
  }

  private base(request: DrainRequest): Pick<DrainRequest, "v" | "app" | "org"> {
    return { v: 1, app: request.app, org: request.org };
  }
  /** A follow-up named after this task, so a retried drain never schedules it twice. */
  private followUp(
    request: DrainRequest,
    kind: DrainRequest["kind"],
    reason: string,
    due: Date,
  ): WakeTask {
    const name = taskName(kind, request.name, reason);
    const scheduleAt = scheduleTime(due.toISOString(), this.clock.now());
    const target =
      kind === request.kind
        ? {
            ...(request.id === undefined ? {} : { id: request.id }),
            ...(request.instance === undefined ? {} : { instance: request.instance }),
          }
        : {};
    return {
      name,
      scheduleAt,
      body: { ...this.base(request), kind, ...target, due: due.toISOString(), name },
    };
  }

  private async eventState(tx: StorageTransaction, id: string): Promise<WorkState | undefined> {
    if (tx.durable === undefined)
      throw new DependencyError("The durable profile requires PostgreSQL storage");
    const event = await tx.durable.event(id);
    if (event === null) return undefined;
    if (event.status === "processing" && event.claimedAt !== undefined)
      return { status: "leased", claimedAt: event.claimedAt, attempt: event.attempts };
    if (event.status === "pending" || event.status === "failed")
      return { status: "scheduled", scheduledAt: event.scheduledAt, claimable: true };
    return undefined;
  }

  private async stepState(tx: StorageTransaction, id: string): Promise<WorkState | undefined> {
    if (tx.durable === undefined)
      throw new DependencyError("The durable profile requires PostgreSQL storage");
    const found = await tx.durable.step(id);
    if (found === null) return undefined;
    const { step, cancelRequested } = found;
    // A claimed compensation keeps its status; its claim time marks the lease.
    if ((step.status === "running" || step.status === "compensating") && step.claimedAt)
      return { status: "leased", claimedAt: step.claimedAt, attempt: step.attempt };
    if ((step.status === "pending" || step.status === "waiting") && !cancelRequested)
      return { status: "scheduled", scheduledAt: step.scheduledAt, claimable: true };
    // A compensation waits for later ones; their completion sweeps again.
    if (step.status === "compensating")
      return { status: "scheduled", scheduledAt: step.scheduledAt, claimable: false };
    return undefined;
  }
}

export interface CreateDurableDrainOptions {
  readonly appId: string;
  /** Waking storage, the same instance the kernel uses. */
  readonly storage: StorageConnection;
  readonly kernel: Kernel;
  readonly queue: WakeQueue;
  readonly clock?: Clock;
  readonly audit?: DurableDrainOptions["audit"];
}
/**
 * The hosted durable drain: outbox and workflow workers that never start a timer, bounded to one
 * batch per wake task, with leases longer than the 30-second step deadline.
 */
export function createDurableDrain(options: CreateDurableDrainOptions): DurableDrain {
  const clock = options.clock === undefined ? {} : { clock: options.clock };
  return new DurableDrain({
    appId: options.appId,
    storage: options.storage,
    queue: options.queue,
    ...clock,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    outbox: new OutboxWorker({
      storage: options.storage,
      kernel: options.kernel,
      producerAppId: options.appId,
      maxAttempts: 5,
      leaseMs: DURABLE_LIMITS.leaseMs,
      concurrency: 2,
      ...clock,
    }),
    workflows: new WorkflowWorker({
      storage: options.storage,
      kernel: options.kernel,
      leaseMs: DURABLE_LIMITS.leaseMs,
      stepDeadlineMs: 30_000,
      concurrency: 2,
      ...clock,
    }),
  });
}

type WorkState =
  | { readonly status: "leased"; readonly claimedAt: string; readonly attempt: number }
  | { readonly status: "scheduled"; readonly scheduledAt: string; readonly claimable: boolean };

export type CloudTasksWakeQueueOptions = CloudTasksQueueOptions;

/**
 * Cloud Tasks adapter for app wake-ups: the shared {@link cloudTasksQueue} with the app's drain
 * URL, audience and platform invoker. Live qualification (deduplication window, schedule limit,
 * IAM) is M09.
 */
export function cloudTasksWakeQueue(options: CloudTasksWakeQueueOptions): WakeQueue {
  return cloudTasksQueue<DrainRequest>(options);
}
