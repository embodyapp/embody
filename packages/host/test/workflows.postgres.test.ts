import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kernel, type Principal } from "@embody/core";
import { PostgresStorage, type StorageConnection } from "@embody/storage";
import { WorkflowWorker } from "../src/workflows.js";
import { createEffects, createPlugins } from "./fixtures/m19-workflows.mjs";
import { holdClaimLock } from "./fixtures/claim-lock.mjs";

type Effects = ReturnType<typeof createEffects>;
interface Snapshot {
  readonly id: string;
  readonly status: string;
  readonly steps: readonly { readonly name: string; readonly status: string }[];
}

const runtimeUrl = process.env["EMBODY_POSTGRES_URL"];
const migrationUrl = process.env["EMBODY_POSTGRES_MIGRATION_URL"];
if (process.env["EMBODY_POSTGRES_REQUIRED"] === "true" && (!runtimeUrl || !migrationUrl))
  throw new Error("M19 workflow proof requires EMBODY_POSTGRES_URL and _MIGRATION_URL");
const suite = runtimeUrl && migrationUrl ? describe : describe.skip;
interface PgPool {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }>;
  end(): Promise<void>;
}
type Query = (this: unknown, ...args: unknown[]) => Promise<unknown>;
const { Pool, Client } = createRequire(new URL("../../storage/package.json", import.meta.url))(
  "pg",
) as {
  Pool: new (config: { connectionString?: string | undefined }) => PgPool;
  Client: { prototype: { query: Query } };
};
const LEASE_MS = 30_000;
const terminal = new Set(["completed", "failed", "cancelled", "compensated"]);

const principal = (orgId: string): Principal => ({
  orgId,
  actorId: "m19",
  actorType: "human",
  roles: [],
  scopes: ["orders:*"],
});
const clockAt = (offsetMs: number) => ({ now: () => new Date(Date.now() + offsetMs) });

