import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ForbiddenError,
  Kernel,
  RateLimitedError,
  UnavailableError,
  ValidationError,
} from "@embody/core";
import { PostgresStorage } from "@embody/storage";
import {
  createAppHost,
  createDurableDrain,
  MemoryWakeQueue,
  wakingStorage,
  type DrainRequest,
  type DrainResult,
  type DurableDrain,
  type WakeQueue,
  type WakeTask,
} from "../src/index.js";
import {
  APP_ID,
  createEffects,
  createPlugins,
  createTableQueue,
  FIXTURE_GRANTS,
  FIXTURE_TABLES,
  principal,
  FAN_LEAVES,
  SHIP_DELAY_MS,
} from "./fixtures/m20-durable.mjs";
import { holdClaimLock } from "./fixtures/claim-lock.mjs";

const runtimeUrl = process.env["EMBODY_POSTGRES_URL"];
const migrationUrl = process.env["EMBODY_POSTGRES_MIGRATION_URL"];
if (process.env["EMBODY_POSTGRES_REQUIRED"] === "true" && (!runtimeUrl || !migrationUrl))
  throw new Error("M20 durable proof requires EMBODY_POSTGRES_URL and _MIGRATION_URL");
const suite = runtimeUrl && migrationUrl ? describe : describe.skip;

