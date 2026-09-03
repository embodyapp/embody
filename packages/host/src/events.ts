import { createHmac, randomUUID } from "node:crypto";
import type { Kernel } from "@embody/core";
import {
  eventDeliveryRequestSchema,
  eventEnvelopeSchema,
  stableStringify,
  type EventDeliveryRequest,
  type EventEnvelope,
} from "@embody/core";
import type {
  EventDelivery,
  EventDeliveryRepository,
  OutboxEvent,
  StorageConnection,
} from "@embody/storage";

export interface Clock {
  now(): Date;
}
interface WorkerPolicy {
  readonly workerId?: string;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly intervalMs?: number;
  readonly leaseMs?: number;
  /** Total attempts before dead-lettering. Defaults to 1; production commonly configures 5. */
  readonly maxAttempts?: number;
  /** Base exponential retry delay. Defaults to one second. */
  readonly retryBaseMs?: number;
  readonly clock?: Clock;
}
export interface OutboxWorkerOptions extends WorkerPolicy {
  readonly storage: StorageConnection;
  readonly kernel: Kernel;
  readonly producerAppId?: string;
  /** Exactly one transport owns durable destination routing. */
  readonly transport?: EventTransport;
  readonly audit?: (event: {
    readonly eventId: string;
    readonly outcome: "routed" | "no-subscriber";
  }) => void | Promise<void>;
}
export interface DeliveryWorkerOptions extends WorkerPolicy {
  readonly storage: StorageConnection;
  readonly transport: EventTransport;
}

/** Infrastructure seam for durable destination snapshotting and direct transmission. */
export interface EventTransport {
  route(event: EventEnvelope, repository: EventDeliveryRepository): Promise<number>;
  send(delivery: EventDelivery): Promise<void>;
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
  readonly secret: string;
  readonly send?: (
    destination: EventDestination,
    request: EventDeliveryRequest,
    signature: string,
  ) => Promise<void>;
}

/** Publisher-owned durable direct transport. Network calls are performed only by DeliveryWorker. */
export class DirectEventTransport implements EventTransport {
  private readonly transmit: (
    destination: EventDestination,
    request: EventDeliveryRequest,
    signature: string,
  ) => Promise<void>;
  public constructor(private readonly options: DirectEventTransportOptions) {
    this.transmit =
      options.send ??
      (async (destination, request, signature) => {
        const response = await fetch(new URL("/events/deliver", destination.endpoint), {
          method: "POST",
          headers: { "content-type": "application/json", "x-embody-event-signature": signature },
          body: JSON.stringify(request),
        });
        if (!response.ok) throw new Error(`Event delivery failed (${response.status})`);
      });
  }
  public async route(event: EventEnvelope, repository: EventDeliveryRepository): Promise<number> {
    const destinations = await this.options.directory.destinations(event);
    for (const destination of destinations) {
      const endpoint = new URL(destination.endpoint);
      if (!/^https?:$/.test(endpoint.protocol)) throw new Error("Event endpoint is not HTTP(S)");
      await repository.create({
        eventId: event.id,
        orgId: event.orgId,
        destinationAppId: destination.appId,
        destinationEndpoint: endpoint.toString(),
        envelope: event,
        scheduledAt: event.occurredAt,
      });
    }
    return destinations.length;
  }
  public async send(delivery: EventDelivery): Promise<void> {
    const event = parseDeliveredEvent(delivery.envelope);
    const request: EventDeliveryRequest = {
      protocolVersion: 1,
      deliveryId: delivery.id,
      destinationAppId: delivery.destinationAppId,
      attempt: delivery.attempts,
      event,
    };
    await this.transmit(
      { appId: delivery.destinationAppId, endpoint: delivery.destinationEndpoint },
      request,
      signDelivery(request, this.options.secret),
    );
  }
}

export class StaticEventDirectory implements EventDirectory {
  public constructor(
    private readonly entries: Readonly<Record<string, readonly EventDestination[]>>,
  ) {}
  public destinations(event: EventEnvelope): Promise<readonly EventDestination[]> {
    return Promise.resolve(this.entries[event.name] ?? []);
  }
}

interface PolicyValues {
  readonly workerId: string;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly intervalMs: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly clock: Clock;
}
function policy(options: WorkerPolicy): PolicyValues {
  const result = {
    workerId: options.workerId ?? randomUUID(),
    batchSize: options.batchSize ?? 50,
    concurrency: options.concurrency ?? 4,
    intervalMs: options.intervalMs ?? 500,
    maxAttempts: options.maxAttempts ?? 1,
    retryBaseMs: options.retryBaseMs ?? 1_000,
    clock: options.clock ?? { now: () => new Date() },
  };
  if (
    !Number.isInteger(result.batchSize) ||
    result.batchSize < 1 ||
    !Number.isInteger(result.concurrency) ||
    result.concurrency < 1 ||
    !Number.isInteger(result.maxAttempts) ||
    result.maxAttempts < 1 ||
    !Number.isFinite(result.retryBaseMs) ||
    result.retryBaseMs < 0
  )
    throw new RangeError("Worker limits and retry policy must be positive");
  return result;
}
function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\r\n]/g, " ").slice(0, 1_000)
    : "Event delivery failed";
}
function retryAt(values: PolicyValues, attempts: number): string {
  return new Date(
    values.clock.now().getTime() + 2 ** (attempts - 1) * values.retryBaseMs,
  ).toISOString();
}