suite("M19 workflow engine under the PostgreSQL runtime role", () => {
  let effects: Effects;
  const runtimes: { storage: StorageConnection; kernel: Kernel }[] = [];
  const boot = async (storageOverride?: (storage: StorageConnection) => StorageConnection) => {
    const base = new PostgresStorage(
      { connectionString: runtimeUrl, max: 5 },
      { schemaMode: "verify" },
    );
    const storage = storageOverride ? storageOverride(base) : base;
    const kernel = new Kernel({ plugins: createPlugins(effects), storage });
    await kernel.boot();
    runtimes.push({ storage, kernel });
    return { storage, kernel };
  };
  const start = async (kernel: Kernel, orgId: string, workflow: string, input: unknown) =>
    (
      (await kernel.execute(
        `orders.${workflow}.start`,
        { input, idempotencyKey: randomUUID() },
        { principal: principal(orgId) },
      )) as Snapshot
    ).id;
  const control = async (
    kernel: Kernel,
    orgId: string,
    workflow: string,
    operation: "status" | "cancel" | "retry",
    id: string,
  ) =>
    (await kernel.execute(
      `orders.${workflow}.${operation}`,
      { id },
      { principal: principal(orgId) },
    )) as Snapshot;
  const notes = async (workflowId: string) => {
    const owner = new Pool({ connectionString: migrationUrl });
    try {
      const result = await owner.query(
        "SELECT (data::jsonb->>'attempt')::int AS attempt FROM embody_entities WHERE entity_type LIKE '%note' AND data::jsonb->>'workflowId' = $1 ORDER BY 1",
        [workflowId],
      );
      return result.rows.map((row) => row["attempt"]);
    } finally {
      await owner.end();
    }
  };
  const settle = async (
    worker: WorkflowWorker,
    kernel: Kernel,
    orgId: string,
    workflow: string,
    id: string,
  ) => {
    for (let tick = 0; tick < 12; tick++) {
      const current = await control(kernel, orgId, workflow, "status", id);
      if (terminal.has(current.status)) return current;
      await worker.tick();
    }
    return control(kernel, orgId, workflow, "status", id);
  };

  let releaseClaimLock: () => Promise<void> = () => Promise.resolve();
  beforeAll(async () => {
    releaseClaimLock = await holdClaimLock(migrationUrl!);
    const owner = new Pool({ connectionString: migrationUrl });
    const runtimeRole = decodeURIComponent(new URL(runtimeUrl!).username);
    try {
      await owner.query("CREATE TABLE IF NOT EXISTS m19_effects (key TEXT PRIMARY KEY)");
      await owner.query(
        "CREATE TABLE IF NOT EXISTS m19_attempts (id BIGSERIAL PRIMARY KEY, key TEXT NOT NULL)",
      );
      await owner.query(`GRANT SELECT, INSERT ON m19_effects, m19_attempts TO "${runtimeRole}"`);
      await owner.query(`GRANT USAGE ON SEQUENCE m19_attempts_id_seq TO "${runtimeRole}"`);
      // Leftovers from an earlier local run would be claimed by these workers.
      await owner.query("DELETE FROM embody_workflow_instances WHERE org_id LIKE 'm19-%'");
    } finally {
      await owner.end();
    }
    effects = createEffects(runtimeUrl!);
  }, 300_000);
  afterAll(async () => {
    try {
      await Promise.all(runtimes.map(({ kernel }) => kernel.stop()));
      await effects.close();
    } finally {
      await releaseClaimLock();
    }
  });

  it("claims across tenants without RLS bypass, exposing claim identity only", async () => {
    const { storage, kernel } = await boot();
    const probe = new Pool({ connectionString: runtimeUrl });
    try {
      const role = await probe.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const result = await probe.query(
        "SELECT pg_get_function_result('embody_claim_workflow_steps(timestamptz,timestamptz,integer,text)'::regprocedure) AS result",
      );
      expect(result.rows[0]?.["result"]).toBe(
        "TABLE(step_id uuid, step_org_id text, step_attempt integer)",
      );
      const privileges = await probe.query(
        "SELECT has_function_privilege('embody_other', 'embody_claim_workflow_steps(timestamptz,timestamptz,integer,text)', 'EXECUTE') AS claim, has_function_privilege('embody_other', 'embody_active_workflow_versions()', 'EXECUTE') AS versions",
      );
      expect(privileges.rows[0]).toEqual({ claim: false, versions: false });
    } finally {
      await probe.end();
    }
    const [a, b] = [`m19-a-${randomUUID()}`, `m19-b-${randomUUID()}`];
    const ida = await start(kernel, a, "linear", { label: "a" });
    const idb = await start(kernel, b, "linear", { label: "b" });
    const worker = new WorkflowWorker({ storage, kernel, cancelPollMs: 0 });
    await worker.tick();
    await worker.tick();
    expect((await control(kernel, a, "linear", "status", ida)).status).toBe("completed");
    expect((await control(kernel, b, "linear", "status", idb)).status).toBe("completed");
    await expect(control(kernel, b, "linear", "status", ida)).rejects.toThrow(/not found/);
    await expect(control(kernel, a, "linear", "cancel", idb)).rejects.toThrow(/not found/);
    // Tenant-scoped repository paths stay under RLS: org B cannot see org A's rows at all.
    await storage.transaction(b, async (tx) => {
      expect(await tx.workflows.get(ida)).toBeNull();
    });
  });

  it("runs diamonds once per step while three concurrent workers race on joins", async () => {
    const [one, two, three] = [await boot(), await boot(), await boot()];
    const orgId = `m19-diamond-${randomUUID()}`;
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        start(one.kernel, orgId, "diamond", { label: String(index) }),
      ),
    );
    const workers = [
      new WorkflowWorker({ storage: one.storage, kernel: one.kernel, cancelPollMs: 0 }),
      new WorkflowWorker({ storage: two.storage, kernel: two.kernel, cancelPollMs: 0 }),
      new WorkflowWorker({ storage: three.storage, kernel: three.kernel, cancelPollMs: 0 }),
    ];
    for (let round = 0; round < 8; round++) await Promise.all(workers.map((w) => w.tick()));
    for (const id of ids) {
      const final = await control(one.kernel, orgId, "diamond", "status", id);
      expect(final.status).toBe("completed");
      const ledger = await effects.ledger(`${id}:`);
      expect(ledger.effects).toEqual(
        ["root", "left", "right", "join"].map((s) => `${id}:${s}`).sort(),
      );
      expect(Object.values(ledger.attempts)).toEqual([1, 1, 1, 1]);
    }
  });

  it("fences a lost lease: the stalled worker cannot process the reclaimed step", async () => {
    const { storage, kernel } = await boot();
    const orgId = `m19-lease-${randomUUID()}`;
    const id = await start(kernel, orgId, "linear", { label: "lease" });
    const stalled = await storage.transaction("system", (tx) =>
      tx.workflows.claimDue({ limit: 100, workerId: "stalled" }),
    );
    const claim = stalled.find((item) => item.orgId === orgId);
    expect(claim).toBeDefined();
    // Before the lease expires nobody else may take it.
    const early = new WorkflowWorker({ storage, kernel, cancelPollMs: 0 });
    await early.tick();
    expect((await effects.ledger(`${id}:`)).effects).toEqual([]);
    const recovering = new WorkflowWorker({
      storage,
      kernel,
      cancelPollMs: 0,
      clock: clockAt(LEASE_MS + 1_000),
    });
    expect((await settle(recovering, kernel, orgId, "linear", id)).status).toBe("completed");
    await storage.transaction(orgId, async (tx) => {
      expect(await tx.workflows.lockClaim(claim!)).toBeNull();
    });
    expect((await effects.ledger(`${id}:`)).attempts).toEqual({
      [`${id}:finish`]: 1,
      [`${id}:start`]: 1,
    });
  });

  it.each([
    ["after the claim commits", "after-claim", 1],
    ["inside the step before its effect", "before-effect:start", 1],
    ["after the external effect, before the step commits", "after-effect:start", 2],
    ["after recording completion, before commit", "after-complete", 2],
  ])("recovers a worker killed %s with one logical effect", async (_label, point, attempts) => {
    const { storage, kernel } = await boot();
    const orgId = `m19-crash-${randomUUID()}`;
    const id = await start(kernel, orgId, "linear", { label: point });
    await crashWorkerAt(point);
    const recovering = new WorkflowWorker({
      storage,
      kernel,
      cancelPollMs: 0,
      clock: clockAt(LEASE_MS + 1_000),
    });
    const final = await settle(recovering, kernel, orgId, "linear", id);
    expect(final.status).toBe("completed");
    const ledger = await effects.ledger(`${id}:`);
    expect(ledger.effects).toEqual([`${id}:finish`, `${id}:start`]);
    expect(ledger.attempts[`${id}:start`]).toBe(attempts);
    expect(ledger.attempts[`${id}:finish`]).toBe(1);
  });

  it("recovers a worker killed during compensation with one logical undo", async () => {
    const { storage, kernel } = await boot();
    const orgId = `m19-crash-undo-${randomUUID()}`;
    const id = await start(kernel, orgId, "linear", { label: "undo" });
    await new WorkflowWorker({ storage, kernel, cancelPollMs: 0 }).tick();
    expect((await control(kernel, orgId, "linear", "cancel", id)).status).toBe("compensating");
    await crashWorkerAt("after-compensation:start");
    const recovering = new WorkflowWorker({
      storage,
      kernel,
      cancelPollMs: 0,
      clock: clockAt(LEASE_MS + 1_000),
    });
    expect((await settle(recovering, kernel, orgId, "linear", id)).status).toBe("compensated");
    const ledger = await effects.ledger(`${id}:`);
    expect(ledger.effects).toEqual([`${id}:start`, `${id}:undo:start`]);
    expect(ledger.attempts[`${id}:undo:start`]).toBe(2);
  });

  it("never starts a step after cancellation commits, even between claim and processing", async () => {
    const orgId = `m19-cancel-claimed-${randomUUID()}`;
    let id = "";
    const { storage, kernel } = await boot((base) => ({
      dialect: base.dialect,
      ensureSchema: () => base.ensureSchema(),
      close: () => base.close(),
      transaction: async (org, callback) => {
        const value = await base.transaction(org, callback);
        // The claim has committed; cancel before the worker locks and runs the step.
        if (org === "system" && id !== "") await control(kernel, orgId, "slow", "cancel", id);
        return value;
      },
    }));
    const before = await start(kernel, orgId, "slow", { ms: 10, ignoreSignal: false });
    await control(kernel, orgId, "slow", "cancel", before);
    id = await start(kernel, orgId, "slow", { ms: 10, ignoreSignal: false });
    const worker = new WorkflowWorker({ storage, kernel, cancelPollMs: 0 });
    for (let tick = 0; tick < 3; tick++) await worker.tick();
    for (const instance of [before, id]) {
      const final = await control(kernel, orgId, "slow", "status", instance);
      expect(final.status).toBe("cancelled");
      expect(final.steps.every((step) => step.status === "cancelled")).toBe(true);
      expect((await effects.ledger(`${instance}:`)).effects).toEqual([]);
    }
  });

  it("signals a cooperative running step, compensates completed work and starts nothing after", async () => {
    const { storage, kernel } = await boot();
    const orgId = `m19-cancel-active-${randomUUID()}`;
    const id = await start(kernel, orgId, "slow", { ms: 20_000, ignoreSignal: false });
    const worker = new WorkflowWorker({ storage, kernel, cancelPollMs: 50 });
    await worker.tick();
    const running = worker.tick();
    await waitFor(async () =>
      (await control(kernel, orgId, "slow", "status", id)).steps.some(
        (step) => step.name === "wait" && step.status === "running",
      ),
    );
    const startedAt = Date.now();
    await control(kernel, orgId, "slow", "cancel", id);
    await running;
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const final = await settle(worker, kernel, orgId, "slow", id);
    expect(final.status).toBe("compensated");
    expect(Object.fromEntries(final.steps.map((step) => [step.name, step.status]))).toEqual({
      after: "cancelled",
      prepare: "compensated",
      wait: "cancelled",
    });
    expect((await effects.ledger(`${id}:`)).effects).toEqual([
      `${id}:prepare`,
      `${id}:undo:prepare`,
    ]);
  });

  it("compensates a step that finished despite cancellation, in reverse order", async () => {
    const { storage, kernel } = await boot();
    const orgId = `m19-cancel-late-${randomUUID()}`;
    const id = await start(kernel, orgId, "slow", { ms: 1_500, ignoreSignal: true });
    const worker = new WorkflowWorker({ storage, kernel, cancelPollMs: 50 });
    await worker.tick();
    const running = worker.tick();
    await waitFor(async () =>
      (await control(kernel, orgId, "slow", "status", id)).steps.some(
        (step) => step.name === "wait" && step.status === "running",
      ),
    );
    // prepare is completed and compensatable but must wait for the running later step.
    expect((await control(kernel, orgId, "slow", "cancel", id)).status).toBe("compensating");
    await new WorkflowWorker({ storage, kernel, cancelPollMs: 0 }).tick();
    expect((await effects.ledger(`${id}:undo:`)).effects).toEqual([]);
    await running;
    expect((await settle(worker, kernel, orgId, "slow", id)).status).toBe("compensated");
    const order = await effects.ledger(`${id}:`);
    expect(order.effects).toEqual([
      `${id}:prepare`,
      `${id}:undo:prepare`,
      `${id}:undo:wait`,
      `${id}:wait`,
    ]);
    const probe = new Pool({ connectionString: runtimeUrl });
    try {
      const sequence = await probe.query(
        "SELECT key FROM m19_attempts WHERE key LIKE $1 ORDER BY id",
        [`${id}:undo:%`],
      );
      expect(sequence.rows.map((row) => row["key"])).toEqual([
        `${id}:undo:wait`,
        `${id}:undo:prepare`,
      ]);
    } finally {
      await probe.end();
    }
  });

  it("settles a step orphaned by a dead worker after its instance is cancelled", async () => {
    const { storage, kernel } = await boot();
    const orgId = `m19-orphan-${randomUUID()}`;
    const id = await start(kernel, orgId, "linear", { label: "orphan" });
    await storage.transaction("system", (tx) =>
      tx.workflows.claimDue({ limit: 100, workerId: "dead" }),
    );
    expect((await control(kernel, orgId, "linear", "cancel", id)).steps).toContainEqual(
      expect.objectContaining({ name: "start", status: "running" }),
    );
    const recovering = new WorkflowWorker({
      storage,
      kernel,
      cancelPollMs: 0,
      clock: clockAt(LEASE_MS + 1_000),
    });
    const final = await settle(recovering, kernel, orgId, "linear", id);
    // The dead worker may have applied the effect, so a compensatable orphan is compensated.
    expect(final.status).toBe("compensated");
    expect((await effects.ledger(`${id}:`)).effects).toEqual([`${id}:undo:start`]);
  });

  it("retries a failed compensation as compensation", async () => {
    const { storage, kernel } = await boot();
    const orgId = `m19-undo-retry-${randomUUID()}`;
    const id = await start(kernel, orgId, "brokenUndo", { label: "refund" });
    const worker = new WorkflowWorker({ storage, kernel, cancelPollMs: 0 });
    await worker.tick();
    await control(kernel, orgId, "brokenUndo", "cancel", id);
    const failed = await settle(worker, kernel, orgId, "brokenUndo", id);
    expect(failed.status).toBe("failed");
    expect(failed.steps).toContainEqual(
      expect.objectContaining({ name: "charge", status: "compensation_failed" }),
    );
    expect((await control(kernel, orgId, "brokenUndo", "retry", id)).status).toBe("compensating");
    await effects.allow(`${id}:allow-undo`);
    expect((await settle(worker, kernel, orgId, "brokenUndo", id)).status).toBe("compensated");
    expect((await effects.ledger(`${id}:undo:`)).effects).toEqual([`${id}:undo:charge`]);
  });

  it("retries with backoff measured by the worker clock", async () => {
    const { storage, kernel } = await boot();
    const orgId = `m19-retry-${randomUUID()}`;
    const id = await start(kernel, orgId, "retrying", { failures: 2 });
    const at = (ms: number) =>
      new WorkflowWorker({ storage, kernel, cancelPollMs: 0, clock: clockAt(ms) });
    await at(0).tick();
    expect((await control(kernel, orgId, "retrying", "status", id)).status).toBe("waiting");
    await at(900).tick();
    expect((await effects.ledger(`${id}:`)).attempts).toEqual({});
    await at(1_100).tick();
    await at(3_000).tick();
    expect((await control(kernel, orgId, "retrying", "status", id)).status).toBe("waiting");
    await at(3_300).tick();
    expect((await control(kernel, orgId, "retrying", "status", id)).status).toBe("completed");
    expect((await effects.ledger(`${id}:`)).attempts).toEqual({ [`${id}:call`]: 1 });
  });

  it.each([
    ["completion", "linear", { label: "race" }, "compensated"],
    ["failure", "retrying", { failures: 1 }, "cancelled"],
  ])(
    "a cancel racing the recording of a step %s still settles the instance",
    async (_label, workflow, input, expected) => {
      const worker = await boot();
      const canceller = await boot();
      const orgId = `m19-cancel-race-${randomUUID()}`;
      const id = await start(worker.kernel, orgId, workflow, input);
      // Cancel right after the worker reads the cancellation flag while recording the step. With
      // the instance locked by that read, the cancel waits; on a plain read it would slip in.
      const original = Client.prototype.query;
      let armed = true;
      let cancelling: Promise<unknown> | undefined;
      Client.prototype.query = async function (this: unknown, ...args: unknown[]) {
        const result = await original.apply(this, args);
        const sql = typeof args[0] === "string" ? args[0] : "";
        if (armed && sql.startsWith("SELECT cancel_requested FROM embody_workflow_instances")) {
          armed = false;
          cancelling = control(canceller.kernel, orgId, workflow, "cancel", id);
          await Promise.race([cancelling, new Promise((resolve) => setTimeout(resolve, 500))]);
        }
        return result;
      };
      try {
        await new WorkflowWorker({
          storage: worker.storage,
          kernel: worker.kernel,
          cancelPollMs: 0,
        }).tick();
      } finally {
        Client.prototype.query = original;
      }
      expect(armed).toBe(false);
      await cancelling;
      const recovering = new WorkflowWorker({
        storage: worker.storage,
        kernel: worker.kernel,
        cancelPollMs: 0,
        clock: clockAt(LEASE_MS + 1_000),
      });
      const final = await settle(recovering, worker.kernel, orgId, workflow, id);
      expect(final.status).toBe(expected);
      if (workflow === "linear")
        expect((await effects.ledger(`${id}:`)).effects).toEqual([
          `${id}:start`,
          `${id}:undo:start`,
        ]);
    },
  );

  it("rolls back the writes of a timed-out attempt before retrying it", async () => {
    const { storage, kernel } = await boot();
    const orgId = `m19-timeout-${randomUUID()}`;
    const id = await start(kernel, orgId, "timed", { slowFirstMs: 600 });
    const worker = new WorkflowWorker({ storage, kernel, cancelPollMs: 0 });
    const final = await settle(worker, kernel, orgId, "timed", id);
    expect(final.status).toBe("completed");
    expect(await notes(id)).toEqual([2]);
  });

  it("rolls back the writes of a step that gives up after cancellation", async () => {
    const { storage, kernel } = await boot();
    const orgId = `m19-abort-write-${randomUUID()}`;
    const id = await start(kernel, orgId, "abortWrite", {});
    const worker = new WorkflowWorker({ storage, kernel, cancelPollMs: 50 });
    const running = worker.tick();
    await waitFor(async () =>
      (await control(kernel, orgId, "abortWrite", "status", id)).steps.some(
        (step) => step.status === "running",
      ),
    );
    await control(kernel, orgId, "abortWrite", "cancel", id);
    await running;
    expect((await settle(worker, kernel, orgId, "abortWrite", id)).status).toBe("cancelled");
    expect(await notes(id)).toEqual([]);
  });

  it("cancels and claims concurrently without deadlocks", async () => {
    const runtimes = [await boot(), await boot(), await boot()];
    const orgs = [0, 1, 2, 3].map((n) => `m19-deadlock-${n}-${randomUUID()}`);
    const started = await Promise.all(
      Array.from({ length: 40 }, async (_, n) => {
        const orgId = orgs[n % orgs.length]!;
        return {
          orgId,
          id: await start(runtimes[0]!.kernel, orgId, "diamond", { label: String(n) }),
        };
      }),
    );
    const workers = runtimes.map(
      ({ storage, kernel }) => new WorkflowWorker({ storage, kernel, cancelPollMs: 0 }),
    );
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 6 }, (_, round) => workers[round % workers.length]!.tick()),
      ...started.map(({ orgId, id }, n) =>
        control(runtimes[n % runtimes.length]!.kernel, orgId, "diamond", "cancel", id),
      ),
      ...Array.from({ length: 6 }, (_, round) => workers[(round + 1) % workers.length]!.tick()),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
    for (const { orgId, id } of started) {
      const final = await settle(workers[0]!, runtimes[0]!.kernel, orgId, "diamond", id);
      expect(["cancelled", "compensated", "completed"]).toContain(final.status);
    }
  });

  it("a step still processed past its lease does not block other tenants' claims", async () => {
    const { storage, kernel } = await boot();
    const busy = `m19-busy-${randomUUID()}`;
    const other = `m19-other-${randomUUID()}`;
    const slowId = await start(kernel, busy, "slow", { ms: 3_000, ignoreSignal: true });
    const live = new WorkflowWorker({ storage, kernel, cancelPollMs: 0 });
    await live.tick();
    const running = live.tick();
    await waitFor(async () =>
      (await control(kernel, busy, "slow", "status", slowId)).steps.some(
        (step) => step.name === "wait" && step.status === "running",
      ),
    );
    await control(kernel, busy, "slow", "cancel", slowId);
    const otherId = await start(kernel, other, "linear", { label: "unblocked" });
    const late = new WorkflowWorker({
      storage,
      kernel,
      cancelPollMs: 0,
      clock: clockAt(LEASE_MS + 1_000),
    });
    const before = Date.now();
    await late.tick();
    expect(Date.now() - before).toBeLessThan(1_500);
    expect((await control(kernel, other, "linear", "status", otherId)).steps).toContainEqual(
      expect.objectContaining({ name: "start", status: "completed" }),
    );
    await running;
    expect((await settle(live, kernel, busy, "slow", slowId)).status).toBe("compensated");
  });

  it("lists active definition versions exactly while instances start and finish concurrently", async () => {
    const { storage, kernel } = await boot();
    const orgs = [0, 1, 2].map((n) => `m19-versions-${n}-${randomUUID()}`);
    const worker = new WorkflowWorker({ storage, kernel, cancelPollMs: 0 });
    await Promise.all([
      ...orgs.flatMap((orgId) =>
        Array.from({ length: 4 }, (_, n) =>
          start(kernel, orgId, n % 2 ? "linear" : "diamond", { label: String(n) }),
        ),
      ),
      worker.tick(),
      worker.tick(),
    ]);
    const owner = new Pool({ connectionString: migrationUrl });
    try {
      const truth = await owner.query(
        "SELECT definition, definition_version AS \"definitionVersion\", count(*)::int AS instances FROM embody_workflow_instances WHERE status NOT IN ('completed','cancelled','compensated') GROUP BY 1, 2 ORDER BY 1, 2",
      );
      const listed = await storage.transaction("system", (tx) => tx.workflows.activeVersions());
      expect(listed).toEqual(truth.rows);
      expect(listed.find((row) => row.definition === "orders.diamond")?.instances).toBeGreaterThan(
        0,
      );
    } finally {
      await owner.end();
    }
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Runs one worker tick in a child process and SIGKILLs it at the named crash point. */
async function crashWorkerAt(point: string): Promise<void> {
  const child = spawn(process.execPath, ["test/fixtures/m19-crash-worker.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, M19_CRASH_AT: point },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Crash point ${point} not reached`)), 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.includes(`PAUSED ${point}`)) {
          clearTimeout(timer);
          resolve();
        } else if (text.includes("TICKED")) {
          clearTimeout(timer);
          reject(new Error(`Worker finished without reaching ${point}`));
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Worker exited (${code}) before ${point}: ${stderr}`));
      });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
}
