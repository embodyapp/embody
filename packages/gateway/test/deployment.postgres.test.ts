import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submissionFingerprint, type DeploymentSubmission } from "@embody/cloud-contracts";
import {
  BuildAdmission,
  DEPLOYMENT_LIMITS,
  DeploymentController,
  MemorySourceObjectStore,
  PostgresGatewayStore,
  deploymentWakeHook,
  type DeploymentRecord,
  type DeploymentTaskBody,
  type TaskResult,
} from "../src/index.js";
import { APP, seedDeployableApp } from "./deployment-fixture.js";
import {
  createFixtureTables,
  createTableBuildProvider,
  createTableQueue,
  createTableStages,
  recipe,
} from "./fixtures/m12-fixtures.mjs";

const url = process.env["EMBODY_PLATFORM_URL"];
const migrationUrl = process.env["EMBODY_PLATFORM_MIGRATION_URL"];
if (process.env["EMBODY_PLATFORM_REQUIRED"] === "true" && (!url || !migrationUrl))
  throw new Error("Required platform PostgreSQL configuration missing");

type Queue = ReturnType<typeof createTableQueue>;
interface Task {
  name: string;
  scheduleAt: string;
  body: DeploymentTaskBody;
}

// Ordinary workspace tests may skip; `pnpm test:m12` runs this file with zero skips.
describe.skipIf(!url || !migrationUrl)("M12 controller on real PostgreSQL (test:m12)", () => {
  let store: PostgresGatewayStore;
  let queue: Queue;
  let provider: ReturnType<typeof createTableBuildProvider>;
  let stages: ReturnType<typeof createTableStages>;
  let offset = 0;
  const clock = { now: () => new Date(Date.now() + offset) };
  beforeAll(async () => {
    await createFixtureTables(migrationUrl!, decodeURIComponent(new URL(url!).username));
    store = new PostgresGatewayStore(url!);
    queue = createTableQueue(url!);
    provider = createTableBuildProvider(url!);
    stages = createTableStages(url!);
  });
  afterAll(async () => {
    await Promise.all([store.close(), queue.close(), provider.close(), stages.close()]);
  });
  const controllerFor = (target = store) =>
    new DeploymentController({
      store: target,
      queue,
      builds: new BuildAdmission({
        store: target,
        provider,
        recipe,
        sources: new MemorySourceObjectStore({ clock }),
        clock,
      }),
      stages,
      clock,
    });
  const workspace = () => `ws_${randomBytes(8).toString("hex")}`;
  const seed = async (ws: string) => seedDeployableApp(store, ws, clock.now());
  const submit = (submission: DeploymentSubmission) =>
    store.submitDeployment(
      {
        submission,
        fingerprint: submissionFingerprint(submission),
        actorId: "alice",
        now: clock.now(),
      },
      deploymentWakeHook(queue),
    );
  /** Cloud Tasks stand-in: deliver due tasks of one workspace, jump the clock when idle. */
  const drive = async (ws: string, controller = controllerFor()) => {
    const results: TaskResult[] = [];
    for (let round = 0; round < 300; round++) {
      const due = (await queue.due(ws, clock.now())) as Task[];
      if (due.length === 0) {
        const pending = (await queue.pending(ws)) as Task[];
        if (pending.length === 0) return results;
        const next = Math.min(...pending.map((t) => Date.parse(t.scheduleAt)));
        offset += Math.max(1000, next - clock.now().getTime());
        continue;
      }
      const result = await controller.handle(due[0]!.body);
      results.push(result);
      if (result.status === 503) offset += 5000;
      else await queue.acknowledge(due[0]!.name);
    }
    throw new Error("Deployment did not settle");
  };
  const only = async (ws: string): Promise<DeploymentRecord[]> => {
    const records: DeploymentRecord[] = [];
    for (const task of (await queue.pending(ws)) as Task[]) {
      const record = await store.deployment(ws, APP, task.body.deploymentId);
      if (record && !records.some((r) => r.deploymentId === record.deploymentId))
        records.push(record);
    }
    return records;
  };
  const expectOneActive = async (
    ws: string,
    record: { deploymentId: string },
    generation: number,
  ) => {
    const final = await store.deployment(ws, APP, record.deploymentId);
    expect(final).toMatchObject({ state: "active" });
    expect(await store.appStatus(ws, APP)).toMatchObject({
      generation: generation + 1,
      activeReleaseId: final!.releaseId,
    });
    expect(await provider.buildsFor(record.deploymentId)).toHaveLength(1);
    expect(await stages.resources(ws)).toHaveLength(1);
    expect(await queue.pending(ws)).toEqual([]);
    return final!;
  };

  it("a task delivered before its transaction commits is retried (503); after a rollback it is a no-op", async () => {
    const ws = workspace();
    const { submission } = await seed(ws);
    const early = new PostgresGatewayStore(url!);
    const earlyController = controllerFor(early);
    let seen: TaskResult | undefined;
    try {
      await store.submitDeployment(
        {
          submission: submission(),
          fingerprint: submissionFingerprint(submission()),
          actorId: "a",
          now: clock.now(),
        },
        async (wakes, txid) => {
          await deploymentWakeHook(queue)(wakes, txid);
          const [task] = (await queue.pending(ws)) as Task[];
          seen = await earlyController.handle(task!.body);
        },
      );
      expect(seen).toMatchObject({ status: 503, outcome: "uncommitted" });
      const ws2 = workspace();
      const second = await seed(ws2);
      await expect(
        store.submitDeployment(
          {
            submission: second.submission(),
            fingerprint: submissionFingerprint(second.submission()),
            actorId: "a",
            now: clock.now(),
          },
          async (wakes, txid) => {
            await deploymentWakeHook(queue)(wakes, txid);
            throw new Error("crash before commit");
          },
        ),
      ).rejects.toThrow(/crash/);
      const [orphan] = (await queue.pending(ws2)) as Task[];
      expect(await earlyController.handle(orphan!.body)).toMatchObject({
        status: 200,
        outcome: "missing",
      });
      // The rolled-back submission neither pinned nor extended the source.
      expect(await store.source(ws2, APP, second.source.uploadId)).toMatchObject({
        revision: second.source.revision,
        retainUntil: second.source.retainUntil,
      });
      expect((await store.source(ws2, APP, second.source.uploadId))?.pinnedBy).toBeUndefined();
    } finally {
      await early.close();
    }
  });

  it("M12.b: concurrent deliveries across worker processes' pools claim once; one build, one release", async () => {
    const ws = workspace();
    const { submission, app } = await seed(ws);
    const { record } = await submit(submission());
    const others = [new PostgresGatewayStore(url!), new PostgresGatewayStore(url!)];
    try {
      const controllers = [controllerFor(), ...others.map((s) => controllerFor(s))];
      const [task] = (await queue.pending(ws)) as Task[];
      const results = await Promise.all(
        Array.from({ length: 9 }, (_, i) => controllers[i % 3]!.handle(task!.body)),
      );
      expect(results.filter((r) => r.outcome.startsWith("advance"))).toHaveLength(1);
      // Keep redelivering through all three while driving.
      for (let round = 0; round < 200; round++) {
        const due = (await queue.due(ws, clock.now())) as Task[];
        if (due.length === 0) {
          const pending = (await queue.pending(ws)) as Task[];
          if (pending.length === 0) break;
          offset += Math.max(
            1000,
            Math.min(...pending.map((t) => Date.parse(t.scheduleAt))) - clock.now().getTime(),
          );
          continue;
        }
        await Promise.all(controllers.map((c) => c.handle(due[0]!.body)));
        await queue.acknowledge(due[0]!.name);
      }
      await expectOneActive(ws, record, app.generation);
    } finally {
      await Promise.all(others.map((s) => s.close()));
    }
  });

  it("M12.b: cancellation racing promotion on separate connections never yields both", async () => {
    for (let round = 0; round < 6; round++) {
      const ws = workspace();
      const { submission, app } = await seed(ws);
      const { record } = await submit(submission());
      // Drive to promoting, holding the promotion task back.
      const controller = controllerFor();
      for (let i = 0; i < 100; i++) {
        const current = await store.deployment(ws, APP, record.deploymentId);
        if (current?.state === "promoting") break;
        const due = (await queue.due(ws, clock.now())) as Task[];
        if (!due.length) {
          offset += 16_000;
          continue;
        }
        await controller.handle(due[0]!.body);
        await queue.acknowledge(due[0]!.name);
      }
      expect(await store.deployment(ws, APP, record.deploymentId)).toMatchObject({
        state: "promoting",
      });
      const canceller = new PostgresGatewayStore(url!);
      try {
        const due = (await queue.due(ws, clock.now())) as Task[];
        const [promoted, cancelled] = await Promise.allSettled([
          controller.handle(due[0]!.body),
          canceller.cancelDeployment(
            { workspaceId: ws, appId: APP, deploymentId: record.deploymentId },
            0,
            clock.now(),
            deploymentWakeHook(queue),
          ),
        ]);
        void promoted;
        await drive(ws);
        const final = await store.deployment(ws, APP, record.deploymentId);
        const status = await store.appStatus(ws, APP);
        if (final!.state === "active") {
          expect(cancelled.status).toBe("rejected");
          expect(status!.generation).toBe(app.generation + 1);
        } else {
          expect(final!.state).toBe("cancelled");
          expect(cancelled.status).toBe("fulfilled");
          expect(status).toMatchObject({
            generation: app.generation,
            activeReleaseId: app.activeRelease,
          });
          expect(await stages.resources(ws)).toEqual([]);
        }
      } finally {
        await canceller.close();
      }
    }
  });

  it("M12.c: a queue outage mid-flight rolls back and recovers on redelivery", async () => {
    const ws = workspace();
    const { submission, app } = await seed(ws);
    const { record } = await submit(submission());
    const [task] = (await queue.pending(ws)) as Task[];
    queue.outage = true;
    expect(await controllerFor().handle(task!.body)).toMatchObject({ status: 503 });
    expect(await store.deployment(ws, APP, record.deploymentId)).toMatchObject({ epoch: 1 });
    queue.outage = false;
    await drive(ws);
    await expectOneActive(ws, record, app.generation);
  });

  describe("M12.a crash matrix (SIGKILLed processes)", () => {
    const run = async (env: Record<string, string>, point?: string) => {
      const child = spawn(process.execPath, ["test/fixtures/m12-crash-child.mjs"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: {
          ...process.env,
          ...env,
          M12_CLOCK_OFFSET: String(offset),
          ...(point === undefined ? {} : { M12_CRASH_AT: point }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      let stdout = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`${point} not reached: ${stderr}`)),
            20_000,
          );
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
            if (point !== undefined && stdout.includes(`PAUSED ${point}`)) {
              clearTimeout(timer);
              resolve();
            } else if (stdout.includes("DONE")) {
              clearTimeout(timer);
              if (point === undefined) resolve();
              else reject(new Error(`Child finished without reaching ${point}: ${stdout}`));
            }
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            if (point !== undefined || code !== 0)
              reject(new Error(`Child exited (${code}) before ${point}: ${stderr}`));
          });
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
      return stdout;
    };
    /** Kill the child while it handles the next due task, at `point`. */
    const crashTask = async (ws: string, point: string) => {
      for (let i = 0; i < 50; i++) {
        const due = (await queue.due(ws, clock.now())) as Task[];
        if (!due.length) {
          offset += 16_000;
          continue;
        }
        try {
          await run({ M12_MODE: "task", M12_TASK: JSON.stringify(due[0]!.body) }, point);
          return due[0]!;
        } catch (error) {
          if (!String(error).includes("finished without reaching")) throw error;
          // This task did not reach the point (another stage): it ran to completion; go on.
          await queue.acknowledge(due[0]!.name);
        }
      }
      throw new Error(`${point} never reached`);
    };
    /** After a SIGKILL the server releases the row lock once it notices the closed socket. */
    const settle = async () => new Promise((resolve) => setTimeout(resolve, 200));

    it("killed after enqueue, before commit: nothing committed, source unchanged, the task is a no-op", async () => {
      const ws = workspace();
      const { submission, source } = await seed(ws);
      await run(
        { M12_MODE: "submit", M12_SUBMISSION: JSON.stringify(submission()) },
        "after-enqueue",
      );
      await settle();
      expect(await only(ws)).toEqual([]);
      expect(await store.source(ws, APP, source.uploadId)).toMatchObject({
        revision: source.revision,
        retainUntil: source.retainUntil,
      });
      expect((await store.source(ws, APP, source.uploadId))?.pinnedBy).toBeUndefined();
      const results = await drive(ws);
      expect(results.map((r) => r.outcome)).toEqual(["missing"]);
      expect(await stages.resources(ws)).toEqual([]);
    });

    it("killed after commit, before the response: the committed task drives one active deployment", async () => {
      const ws = workspace();
      const { submission, app } = await seed(ws);
      await run(
        { M12_MODE: "submit", M12_SUBMISSION: JSON.stringify(submission()) },
        "after-commit",
      );
      const [record] = await only(ws);
      expect(record).toMatchObject({ state: "accepted" });
      // The client retries with the same key: same deployment, no second job.
      const replay = await submit(submission());
      expect(replay).toMatchObject({
        replay: true,
        record: { deploymentId: record!.deploymentId },
      });
      await drive(ws);
      await expectOneActive(ws, record!, app.generation);
    });

    it("committed but its task lost (the commit/enqueue gap): recovery re-enqueues it", async () => {
      const ws = workspace();
      const { submission, app } = await seed(ws);
      const { record } = await submit(submission());
      await queue.lose(ws);
      offset += DEPLOYMENT_LIMITS.recoveryGraceMs + 1000;
      // Any delivered task, or an authenticated request, runs recovery.
      expect((await controllerFor().reconcile(10, ws)).woken).toBe(1);
      await drive(ws);
      await expectOneActive(ws, record, app.generation);
    });

    it("killed after claiming (worker lost mid-stage): the lease wake reclaims within the lease", async () => {
      const ws = workspace();
      const { submission, app } = await seed(ws);
      const { record } = await submit(submission());
      await crashTask(ws, "after-claim");
      const claimed = await store.deployment(ws, APP, record.deploymentId);
      expect(claimed?.leaseUntil).toBeDefined();
      // Recovery bound: the claim committed its own lease wake for lease expiry + 1 s.
      const wakes = (await queue.pending(ws)) as Task[];
      const lease = wakes.find((t) => t.body.reason === "lease" && t.body.epoch === claimed!.epoch);
      expect(Date.parse(lease!.scheduleAt)).toBe(Date.parse(claimed!.leaseUntil!) + 1000);
      expect(Date.parse(claimed!.leaseUntil!) - Date.parse(claimed!.updatedAt)).toBe(
        DEPLOYMENT_LIMITS.leaseMs,
      );
      // The original task was not acknowledged (no 2xx), so it is redelivered too.
      const results = await drive(ws);
      expect(results.map((r) => r.outcome)).toContain("superseded");
      const final = await expectOneActive(ws, record, app.generation);
      expect(final.stageAttempt).toBe(1);
    });

    it("killed after the build was created, before its ID was recorded: the build is adopted, not repeated", async () => {
      const ws = workspace();
      const { submission, app } = await seed(ws);
      const { record } = await submit(submission());
      await crashTask(ws, "after-build-submit");
      const artifact = await store.artifactForAttempt(ws, APP, record.deploymentId, 1);
      expect(artifact).toMatchObject({ state: "building" });
      expect(artifact?.buildId).toBeUndefined();
      expect(await provider.buildsFor(record.deploymentId)).toHaveLength(1);
      await drive(ws);
      await expectOneActive(ws, record, app.generation);
      expect((await store.artifactForAttempt(ws, APP, record.deploymentId, 1))?.state).toBe(
        "admitted",
      );
    });

    it("killed after the candidate was created, before its receipt: provisioning adopts it", async () => {
      const ws = workspace();
      const { submission, app } = await seed(ws);
      const { record } = await submit(submission());
      await crashTask(ws, "after-provision-create");
      expect(await stages.resources(ws)).toHaveLength(1);
      expect(await store.deployment(ws, APP, record.deploymentId)).toMatchObject({
        state: "provisioning",
      });
      await drive(ws);
      await expectOneActive(ws, record, app.generation);
    });

    it("killed after a stage committed, before the task ACK: redelivery is harmless", async () => {
      const ws = workspace();
      const { submission, app } = await seed(ws);
      const { record } = await submit(submission());
      const task = await crashTask(ws, "after-complete");
      // Cloud Tasks redelivers the unacknowledged task.
      const redelivered = await controllerFor().handle(task.body);
      expect(redelivered.status).toBe(200);
      await drive(ws);
      await expectOneActive(ws, record, app.generation);
    });

    it("killed after promotion committed, before the ACK: no second promotion", async () => {
      const ws = workspace();
      const { submission, app } = await seed(ws);
      const { record } = await submit(submission());
      const task = await crashTask(ws, "after-promote");
      expect(await store.deployment(ws, APP, record.deploymentId)).toMatchObject({
        state: "active",
      });
      for (let i = 0; i < 3; i++)
        expect(await controllerFor().handle(task.body)).toMatchObject({ outcome: "terminal" });
      await drive(ws);
      const final = await expectOneActive(ws, record, app.generation);
      expect(await store.release(ws, APP, final.releaseId!)).toMatchObject({
        generation: app.generation + 1,
      });
    });
  });
});