/** Routes outbox events to local handlers and atomically snapshots remote destinations. */
export class OutboxWorker {
  private readonly values: PolicyValues;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private readonly active = new Set<Promise<void>>();
  public constructor(private readonly options: OutboxWorkerOptions) {
    this.values = policy(options);
  }
  public start(): Promise<void> {
    if (this.timer === undefined) {
      this.stopping = false;
      this.timer = setInterval(() => void this.tick(), this.values.intervalMs);
    }
    return Promise.resolve();
  }
  public async stop(deadlineMs = 30_000): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.race([
      Promise.allSettled([...this.active]),
      new Promise<void>((resolve) => setTimeout(resolve, deadlineMs)),
    ]);
  }
  public async tick(): Promise<void> {
    if (this.stopping) return;
    const claimed = await this.options.storage.transaction("system", (tx) =>
      tx.outbox.claimBatch({
        limit: this.values.batchSize,
        workerId: this.values.workerId,
        now: this.values.clock.now().toISOString(),
        ...(this.options.leaseMs === undefined ? {} : { leaseMs: this.options.leaseMs }),
      }),
    );
    await this.concurrent(claimed, (event) => this.process(event));
  }
  private async concurrent<T>(
    items: readonly T[],
    process: (item: T) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;
    const run = async (): Promise<void> => {
      while (!this.stopping) {
        const item = items[cursor++];
        if (item === undefined) return;
        const task = process(item);
        this.active.add(task);
        try {
          await task;
        } finally {
          this.active.delete(task);
        }
      }
    };
    const concurrency = this.options.storage.dialect === "sqlite" ? 1 : this.values.concurrency;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  }
  private async process(row: OutboxEvent): Promise<void> {
    try {
      const envelope: EventEnvelope = {
        protocolVersion: 1,
        id: row.id,
        name: row.eventName,
        orgId: row.orgId,
        producerAppId: this.options.producerAppId ?? "local",
        payload: row.payload,
        occurredAt: row.occurredAt,
        ...(row.correlationId === undefined ? {} : { correlationId: row.correlationId }),
        ...(row.causationId === undefined ? {} : { causationId: row.causationId }),
        ...(row.producerPluginId === undefined ? {} : { producerPluginId: row.producerPluginId }),
        ...(row.schemaVersion === undefined ? {} : { schemaVersion: row.schemaVersion }),
      };
      let destinations = 0;
      await this.options.storage.transaction(row.orgId, async (tx) => {
        await this.options.kernel.handleEvent(envelope, tx);
        destinations = (await this.options.transport?.route(envelope, tx.eventDeliveries)) ?? 0;
        await tx.outbox.complete(row.id);
      });
      await this.options.audit?.({
        eventId: row.id,
        outcome: destinations === 0 ? "no-subscriber" : "routed",
      });
    } catch (error) {
      await this.options.storage.transaction(row.orgId, async (tx) => {
        if (row.attempts >= this.values.maxAttempts)
          await tx.outbox.deadLetter(row.id, safeError(error));
        else await tx.outbox.fail(row.id, safeError(error), retryAt(this.values, row.attempts));
      });
    }
  }
}

/** Independently retries snapshotted destinations without rerunning completed destinations. */
export class DeliveryWorker {
  private readonly values: PolicyValues;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private readonly active = new Set<Promise<void>>();
  public constructor(private readonly options: DeliveryWorkerOptions) {
    this.values = policy(options);
  }
  public start(): Promise<void> {
    if (this.timer === undefined) {
      this.stopping = false;
      this.timer = setInterval(() => void this.tick(), this.values.intervalMs);
    }
    return Promise.resolve();
  }
  public async stop(deadlineMs = 30_000): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.race([
      Promise.allSettled([...this.active]),
      new Promise<void>((resolve) => setTimeout(resolve, deadlineMs)),
    ]);
  }
  public async tick(): Promise<void> {
    if (this.stopping) return;
    const claimed = await this.options.storage.transaction("system", (tx) =>
      tx.eventDeliveries.claimBatch({
        limit: this.values.batchSize,
        workerId: this.values.workerId,
        now: this.values.clock.now().toISOString(),
        ...(this.options.leaseMs === undefined ? {} : { leaseMs: this.options.leaseMs }),
      }),
    );
    let cursor = 0;
    const run = async (): Promise<void> => {
      while (!this.stopping) {
        const delivery = claimed[cursor++];
        if (delivery === undefined) return;
        const task = this.process(delivery);
        this.active.add(task);
        try {
          await task;
        } finally {
          this.active.delete(task);
        }
      }
    };
    const concurrency = this.options.storage.dialect === "sqlite" ? 1 : this.values.concurrency;
    await Promise.all(Array.from({ length: Math.min(concurrency, claimed.length) }, run));
  }
  private async process(delivery: EventDelivery): Promise<void> {
    try {
      await this.options.transport.send(delivery);
      await this.options.storage.transaction(delivery.orgId, (tx) =>
        tx.eventDeliveries.complete(delivery.id),
      );
    } catch (error) {
      await this.options.storage.transaction(delivery.orgId, async (tx) => {
        if (delivery.attempts >= this.values.maxAttempts)
          await tx.eventDeliveries.deadLetter(delivery.id, safeError(error));
        else
          await tx.eventDeliveries.fail(
            delivery.id,
            safeError(error),
            retryAt(this.values, delivery.attempts),
          );
      });
    }
  }
}

export function signEvent(event: EventEnvelope, secret: string): string {
  return createHmac("sha256", secret).update(stableStringify(event)).digest("hex");
}
export function signDelivery(request: EventDeliveryRequest, secret: string): string {
  return createHmac("sha256", secret).update(stableStringify(request)).digest("hex");
}
export function parseDeliveryRequest(value: unknown): EventDeliveryRequest {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 256 * 1024)
    throw new RangeError("Event delivery exceeds 256 KiB");
  return eventDeliveryRequestSchema.parse(value);
}
export function parseDeliveredEvent(value: unknown): EventEnvelope {
  return eventEnvelopeSchema.parse(value);
}
