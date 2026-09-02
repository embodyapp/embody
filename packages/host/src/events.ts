import { randomUUID } from "node:crypto";
import type { Kernel } from "@embody/core";
import { eventEnvelopeSchema, type EventEnvelope } from "@embody/core";
import type { OutboxEvent, StorageConnection } from "@embody/storage";

export interface Clock {
  now(): Date;
}
export interface OutboxWorkerOptions {
  readonly storage: StorageConnection;
  readonly kernel: Kernel;
  readonly workerId?: string;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly intervalMs?: number;
  readonly leaseMs?: number;
  readonly clock?: Clock;
  /** Called after local handlers, for transport-neutral cross-app fan-out. */
  readonly transport?: EventTransport;
}

/** A deliberately small seam: one transport owns outbound delivery of an outbox event. */
export interface EventTransport {
  deliver(event: EventEnvelope): Promise<void>;
}
export interface EventDestination {
  readonly appId: string;
  readonly endpoint: string;
}
export interface EventDirectory {
  destinations(event: EventEnvelope): Promise<readonly EventDestination[]>;
}
export interface DirectEventTransportOptions {
  readonly directory: EventDirectory;
  readonly send?: (destination: EventDestination, event: EventEnvelope) => Promise<void>;
}

/** Direct app-to-app adapter; retries remain owned by the outbox worker. */
export class DirectEventTransport implements EventTransport {
  private readonly send: (destination: EventDestination, event: EventEnvelope) => Promise<void>;
  public constructor(private readonly options: DirectEventTransportOptions) {
    this.send = options.send ?? (async (destination, event) => {
      const response = await fetch(new URL("/events/deliver", destination.endpoint), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event),
      });
      if (!response.ok) throw new Error(`Event delivery failed (${response.status})`);
    });
  }
  public async deliver(event: EventEnvelope): Promise<void> {
    for (const destination of await this.options.directory.destinations(event)) await this.send(destination, event);
  }
}

export class StaticEventDirectory implements EventDirectory {
  public constructor(private readonly entries: Readonly<Record<string, readonly EventDestination[]>>) {}
  public destinations(event: EventEnvelope): Promise<readonly EventDestination[]> {
    return Promise.resolve(this.entries[event.name] ?? []);
  }
}

/** At-least-once outbox worker. `tick` is intentionally public for deterministic operation and tests. */
export class OutboxWorker {
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly intervalMs: number;
  private readonly clock: Clock;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private readonly active = new Set<Promise<void>>();

  public constructor(private readonly options: OutboxWorkerOptions) {
    this.workerId = options.workerId ?? randomUUID();
    this.batchSize = options.batchSize ?? 50;
    this.concurrency = options.concurrency ?? 4;
    this.intervalMs = options.intervalMs ?? 500;
    this.clock = options.clock ?? { now: () => new Date() };
    if (this.batchSize < 1 || this.concurrency < 1) throw new RangeError("batchSize and concurrency must be positive");
  }
  public start(): void {
    if (this.timer !== undefined) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }
  public async stop(deadlineMs = 30_000): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    const settle = Promise.allSettled([...this.active]);
    await Promise.race([settle, new Promise<void>((resolve) => setTimeout(resolve, deadlineMs))]);
  }
  public async tick(): Promise<void> {
    if (this.stopping) return;
    // Claiming is atomic in both adapters. A worker deployment must use a database role permitted
    // to claim every tenant's outbox rows; handlers themselves run in the event's tenant transaction.
    const claimed = await this.options.storage.transaction("system", (tx) =>
      tx.outbox.claimBatch({
        limit: this.batchSize, workerId: this.workerId, now: this.clock.now().toISOString(),
        ...(this.options.leaseMs === undefined ? {} : { leaseMs: this.options.leaseMs }),
      }),
    );
    let cursor = 0;
    const run = async (): Promise<void> => {
      while (!this.stopping) {
        const event = claimed[cursor++];
        if (event === undefined) return;
        const task = this.process(event);
        this.active.add(task);
        try { await task; } finally { this.active.delete(task); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, claimed.length) }, run));
  }
  private async process(row: OutboxEvent): Promise<void> {
    try {
      const envelope: EventEnvelope = {
        protocolVersion: 1, id: row.id, name: row.eventName, orgId: row.orgId,
        producerAppId: "local", payload: row.payload, occurredAt: row.occurredAt,
      };
      await this.options.storage.transaction(row.orgId, async (tx) => {
        await this.options.kernel.handleEvent(envelope, tx);
        await this.options.transport?.deliver(envelope);
        await tx.outbox.complete(row.id);
      });
    } catch (error) {
      const safe = error instanceof Error ? error.message.replace(/[\r\n]/g, " ").slice(0, 1_000) : "Event handler failed";
      await this.options.storage.transaction(row.orgId, async (tx) => {
        if (row.attempts >= 5) await tx.outbox.deadLetter(row.id, safe);
        else {
          const retryAt = new Date(this.clock.now().getTime() + 2 ** (row.attempts - 1) * 1_000).toISOString();
          await tx.outbox.fail(row.id, safe, retryAt);
        }
      });
    }
  }
}

/** Validates a receiver envelope before it reaches application handlers. */
export function parseDeliveredEvent(value: unknown): EventEnvelope {
  return eventEnvelopeSchema.parse(value);
}
