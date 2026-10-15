import { createHash } from "node:crypto";
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
  .refine(
    (value) => value.kind !== "step" || (value.id !== undefined && value.instance !== undefined),
    "Step wake needs a step and instance id",
  );
export type DrainRequest = z.output<typeof drainRequestSchema>;

/** One wake-up: a named task that calls this app's drain endpoint at `scheduleAt`. */
export interface WakeTask {
  /** Deterministic; the queue rejects a name it has seen, which counts as success. */
  readonly name: string;
  readonly scheduleAt: string;
  readonly body: DrainRequest;
}
/** The wake queue port. Production uses Cloud Tasks; tests use {@link MemoryWakeQueue}. */
export interface WakeQueue {
  /** Creates the task, or reports that one with this name already exists. Throws on failure. */
  enqueue(task: WakeTask): Promise<"created" | "duplicate">;
}

/** In-memory queue with Cloud Tasks name semantics, for tests and local development. */
export class MemoryWakeQueue implements WakeQueue {
  /** Every task created, in creation order. */
  public readonly tasks: WakeTask[] = [];
  /** When true, every enqueue fails, as during a queue outage. */
  public outage = false;
  private readonly names = new Set<string>();
  private readonly delivered = new Set<string>();
  public enqueue(task: WakeTask): Promise<"created" | "duplicate"> {
    if (this.outage) return Promise.reject(new Error("Wake queue unavailable"));
    if (this.names.has(task.name)) return Promise.resolve("duplicate");
    this.names.add(task.name);
    this.tasks.push(task);
    return Promise.resolve("created");
  }
  /** Tasks due at `now` that have not been delivered yet, oldest first. */
  public due(now: Date = new Date()): readonly WakeTask[] {
    return this.tasks
      .filter((task) => !this.delivered.has(task.name) && Date.parse(task.scheduleAt) <= +now)
      .sort((a, b) => Date.parse(a.scheduleAt) - Date.parse(b.scheduleAt));
  }
  /** Marks a task delivered, as the queue does after a 2xx response. */
  public acknowledge(name: string): void {
    this.delivered.add(name);
  }
}

