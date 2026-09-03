import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Kernel,
  type EmbodyPlugin,
  type ExecutionAuditEvent,
  type Principal,
  type ProgressUpdate,
} from "@embody/core";
import { OutboxWorker, type OutboxWorkerOptions } from "@embody/host";
import { SqliteStorage, type OutboxEvent } from "@embody/storage";

export interface TestHarnessActor {
  readonly actorId: string;
  readonly actorType: Principal["actorType"];
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TestHarnessOptions {
  readonly plugins: readonly EmbodyPlugin[];
  /** Complete request identity. Takes precedence over `tenantId` and `actor`. */
  readonly principal?: Principal;
  readonly tenantId?: string;
  readonly actor?: TestHarnessActor;
  /** Replaces only services actually provided by a plugin, keyed as `plugin.service`. */
  readonly services?: Readonly<Record<string, unknown>>;
  readonly now?: () => Date;
  readonly eventId?: () => string;
  readonly worker?: Omit<OutboxWorkerOptions, "storage" | "kernel">;
}

export interface CapturedProgress {
  readonly requestId: string;
  readonly principal: Principal;
  readonly update: ProgressUpdate;
}

export interface TestHarness {
  readonly kernel: Kernel;
  readonly principal: Principal;
  call(target: string, input: unknown): Promise<unknown>;
  /** A new request view with its own principal; no mutable request context is shared. */
  as(principal: Principal): TestHarness;
  tickOutbox(): Promise<void>;
  outbox(): Promise<readonly OutboxEvent[]>;
  /** Alias for `outbox`, retained as the event-oriented inspection surface. */
  events(): Promise<readonly OutboxEvent[]>;
  progress(): readonly CapturedProgress[];
  audit(): readonly ExecutionAuditEvent[];
  close(): Promise<void>;
}

function defaultPrincipal(options: TestHarnessOptions): Principal {
  if (options.principal !== undefined) return options.principal;
  const scopes = options.plugins.map((plugin) => `${plugin.id}:*`);
  return {
    orgId: options.tenantId ?? "test",
    actorId: options.actor?.actorId ?? "test-agent",
    actorType: options.actor?.actorType ?? "agent",
    roles: options.actor?.roles ?? ["operator"],
    scopes: options.actor?.scopes ?? scopes,
    ...(options.actor?.metadata === undefined ? {} : { metadata: options.actor.metadata }),
  };
}

class Harness implements TestHarness {
  public constructor(
    public readonly kernel: Kernel,
    public readonly principal: Principal,
    private readonly worker: OutboxWorker,
    private readonly storage: SqliteStorage,
    private readonly directory: string,
    private readonly capturedProgress: CapturedProgress[],
    private readonly audits: ExecutionAuditEvent[],
    private readonly requestId: () => string,
    private readonly closeRoot: () => Promise<void>,
  ) {}

  public async call(target: string, input: unknown): Promise<unknown> {
    const requestId = this.requestId();
    const updates: ProgressUpdate[] = [];
    const result = await this.kernel.execute(target, input, {
      principal: this.principal,
      requestId,
      progress: (update) => updates.push(update),
      audit: (entry) => {
        this.audits.push(entry);
      },
    });
    this.capturedProgress.push(
      ...updates.map((update) => ({ requestId, principal: this.principal, update })),
    );
    return result;
  }

  public as(principal: Principal): TestHarness {
    return new Harness(
      this.kernel,
      principal,
      this.worker,
      this.storage,
      this.directory,
      this.capturedProgress,
      this.audits,
      this.requestId,
      this.closeRoot,
    );
  }

  public tickOutbox(): Promise<void> {
    return this.worker.tick();
  }
  public async outbox(): Promise<readonly OutboxEvent[]> {
    return this.storage.transaction("system", (tx) => tx.outbox.list());
  }
  public events(): Promise<readonly OutboxEvent[]> {
    return this.outbox();
  }
  public progress(): readonly CapturedProgress[] {
    return [...this.capturedProgress];
  }
  public audit(): readonly ExecutionAuditEvent[] {
    return [...this.audits];
  }
  public close(): Promise<void> {
    return this.closeRoot();
  }
}

/**
 * Boots the production kernel, SQLite adapter, execution pipeline, and deterministic outbox worker.
 * Each harness owns an isolated temporary directory; `close()` always stops workers, closes SQLite,
 * and removes it. See `README.md` for the warm-start benchmark methodology.
 */
export async function createTestHarness(options: TestHarnessOptions): Promise<TestHarness> {
  const directory = await mkdtemp(join(tmpdir(), "embody-test-"));
  const storage = new SqliteStorage({ filename: join(directory, "embody.sqlite") });
  const kernel = new Kernel({
    plugins: options.plugins,
    storage,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
    ...(options.services === undefined ? {} : { serviceOverrides: options.services }),
  });
  let closed = false;
  let worker: OutboxWorker | undefined;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await worker?.stop(0);
      await kernel.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    await kernel.boot();
    worker = new OutboxWorker({ storage, kernel, ...options.worker });
    const progress: CapturedProgress[] = [];
    const audits: ExecutionAuditEvent[] = [];
    let sequence = 0;
    return new Harness(
      kernel,
      defaultPrincipal(options),
      worker,
      storage,
      directory,
      progress,
      audits,
      () => `test-${++sequence}`,
      close,
    );
  } catch (error) {
    await close();
    throw error;
  }
}