interface PgPool {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
const { Pool } = createRequire(new URL("../../storage/package.json", import.meta.url))("pg") as {
  Pool: new (config: { connectionString?: string | undefined }) => PgPool;
};
type Effects = ReturnType<typeof createEffects>;
type TableQueue = ReturnType<typeof createTableQueue>;
interface Snapshot {
  readonly id: string;
  readonly status: string;
  readonly output?: unknown;
  readonly steps: readonly { readonly name: string; readonly status: string }[];
}
const LEASE_MS = 60_000;

/** A clock the tests move forward; the kernel, workers, drain and claims all read it. */
function testClock() {
  const clock = { offset: 0, now: () => new Date(Date.now() + clock.offset) };
  return clock;
}
type TestClock = ReturnType<typeof testClock>;

suite("M20 queue-woken durable runtime under the PostgreSQL runtime role", () => {
  let effects: Effects;
  let tables: TableQueue;
  let owner: PgPool;
  const kernels: Kernel[] = [];

  const runtime = async (queue: WakeQueue, clock: TestClock = testClock()) => {
    const base = new PostgresStorage(
      { connectionString: runtimeUrl, max: 5 },
      { schemaMode: "verify" },
    );
    const storage = wakingStorage(base, { appId: APP_ID, queue, clock });
    const kernel = new Kernel({
      profile: "durable",
      plugins: createPlugins(effects),
      storage,
      now: clock.now,
    });
    await kernel.boot();
    kernels.push(kernel);
    const drain = createDurableDrain({ appId: APP_ID, storage, kernel, queue, clock });
    return { storage, kernel, drain, clock };
  };
  const org = () => `m20-${randomUUID().slice(0, 8)}`;
  const order = (kernel: Kernel, orgId: string, input: Record<string, unknown>) =>
    kernel.execute("shop.order", input, { principal: principal(orgId) });
  const workflow = async (
    kernel: Kernel,
    orgId: string,
    operation: "start" | "status" | "cancel",
    input: unknown,
    name = "fulfil",
  ) =>
    (await kernel.execute(`shop.${name}.${operation}`, input, {
      principal: principal(orgId),
    })) as Snapshot;
  /** Delivers due tasks as the queue would: acknowledge on success, keep on a retry answer. */
  const deliver = async (queue: MemoryWakeQueue, drain: DurableDrain, clock: TestClock) => {
    const results: DrainResult[] = [];
    for (let round = 0; round < 400; round++) {
      const [task] = queue.due(clock.now());
      if (task === undefined) return results;
      const result = await drain.drain(task.body);
      results.push(result);
      if (result.retry) return results;
      queue.acknowledge(task.name);
    }
    throw new Error("Wake tasks did not quiesce");
  };
  const deliverTable = async (orgId: string, drain: DurableDrain, clock: TestClock) => {
    const results: DrainResult[] = [];
    for (let round = 0; round < 400; round++) {
      const [task] = await tables.due(orgId, clock.now());
      if (task === undefined) return results;
      const result = await drain.drain(task.body);
      results.push(result);
      if (result.retry) return results;
      await tables.acknowledge(task.name);
    }
    throw new Error("Wake tasks did not quiesce");
  };
  const outbox = async (orgId: string) =>
    (
      await owner.query(
        "SELECT id, status, completed_at FROM embody_outbox WHERE org_id = $1 ORDER BY occurred_at",
        [orgId],
      )
    ).rows;

  let releaseClaimLock: () => Promise<void> = () => Promise.resolve();
  beforeAll(async () => {
    releaseClaimLock = await holdClaimLock(migrationUrl!);
    owner = new Pool({ connectionString: migrationUrl });
    const role = decodeURIComponent(new URL(runtimeUrl!).username);
    await owner.query(FIXTURE_TABLES);
    await owner.query(FIXTURE_GRANTS(role));
    // Drains claim every due step in the database. While this suite holds the claim lock, clear
    // instances left by earlier runs of any claiming suite so they cannot take batch slots.
    await owner.query("DELETE FROM embody_workflow_instances");
    await owner.query("DELETE FROM embody_outbox WHERE org_id LIKE 'm20-%'");
    await owner.query("DELETE FROM m20_tasks");
    effects = createEffects(runtimeUrl!);
    tables = createTableQueue(runtimeUrl!);
  }, 300_000);
  afterAll(async () => {
    try {
      await Promise.all(kernels.map((kernel) => kernel.stop()));
      await owner?.query("DELETE FROM embody_workflow_instances WHERE org_id LIKE 'm20-%'");
      await effects?.close();
      await tables?.close();
      await owner?.end();
    } finally {
      await releaseClaimLock();
    }
  });

  it("enqueues a wake before commit and handles the event only when the task arrives", async () => {
    const queue = new MemoryWakeQueue();
    const { kernel, drain, storage, clock } = await runtime(queue);
    const tenant = org();
    await order(kernel, tenant, { orderId: tenant });
    expect(queue.tasks).toHaveLength(1);
    const [task] = queue.tasks;
    expect(task!.body).toMatchObject({ v: 1, app: APP_ID, org: tenant, kind: "event" });
    expect(task!.body.txid).toMatch(/^\d+$/);
    expect(await storage.transactionStatus!(task!.body.txid!)).toBe("committed");
    // Nothing runs until the task arrives.
    expect((await effects.ledger(`ordered:${tenant}`)).effects).toEqual([]);
    expect((await outbox(tenant))[0]?.["status"]).toBe("pending");
    const results = await deliver(queue, drain, clock);
    expect(results[0]).toMatchObject({ retry: false, outcome: "processed", events: 1 });
    expect(await effects.ledger(`ordered:${tenant}`)).toEqual({
      effects: [`ordered:${tenant}:0`],
      attempts: { [`ordered:${tenant}:0`]: 1 },
    });
    const [row] = await outbox(tenant);
    expect(row?.["status"]).toBe("completed");
    expect(row?.["completed_at"]).toBeInstanceOf(Date);
    // Completion schedules the tenant's retention cleanup inside the 30-day queue limit.
    const cleanup = queue.tasks.find((item) => item.body.kind === "cleanup")!;
    const ahead = Date.parse(cleanup.scheduleAt) - Date.now();
    expect(ahead).toBeGreaterThan(29 * 24 * 60 * 60_000);
    expect(ahead).toBeLessThanOrEqual(30 * 24 * 60 * 60_000);
    expect(await deliver(queue, drain, clock)).toEqual([]);
  });

  it("M20.c: a queue outage fails publishing and workflow starts and rolls both back", async () => {
    const queue = new MemoryWakeQueue();
    const { kernel } = await runtime(queue);
    const tenant = org();
    queue.outage = true;
    await expect(order(kernel, tenant, { orderId: tenant })).rejects.toBeInstanceOf(
      UnavailableError,
    );
    await expect(
      workflow(kernel, tenant, "start", { input: { orderId: tenant }, idempotencyKey: tenant }),
    ).rejects.toBeInstanceOf(UnavailableError);
    expect(await outbox(tenant)).toEqual([]);
    expect(
      (await owner.query("SELECT 1 FROM embody_workflow_instances WHERE org_id = $1", [tenant]))
        .rows,
    ).toEqual([]);
    queue.outage = false;
    await order(kernel, tenant, { orderId: tenant });
    expect(await outbox(tenant)).toHaveLength(1);
  });

  it("retries a task that arrives before its transaction commits; ignores one after rollback", async () => {
    const tasks: WakeTask[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let failSecond = false;
    // Holds the transaction open after the task exists, or fails the second enqueue.
    const gated: WakeQueue = {
      enqueue: async (task) => {
        if (failSecond && tasks.length === 1) throw new Error("queue failed mid-transaction");
        tasks.push(task);
        if (!failSecond) await held;
        return "created";
      },
    };
    const { kernel, drain } = await runtime(gated);
    const tenant = org();
    const pending = order(kernel, tenant, { orderId: tenant });
    await vi.waitFor(() => expect(tasks).toHaveLength(1));
    expect(await drain.drain(tasks[0]!.body)).toMatchObject({
      retry: true,
      outcome: "uncommitted",
    });
    expect((await effects.ledger(`ordered:${tenant}`)).effects).toEqual([]);
    release();
    await pending;
    expect(await drain.drain(tasks[0]!.body)).toMatchObject({ retry: false, events: 1 });
    expect((await effects.ledger(`ordered:${tenant}`)).effects).toHaveLength(1);

    // The first task was created, then the transaction rolled back.
    tasks.length = 0;
    failSecond = true;
    const rolledBack = org();
    await expect(order(kernel, rolledBack, { orderId: rolledBack, events: 2 })).rejects.toThrow();
    expect(tasks).toHaveLength(1);
    expect(await drain.drain(tasks[0]!.body)).toMatchObject({
      retry: false,
      outcome: "rolled-back",
      events: 0,
    });
    expect(await outbox(rolledBack)).toEqual([]);
  });

  it("M20.c: a delayed step never runs early and runs once when due", async () => {
    const queue = new MemoryWakeQueue();
    const { kernel, drain, clock } = await runtime(queue);
    const tenant = org();
    const started = await workflow(kernel, tenant, "start", {
      input: { orderId: tenant },
      idempotencyKey: tenant,
    });
    await deliver(queue, drain, clock);
    // Lease wakes carry no instance; the delayed step's own wake does.
    const ship = queue.tasks.find(
      (task) =>
        task.body.kind === "step" &&
        task.body.instance !== undefined &&
        Date.parse(task.scheduleAt) > Date.now(),
    )!;
    expect(Date.parse(ship.scheduleAt) - Date.parse(queue.tasks[0]!.scheduleAt)).toBe(
      SHIP_DELAY_MS,
    );
    expect((await effects.ledger(started.id)).effects).toEqual([`${started.id}:reserve`]);
    // A task delivered before its time (clock skew) reschedules itself and runs nothing.
    expect(await drain.drain(ship.body)).toMatchObject({
      retry: false,
      outcome: "early",
      followUps: 1,
    });
    expect(queue.tasks.at(-1)!.scheduleAt).toBe(ship.scheduleAt);
    expect((await effects.ledger(started.id)).effects).not.toContain(`${started.id}:ship`);
    clock.offset = SHIP_DELAY_MS + 1_000;
    await deliver(queue, drain, clock);
    const done = await workflow(kernel, tenant, "status", { id: started.id });
    expect(done.status).toBe("completed");
    expect(done.output).toEqual({ shipped: tenant });
    expect((await effects.ledger(started.id)).attempts).toEqual({
      [`${started.id}:reserve`]: 1,
      [`${started.id}:ship`]: 1,
    });
  });

  it("schedules retry backoff as a task at the retry time", async () => {
    const queue = new MemoryWakeQueue();
    const { kernel, drain, clock } = await runtime(queue);
    const tenant = org();
    const started = await workflow(
      kernel,
      tenant,
      "start",
      { input: { failures: 1 }, idempotencyKey: tenant },
      "flaky",
    );
    await deliver(queue, drain, clock);
    expect((await workflow(kernel, tenant, "status", { id: started.id }, "flaky")).status).toBe(
      "waiting",
    );
    const retry = queue.tasks.at(-1)!;
    expect(Date.parse(retry.scheduleAt) - Date.now()).toBeGreaterThan(4_000);
    clock.offset = 6_000;
    await deliver(queue, drain, clock);
    expect((await workflow(kernel, tenant, "status", { id: started.id }, "flaky")).status).toBe(
      "completed",
    );
    expect((await effects.ledger(started.id)).effects).toEqual([`${started.id}:call`]);
  });

  it("cancellation wakes compensation", async () => {
    const queue = new MemoryWakeQueue();
    const { kernel, drain, clock } = await runtime(queue);
    const tenant = org();
    const started = await workflow(kernel, tenant, "start", {
      input: { orderId: tenant },
      idempotencyKey: tenant,
    });
    await deliver(queue, drain, clock);
    const before = queue.tasks.length;
    await workflow(kernel, tenant, "cancel", { id: started.id });
    expect(queue.tasks.length).toBe(before + 1);
    await deliver(queue, drain, clock);
    expect((await workflow(kernel, tenant, "status", { id: started.id })).status).toBe(
      "compensated",
    );
    expect((await effects.ledger(started.id)).effects).toEqual([
      `${started.id}:reserve`,
      `${started.id}:undo:reserve`,
    ]);
  });

  it("M20.c: rejects drains for another app and malformed requests", async () => {
    const queue = new MemoryWakeQueue();
    const { kernel, drain } = await runtime(queue);
    const tenant = org();
    await order(kernel, tenant, { orderId: tenant });
    const body = queue.tasks[0]!.body;
    await expect(drain.drain({ ...body, app: "billing" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(drain.drain({ ...body, extra: true })).rejects.toBeInstanceOf(ValidationError);
    await expect(drain.drain({ ...body, kind: "event", id: undefined })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await effects.ledger(`ordered:${tenant}`)).effects).toEqual([]);
  });

  it("MD12: re-enqueues overdue work after an inbound request, with no periodic sweep", async () => {
    const lost = new MemoryWakeQueue();
    const { kernel } = await runtime(lost);
    const tenant = org();
    await order(kernel, tenant, { orderId: tenant });
    // The task is lost (or gave up). A later runtime sees the overdue event.
    const queue = new MemoryWakeQueue();
    const later = await runtime(queue);
    expect(await later.drain.recover(tenant)).toBe(false);
    later.clock.offset = 2 * 60_000;
    expect(await later.drain.recover(tenant)).toBe(true);
    // At most one check per tenant and minute.
    expect(await later.drain.recover(tenant)).toBe(false);
    expect(queue.tasks.map((task) => task.body.kind)).toEqual(["sweep"]);
    await deliver(queue, later.drain, later.clock);
    expect((await effects.ledger(`ordered:${tenant}`)).effects).toHaveLength(1);
    later.clock.offset = 4 * 60_000;
    expect(await later.drain.recover(tenant)).toBe(false);
  });

  it("fails closed above the per-transaction wake quota", async () => {
    const queue = new MemoryWakeQueue();
    const { kernel } = await runtime(queue);
    const tenant = org();
    await expect(order(kernel, tenant, { orderId: tenant, events: 101 })).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(await outbox(tenant)).toEqual([]);
    expect(queue.tasks).toEqual([]);
  });

  it("purges completed records after 30 days, keeps dead letters and keeps a cleanup scheduled", async () => {
    const queue = new MemoryWakeQueue();
    const { kernel, drain, clock } = await runtime(queue);
    const tenant = org();
    await order(kernel, tenant, { orderId: tenant, events: 3 });
    await deliver(queue, drain, clock);
    const [old, dead, recent] = (await outbox(tenant)).map((row) => String(row["id"]));
    const past = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString();
    await owner.query("UPDATE embody_outbox SET completed_at = $2 WHERE id = $1", [old, past]);
    await owner.query("UPDATE embody_inbox SET updated_at = $2 WHERE event_id = $1", [old, past]);
    await owner.query(
      "UPDATE embody_outbox SET status = 'dead_letter', completed_at = NULL WHERE id = $1",
      [dead],
    );
    const due = new Date().toISOString();
    const name = `cleanup-test-${tenant}`;
    const result = await drain.drain({
      v: 1,
      app: APP_ID,
      org: tenant,
      kind: "cleanup",
      due,
      name,
    } satisfies DrainRequest);
    expect(result).toMatchObject({ outcome: "cleaned", followUps: 1 });
    const remaining = await outbox(tenant);
    expect(remaining.map((row) => row["id"]).sort()).toEqual([dead, recent].sort());
    expect(
      (await owner.query("SELECT 1 FROM embody_inbox WHERE event_id = $1", [old])).rows,
    ).toEqual([]);
    const next = queue.tasks.at(-1)!;
    expect(next.body.kind).toBe("cleanup");
    expect(Date.parse(next.scheduleAt) - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60_000);
  });

  it("B3: wide fan-out collapses into chained sweeps and completes", async () => {
    const queue = new MemoryWakeQueue();
    const { kernel, drain, clock } = await runtime(queue);
    const tenant = org();
    const started = await workflow(
      kernel,
      tenant,
      "start",
      { input: {}, idempotencyKey: tenant },
      "fan",
    );
    await deliver(queue, drain, clock);
    const ledger = await effects.ledger(started.id);
    expect(ledger.effects).toHaveLength(1 + FAN_LEAVES);
    expect(Object.values(ledger.attempts).every((attempts) => attempts === 1)).toBe(true);
    // Root's transaction made 40 steps runnable with one sweep, not 40 tasks.
    const fromRoot = queue.tasks.filter((task) => task.body.kind === "step" && task.body.instance);
    expect(fromRoot.length).toBeLessThanOrEqual(2);
    clock.offset = SHIP_DELAY_MS + 1_000;
    await deliver(queue, drain, clock);
    expect((await workflow(kernel, tenant, "status", { id: started.id }, "fan")).status).toBe(
      "completed",
    );
  });

  it("B3: cancelling 40 completed steps compensates them all in reverse order, O(1) tasks per change", async () => {
    const queue = new MemoryWakeQueue();
    const { kernel, drain, clock } = await runtime(queue);
    const tenant = org();
    const started = await workflow(
      kernel,
      tenant,
      "start",
      { input: {}, idempotencyKey: tenant },
      "fan",
    );
    await deliver(queue, drain, clock);
    const before = queue.tasks.length;
    await workflow(kernel, tenant, "cancel", { id: started.id }, "fan");
    expect(queue.tasks.length - before).toBe(1);
    await deliver(queue, drain, clock);
    expect((await workflow(kernel, tenant, "status", { id: started.id }, "fan")).status).toBe(
      "compensated",
    );
    const undone = (await effects.ledger(`${started.id}:undo:`)).attempts;
    expect(Object.keys(undone)).toHaveLength(FAN_LEAVES);
    expect(Object.values(undone).every((attempts) => attempts === 1)).toBe(true);
  });

  it("B3: a step whose results can never be scheduled fails once instead of looping", async () => {
    const queue = new MemoryWakeQueue();
    const { kernel, drain, clock } = await runtime(queue);
    const tenant = org();
    const started = await workflow(
      kernel,
      tenant,
      "start",
      { input: {}, idempotencyKey: tenant },
      "noisy",
    );
    await deliver(queue, drain, clock);
    const failed = await workflow(kernel, tenant, "status", { id: started.id }, "noisy");
    expect(failed.status).toBe("failed");
    // Lease wakes arrive later and find nothing to rerun.
    clock.offset = LEASE_MS + 2_000;
    await deliver(queue, drain, clock);
    expect((await effects.ledger(started.id)).attempts).toEqual({ [`${started.id}:shout`]: 1 });
    expect(
      (await owner.query("SELECT 1 FROM embody_outbox WHERE org_id = $1", [tenant])).rows,
    ).toEqual([]);
  });

  describe("M20.b crash matrix (killed processes)", () => {
    const child = (env: Record<string, string>) =>
      spawn(process.execPath, ["test/fixtures/m20-crash-child.mjs"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    /** Runs the child to `point` and SIGKILLs it there; with no point, runs it to completion. */
    const runChild = async (env: Record<string, string>, point?: string) => {
      const process = child({ ...env, ...(point === undefined ? {} : { M20_CRASH_AT: point }) });
      let stderr = "";
      process.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${point} not reached`)), 15_000);
          process.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            if (point !== undefined && text.includes(`PAUSED ${point}`)) {
              clearTimeout(timer);
              resolve();
            } else if (text.includes("DONE")) {
              clearTimeout(timer);
              if (point === undefined) resolve();
              else reject(new Error(`Child finished without reaching ${point}`));
            }
          });
          process.once("exit", (code) => {
            clearTimeout(timer);
            if (point !== undefined || code !== 0)
              reject(new Error(`Child exited (${code}) before ${point}: ${stderr}`));
          });
        });
      } finally {
        if (process.exitCode === null && process.signalCode === null) {
          const exited = once(process, "exit");
          process.kill("SIGKILL");
          await exited;
        }
      }
    };
    const tableRuntime = () => runtime(tables);
    /** After a SIGKILL the server aborts the transaction once it notices the closed socket. */
    const settled = async (drain: DurableDrain, body: DrainRequest) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await drain.drain(body);
        if (result.outcome !== "uncommitted") return result;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Transaction outcome never settled");
    };

    it("killed before enqueue: nothing committed and nothing scheduled", async () => {
      const tenant = org();
      await runChild({ M20_MODE: "action", M20_ORG: tenant, M20_ORDER: tenant }, "after-publish");
      expect(await tables.all(tenant)).toEqual([]);
      expect(await outbox(tenant)).toEqual([]);
    });

    it("killed after enqueue, before commit: the task is a no-op", async () => {
      const tenant = org();
      await runChild({ M20_MODE: "action", M20_ORG: tenant, M20_ORDER: tenant }, "after-enqueue");
      const [task] = await tables.due(tenant);
      expect(task).toBeDefined();
      const { drain } = await tableRuntime();
      expect(await settled(drain, task!.body)).toMatchObject({ outcome: "rolled-back" });
      expect(await outbox(tenant)).toEqual([]);
      expect((await effects.ledger(`ordered:${tenant}`)).effects).toEqual([]);
    });

    it("killed after commit, before any drain: the task delivers the work once", async () => {
      const tenant = org();
      await runChild({ M20_MODE: "action", M20_ORG: tenant, M20_ORDER: tenant });
      const { drain, clock } = await tableRuntime();
      await deliverTable(tenant, drain, clock);
      expect(await effects.ledger(`ordered:${tenant}`)).toEqual({
        effects: [`ordered:${tenant}:0`],
        attempts: { [`ordered:${tenant}:0`]: 1 },
      });
    });

    it.each([
      ["mid-batch, before the effect", "before-event-effect", 1],
      ["after the effect, before commit", "after-event-effect", 2],
    ])(
      "killed %s: redelivery after the lease applies one logical effect",
      async (_label, point, attempts) => {
        const tenant = org();
        const { kernel, drain, clock } = await tableRuntime();
        await order(kernel, tenant, { orderId: tenant });
        const [task] = await tables.due(tenant);
        await runChild({ M20_MODE: "drain", M20_TASK: JSON.stringify(task!.body) }, point);
        // The queue redelivers the failed task; the event is still leased, so a follow-up waits.
        expect(await drain.drain(task!.body)).toMatchObject({ events: 0, followUps: 1 });
        await tables.acknowledge(task!.name);
        expect((await outbox(tenant))[0]?.["status"]).toBe("processing");
        clock.offset = LEASE_MS + 2_000;
        await deliverTable(tenant, drain, clock);
        expect((await outbox(tenant))[0]?.["status"]).toBe("completed");
        expect(await effects.ledger(`ordered:${tenant}`)).toEqual({
          effects: [`ordered:${tenant}:0`],
          attempts: { [`ordered:${tenant}:0`]: attempts },
        });
      },
    );

    it("killed after the effect committed, before acknowledgement: redelivery is a no-op", async () => {
      const tenant = org();
      const { kernel, drain, clock } = await tableRuntime();
      await order(kernel, tenant, { orderId: tenant });
      const [task] = await tables.due(tenant);
      await runChild(
        { M20_MODE: "drain", M20_TASK: JSON.stringify(task!.body) },
        "before-acknowledge",
      );
      expect(await drain.drain(task!.body)).toMatchObject({ events: 0, followUps: 0 });
      await tables.acknowledge(task!.name);
      await deliverTable(tenant, drain, clock);
      expect(await effects.ledger(`ordered:${tenant}`)).toEqual({
        effects: [`ordered:${tenant}:0`],
        attempts: { [`ordered:${tenant}:0`]: 1 },
      });
    });

    it("B1: a drain that dies holding another task's step leaves a lease wake", async () => {
      const owned = org();
      const other = org();
      const { kernel, drain, clock } = await tableRuntime();
      const started = await workflow(kernel, owned, "start", {
        input: { orderId: owned },
        idempotencyKey: owned,
      });
      // The step's own task was already answered, as when an earlier batch was full.
      for (const task of await tables.due(owned)) await tables.acknowledge(task.name);
      await order(kernel, other, { orderId: other });
      const [task] = await tables.due(other);
      // The other tenant's event drain claims the step (claims are global) and dies in it.
      await runChild(
        { M20_MODE: "drain", M20_TASK: JSON.stringify(task!.body) },
        "before-step-effect",
      );
      expect(await drain.drain(task!.body)).toMatchObject({ outcome: "processed" });
      await tables.acknowledge(task!.name);
      clock.offset = LEASE_MS + 2_000;
      await deliverTable(owned, drain, clock);
      expect((await workflow(kernel, owned, "status", { id: started.id })).status).toBe(
        "completed",
      );
      expect((await effects.ledger(started.id)).attempts).toEqual({
        [`${started.id}:reserve`]: 1,
        [`${started.id}:ship`]: 1,
      });
    });

    it("B2: a drain that dies in a compensation leaves a lease wake", async () => {
      const tenant = org();
      const { kernel, drain, clock } = await tableRuntime();
      const started = await workflow(kernel, tenant, "start", {
        input: { orderId: tenant },
        idempotencyKey: tenant,
      });
      await deliverTable(tenant, drain, clock);
      await workflow(kernel, tenant, "cancel", { id: started.id });
      const [sweep] = (await tables.due(tenant)).filter((task) => task.body.kind === "sweep");
      await runChild(
        { M20_MODE: "drain", M20_TASK: JSON.stringify(sweep!.body) },
        "in-compensation",
      );
      expect(await drain.drain(sweep!.body)).toMatchObject({ outcome: "processed", steps: 0 });
      await tables.acknowledge(sweep!.name);
      clock.offset = LEASE_MS + 2_000;
      await deliverTable(tenant, drain, clock);
      expect((await workflow(kernel, tenant, "status", { id: started.id })).status).toBe(
        "compensated",
      );
      expect((await effects.ledger(`${started.id}:undo`)).effects).toEqual([
        `${started.id}:undo:reserve`,
      ]);
    });

    it("killed mid-step after its effect: the step reruns after its lease, one logical effect", async () => {
      const tenant = org();
      const { kernel, drain, clock } = await tableRuntime();
      const started = await workflow(kernel, tenant, "start", {
        input: { orderId: tenant },
        idempotencyKey: tenant,
      });
      const [task] = await tables.due(tenant);
      expect(task!.body.kind).toBe("step");
      await runChild(
        { M20_MODE: "drain", M20_TASK: JSON.stringify(task!.body) },
        "after-step-effect",
      );
      expect(await drain.drain(task!.body)).toMatchObject({ steps: 0, followUps: 1 });
      await tables.acknowledge(task!.name);
      clock.offset = LEASE_MS + 2_000;
      await deliverTable(tenant, drain, clock);
      expect((await workflow(kernel, tenant, "status", { id: started.id })).status).toBe(
        "completed",
      );
      expect(await effects.ledger(started.id)).toEqual({
        effects: [`${started.id}:reserve`, `${started.id}:ship`],
        attempts: { [`${started.id}:reserve`]: 2, [`${started.id}:ship`]: 1 },
      });
    });
  });

  it("M20.a: hosted durable cold boots start no timers or work; the drain needs platform identity", async () => {
    const queue = new MemoryWakeQueue();
    const intervals = vi.spyOn(globalThis, "setInterval");
    const env = {
      NODE_ENV: "production",
      EMBODY_HOST_PROFILE: "hosted",
      EMBODY_HOSTED_PROFILE: "durable",
      DATABASE_URL: runtimeUrl,
      EMBODY_WORKSPACE_ID: "ws_m20durable",
      GATEWAY_JWT_ISSUER: "https://gateway.example",
      GATEWAY_JWKS_URL: "https://gateway.example/jwks",
      EMBODY_WAKE_QUEUE: "projects/embody-test/locations/us-central1/queues/shop",
      EMBODY_DRAIN_URL: "https://shop.example.run.app/_embody/drain",
      EMBODY_DRAIN_AUDIENCE: "https://shop.example.run.app",
      EMBODY_DRAIN_INVOKER_EMAIL: "embody-invoker@embody-test.iam.gserviceaccount.com",
      PORT: "0",
    };
    const before = await effects.ledger("");
    for (let boot = 0; boot < 20; boot++) {
      const host = await createAppHost(
        { appId: APP_ID, version: "1.0.0", plugins: createPlugins(effects) },
        { env, wakeQueue: queue, host: "127.0.0.1" },
      );
      const url = await host.start();
      if (boot === 0) {
        await expect(host.tickEvents()).rejects.toThrow(/wake task/);
        for (const authorization of [undefined, "Bearer not-a-token"]) {
          const response = await fetch(new URL("/_embody/drain", url), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(authorization === undefined ? {} : { authorization }),
            },
            body: "{}",
          });
          expect(response.status).toBe(401);
        }
      }
      await host.stop();
    }
    expect(intervals).not.toHaveBeenCalled();
    expect(queue.tasks).toEqual([]);
    expect(await effects.ledger("")).toEqual(before);
  });
});