function taskName(kind: string, ...parts: readonly (string | number | undefined)[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u0000"))
    .digest("hex")
    .slice(0, 40);
  return `${kind}-${digest}`;
}

export interface WakingStorageOptions {
  readonly appId: string;
  readonly queue: WakeQueue;
  readonly clock?: Clock;
  readonly maxTasksPerTransaction?: number;
}

type Wake = Omit<DrainRequest, "v" | "app" | "name" | "txid">;

/** Steps a drain could claim now or later, keyed by what makes a wake for them distinct. */
function runnable(snapshot: WorkflowSnapshot): Map<string, WorkflowStep> {
  const steps = new Map<string, WorkflowStep>();
  for (const step of snapshot.steps)
    if (
      ((step.status === "pending" || step.status === "waiting") && !snapshot.cancelRequested) ||
      step.status === "compensating"
    )
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
 * Steps this transaction made runnable. Compensations run in reverse order, so when any step
 * stops compensating or running, every remaining compensation is woken again: the claim decides
 * which one may run.
 */
function newlyRunnable(before: WorkflowSnapshot | null, after: WorkflowSnapshot): WorkflowStep[] {
  const prior = before === null ? new Map<string, WorkflowStep>() : runnable(before);
  const changed = compensationState(before) !== compensationState(after);
  return [...runnable(after)]
    .filter(([key, step]) => !prior.has(key) || (step.status === "compensating" && changed))
    .map(([, step]) => step);
}

/** Records what one transaction changes and enqueues its wake tasks before it commits. */
class WakeTracker {
  public readonly transaction: StorageTransaction;
  private readonly events: OutboxEvent[] = [];
  private readonly instances = new Map<string, WorkflowSnapshot | null>();
  private completed = false;
  public constructor(
    private readonly tx: StorageTransaction,
    private readonly options: WakingStorageOptions,
  ) {
    const { outbox, workflows } = tx;
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
  private async capture(instanceId: string): Promise<void> {
    if (this.instances.has(instanceId)) return;
    this.instances.set(instanceId, await this.tx.workflows.get(instanceId));
  }
  /** Enqueues every wake this transaction needs. Throwing rolls the transaction back. */
  public async flush(): Promise<void> {
    const now = (this.options.clock ?? { now: () => new Date() }).now();
    const wakes: Wake[] = [];
    for (const event of this.events)
      if (event.status === "pending" || event.status === "failed")
        wakes.push({ kind: "event", org: event.orgId, id: event.id, due: event.scheduledAt });
    for (const [id, before] of this.instances) {
      const after = await this.tx.workflows.get(id);
      if (after === null) continue;
      for (const step of newlyRunnable(before, after))
        wakes.push({
          kind: "step",
          org: after.orgId,
          id: step.id,
          instance: id,
          due: step.scheduledAt,
        });
    }
    if (wakes.length === 0 && !this.completed) return;
    const maximum = this.options.maxTasksPerTransaction ?? DURABLE_LIMITS.maxTasksPerTransaction;
    if (wakes.length > maximum)
      throw new RateLimitedError(
        `One transaction may schedule at most ${maximum} wake tasks; split the work across actions or steps`,
      );
    for (const wake of wakes)
      if (Date.parse(wake.due) - now.getTime() > MAX_SCHEDULE_MS)
        throw new ValidationError("Durable work can be scheduled at most 30 days ahead");
    if (this.tx.durable === undefined)
      throw new DependencyError("The durable profile requires PostgreSQL storage");
    const txid = await this.tx.durable.transactionId();
    const tasks: WakeTask[] = wakes.map((wake) => {
      const name = taskName(wake.kind, this.options.appId, wake.org, wake.id, wake.due, txid);
      return {
        name,
        scheduleAt: wake.due,
        body: { v: 1, app: this.options.appId, ...wake, txid, name },
      };
    });
    if (this.completed) {
      // One cleanup per tenant and day; it runs just inside the queue's 30-day limit.
      const due = new Date(now.getTime() + MAX_SCHEDULE_MS - 60_000).toISOString();
      const name = taskName(
        "cleanup",
        this.options.appId,
        this.tx.orgId,
        Math.floor(now.getTime() / DAY_MS),
      );
      tasks.push({
        name,
        scheduleAt: due,
        body: { v: 1, app: this.options.appId, kind: "cleanup", org: this.tx.orgId, due, name },
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
 * Wraps storage so every transaction that records an outbox event or makes a workflow step
 * runnable enqueues its wake tasks before it commits. A queue failure rolls the write back.
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
 */
export class DurableDrain {
  private readonly clock: Clock;
  private readonly leaseMs: number;
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
   * task that was lost or gave up), enqueue one sweep. At most one per tenant and minute.
   */
  public async recover(orgId: string): Promise<boolean> {
    const now = this.clock.now().getTime();
    const overdue = await this.options.storage.transaction(orgId, (tx) => {
      if (tx.durable === undefined)
        throw new DependencyError("The durable profile requires PostgreSQL storage");
      return tx.durable.overdue({
        before: new Date(now - DURABLE_LIMITS.overdueGraceMs).toISOString(),
        expired: new Date(now - this.leaseMs - DURABLE_LIMITS.overdueGraceMs).toISOString(),
      });
    });
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
    const events = await this.options.outbox.tick({
      orgId: request.org,
      limit: DURABLE_LIMITS.eventBatch,
    });
    const steps = await this.options.workflows.tick({ limit: DURABLE_LIMITS.stepBatch });
    const followUps: WakeTask[] = [];
    let early = false;
    const sweep = (): void => {
      if (followUps.some((task) => task.body.kind === "sweep")) return;
      followUps.push(this.followUp(request, "sweep", "sweep", this.clock.now()));
    };
    if (events === DURABLE_LIMITS.eventBatch || steps === DURABLE_LIMITS.stepBatch) sweep();
    const now = this.clock.now();
    const state = await this.options.storage.transaction(request.org, async (tx) => {
      if (request.kind === "event") return this.eventState(tx, request.id!);
      if (request.kind === "step") return this.stepState(tx, request.instance!, request.id!);
      return undefined;
    });
    if (state !== undefined) {
      if (state.status === "leased") {
        const due = new Date(Date.parse(state.claimedAt) + this.leaseMs + 1_000);
        followUps.push(this.followUp(request, request.kind, `lease:${state.attempt}`, due));
      } else if (state.status === "scheduled") {
        if (Date.parse(state.scheduledAt) > now.getTime()) {
          // A later schedule has its own wake; the same schedule means this task came early.
          if (Date.parse(request.due) >= Date.parse(state.scheduledAt)) early = true;
        } else if (state.claimable) sweep();
      }
    }
    await Promise.all(followUps.map((task) => this.options.queue.enqueue(task)));
    return {
      retry: early,
      outcome: early ? "early" : "processed",
      events,
      steps,
      followUps: followUps.length,
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
    const scheduleAt = due.toISOString();
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
      body: { ...this.base(request), kind, ...target, due: scheduleAt, name },
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

  private async stepState(
    tx: StorageTransaction,
    instanceId: string,
    stepId: string,
  ): Promise<WorkState | undefined> {
    const snapshot = await tx.workflows.get(instanceId);
    const step = snapshot?.steps.find((candidate) => candidate.id === stepId);
    if (snapshot === null || snapshot === undefined || step === undefined) return undefined;
    if (step.status === "running" && step.claimedAt !== undefined)
      return { status: "leased", claimedAt: step.claimedAt, attempt: step.attempt };
    if ((step.status === "pending" || step.status === "waiting") && !snapshot.cancelRequested)
      return { status: "scheduled", scheduledAt: step.scheduledAt, claimable: true };
    // A compensation waits for later ones; their completion wakes it again.
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

export interface CloudTasksWakeQueueOptions {
  /** `projects/<project>/locations/<location>/queues/<queue>`. */
  readonly queue: string;
  /** This app's drain URL (HTTPS). */
  readonly url: string;
  /** The platform invoker identity Cloud Tasks signs the OIDC token as. */
  readonly invokerEmail: string;
  /** The OIDC token audience the app verifies. */
  readonly audience: string;
  /** OAuth access token for the Cloud Tasks API. Defaults to the workload metadata server. */
  readonly accessToken?: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

const QUEUE_PATH =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/queues\/[A-Za-z0-9-]{1,100}$/;

/** Workload access token from the local metadata server, cached until a minute before expiry. */
export function metadataAccessToken(fetcher: typeof fetch = fetch): () => Promise<string> {
  let cached: { readonly token: string; readonly until: number } | undefined;
  return async () => {
    if (cached !== undefined && cached.until > Date.now()) return cached.token;
    const response = await fetcher(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: { "metadata-flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok || response.headers.get("metadata-flavor") !== "Google")
      throw new Error("Workload access token is unavailable");
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number")
      throw new Error("Workload access token is invalid");
    cached = { token: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    return cached.token;
  };
}

/**
 * Cloud Tasks adapter. Tasks carry an OIDC token for the platform invoker identity and the app's
 * drain audience. Live qualification (deduplication window, schedule limit, IAM) is M09.
 */
export function cloudTasksWakeQueue(options: CloudTasksWakeQueueOptions): WakeQueue {
  if (!QUEUE_PATH.test(options.queue)) throw new TypeError("Invalid Cloud Tasks queue path");
  if (!options.url.startsWith("https:") || !options.audience.startsWith("https:"))
    throw new TypeError("Cloud Tasks drain URL and audience must be HTTPS");
  const fetcher = options.fetch ?? fetch;
  const accessToken = options.accessToken ?? metadataAccessToken(fetcher);
  return {
    async enqueue(task: WakeTask): Promise<"created" | "duplicate"> {
      const response = await fetcher(
        `https://cloudtasks.googleapis.com/v2/${options.queue}/tasks`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            task: {
              name: `${options.queue}/tasks/${task.name}`,
              scheduleTime: task.scheduleAt,
              httpRequest: {
                httpMethod: "POST",
                url: options.url,
                headers: { "content-type": "application/json" },
                body: Buffer.from(JSON.stringify(task.body)).toString("base64"),
                oidcToken: {
                  serviceAccountEmail: options.invokerEmail,
                  audience: options.audience,
                },
              },
            },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (response.ok) return "created";
      if (response.status === 409) return "duplicate";
      throw new Error(`Wake queue rejected the task (${response.status})`);
    },
  };
}
