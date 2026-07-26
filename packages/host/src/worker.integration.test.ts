/**
 * The proof that Decision D5 is real.
 *
 * Before this, the docs said events were "saved into an outbox table during the main
 * transaction, then dispatched asynchronously by background workers... never lost!"
 * and the implementation was a 63-line in-memory array. These tests are what make the
 * sentence true, so they assert the properties the sentence claims rather than merely
 * that a subscriber ran:
 *
 *   1. ATOMICITY  — a vetoed write leaves NO event on disk. Read as owner, bypassing
 *                   RLS, because the point is what is actually in the table.
 *   2. DURABILITY — an event published by a process that then dies is still delivered
 *                   by a different process.
 *   3. ISOLATION  — a subscriber that throws retries on its own schedule and lands in
 *                   `dead`, without stopping its siblings or failing the publisher.
 *   4. RECOVERY   — a delivery orphaned mid-handler (process killed) is retried, and
 *                   still converges to `dead` rather than looping forever.
 *
 * Requires the docker-compose Postgres. Skips cleanly if unreachable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { z } from "zod";
import { createSilentLogger, type EmbodyPlugin } from "@embody/kernel";
import { createDb } from "@embody/db";
import { defineConfig } from "./config.ts";
import { bootRuntime, makeExecutor, type Runtime } from "./runtime.ts";
import { startWorker, type RunningWorker } from "./worker.ts";

/** What each subscriber saw, and how to make one of them fail on demand. */
const seen: { sub: string; name: string }[] = [];
let failNextN = 0;

/** Publishes an event on demand through a tool, so we exercise the real write path. */
const emitter: EmbodyPlugin = {
  id: "emitter",
  schema: "wtest_emitter",
  dependsOn: ["core"],
  capabilities: { events: { publish: ["wtest.thing.happened"] } },
  registerMcpTools(mcp, ctx) {
    mcp.tool({
      name: "wtest_emit",
      description: "Publish a test event inside a tenant transaction.",
      input: z.object({ veto: z.boolean().optional() }),
      handler: (input, req) =>
        req.tx(async (tx) => {
          await ctx.events.publish(
            { name: "wtest.thing.happened", orgId: req.orgId, payload: { ok: true } },
            tx,
          );
          // Roll the transaction back AFTER publishing: this is the atomicity case.
          // If the outbox row survives this, the event is not really transactional.
          if (input.veto) throw new Error("vetoed");
          return { published: true };
        }),
    });
  },
};

/** A subscriber that can be told to throw, to exercise retry and dead-lettering. */
const flaky: EmbodyPlugin = {
  id: "flaky",
  schema: "wtest_flaky",
  dependsOn: ["core"],
  capabilities: { events: { subscribe: ["wtest.*"] } },
  subscribe(bus) {
    bus.subscribe("wtest.*", (e) => {
      seen.push({ sub: "flaky", name: e.name });
      if (failNextN > 0) {
        failNextN--;
        throw new Error("subscriber exploded");
      }
    });
  },
};

/** A well-behaved sibling: must keep working while `flaky` is failing. */
const steady: EmbodyPlugin = {
  id: "steady",
  schema: "wtest_steady",
  dependsOn: ["core"],
  capabilities: { events: { subscribe: ["wtest.*"] } },
  subscribe(bus) {
    bus.subscribe("wtest.*", (e) => {
      seen.push({ sub: "steady", name: e.name });
    });
  },
};

// Inlined rather than using @embody/testing's databaseReachable: that package depends
// on this one, so importing it here would be circular.
async function reachable(): Promise<boolean> {
  try {
    const h = createDb(
      process.env.DATABASE_URL ?? "postgres://embody:embody@localhost:5432/embody",
      { max: 1 },
    );
    await h.sql`select 1`;
    await h.close();
    return true;
  } catch {
    return false;
  }
}

const suite = (await reachable()) ? describe : describe.skip;

suite("durable event outbox (integration)", () => {
  let runtime: Runtime;
  let worker: RunningWorker;
  let orgId: string;
  let userId: string;

  const emit = (input: { veto?: boolean } = {}) =>
    makeExecutor({ runtime, principal: { orgId, userId, roles: ["owner"] } }).invoke(
      "wtest_emit",
      input,
    );

  /** Ground truth: the owner role sees every row, RLS or not. */
  const outbox = () => runtime.ownerDb.sql<{ id: string; name: string }[]>`
    select id, name from embody.outbox where org_id = ${orgId} order by at`;

  const deliveries = () => runtime.ownerDb.sql<
    { subscriber: string; status: string; attempts: number; last_error: string | null }[]
  >`
    select d.subscriber, d.status, d.attempts, d.last_error
    from embody.outbox_deliveries d
    join embody.outbox o on o.id = d.outbox_id
    where o.org_id = ${orgId}
    order by d.subscriber
  `;

  beforeAll(async () => {
    runtime = await bootRuntime({
      config: defineConfig({ plugins: [emitter, flaky, steady] }),
      logger: createSilentLogger(),
    });
    // autoStart:false — drive ticks by hand so nothing races the assertions.
    worker = startWorker({
      runtime,
      autoStart: false,
      maxAttempts: 2,
      logger: createSilentLogger(),
    });

    const rand = Math.random().toString(36).slice(2, 8);
    const [org] = await runtime.ownerDb.sql<{ id: string }[]>`
      insert into core.orgs (name, slug) values ('W', ${`w-${rand}`}) returning id`;
    const [user] = await runtime.ownerDb.sql<{ id: string }[]>`
      insert into core.users (email, name) values (${`w-${rand}@t`}, 'W') returning id`;
    await runtime.ownerDb.sql`
      insert into core.memberships (org_id, user_id, role)
      values (${org!.id}, ${user!.id}, 'owner')`;
    orgId = org!.id;
    userId = user!.id;
  });

  afterAll(async () => {
    await runtime?.close();
  });

  beforeEach(async () => {
    seen.length = 0;
    failNextN = 0;
    await runtime.ownerDb.sql`delete from embody.outbox where org_id = ${orgId}`;
  });

  it("does not deliver on publish — only the worker delivers", async () => {
    await emit();
    expect(seen).toEqual([]); // nothing ran inline
    expect(await outbox()).toHaveLength(1);
  });

  it("writes NO event when the transaction rolls back (atomicity)", async () => {
    await expect(emit({ veto: true })).rejects.toThrow();
    expect(await outbox()).toEqual([]);
  });

  it("fans one event out to every matching subscriber and delivers each", async () => {
    await emit();
    await worker.tick();

    expect(seen.map((s) => s.sub).sort()).toEqual(["flaky", "steady"]);
    expect(await deliveries()).toEqual([
      { subscriber: "flaky:wtest.*", status: "done", attempts: 1, last_error: null },
      { subscriber: "steady:wtest.*", status: "done", attempts: 1, last_error: null },
    ]);
  });

  it("survives the publishing process dying before delivery (durability)", async () => {
    await emit();
    expect(seen).toEqual([]); // published, not delivered

    // A *different* runtime — a separate pool, a separate kernel, separate
    // subscriptions — drains the backlog. That is the property: the event outlived the
    // process that produced it and is delivered by one that never saw it happen.
    //
    // The shared `runtime` is deliberately left alone. An earlier version closed and
    // re-created it here to simulate the crash more literally, which meant one failure
    // in this test left every later test holding a closed connection pool.
    const reborn = await bootRuntime({
      config: defineConfig({ plugins: [emitter, flaky, steady] }),
      logger: createSilentLogger(),
    });
    try {
      const w2 = startWorker({
        runtime: reborn,
        autoStart: false,
        logger: createSilentLogger(),
      });
      await w2.tick();
      expect(seen.map((s) => s.sub).sort()).toEqual(["flaky", "steady"]);
    } finally {
      await reborn.close();
    }
  });

  it("retries a failing subscriber without touching its siblings", async () => {
    failNextN = 1; // flaky throws once, then succeeds
    await emit();
    await worker.tick();

    const afterFirst = await deliveries();
    expect(afterFirst.find((d) => d.subscriber.startsWith("flaky"))).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "subscriber exploded",
    });
    // The sibling is unaffected — this is what the old in-memory bus got wrong.
    expect(afterFirst.find((d) => d.subscriber.startsWith("steady"))).toMatchObject({
      status: "done",
    });

    // Backoff parks it in the future; clear that to exercise the retry now.
    await runtime.ownerDb.sql`
      update embody.outbox_deliveries set next_run_at = now()
      where status = 'pending' and subscriber like '%wtest.*'`;
    await worker.tick();
    expect((await deliveries()).find((d) => d.subscriber.startsWith("flaky"))).toMatchObject({
      status: "done",
      attempts: 2,
    });
  });

  it("dead-letters a subscriber that never succeeds, keeping the last error", async () => {
    failNextN = 99;
    await emit();
    for (let i = 0; i < 3; i++) {
      await runtime.ownerDb.sql`
        update embody.outbox_deliveries set next_run_at = now()
      where status = 'pending' and subscriber like '%wtest.*'`;
      await worker.tick();
    }

    const rows = await deliveries();
    expect(rows.find((d) => d.subscriber.startsWith("flaky"))).toMatchObject({
      status: "dead",
      attempts: 2, // maxAttempts
      last_error: "subscriber exploded",
    });
    expect(rows.find((d) => d.subscriber.startsWith("steady"))).toMatchObject({
      status: "done",
    });
  });

  it("recovers a delivery orphaned mid-handler and still converges to dead", async () => {
    failNextN = 99;
    await emit();
    await worker.tick(); // attempt 1 fails

    // Simulate a process killed while the handler was running: the row is left
    // `claimed` with no one to finish it. attempts was already consumed at claim time,
    // which is what stops a crash-loop from retrying forever.
    await runtime.ownerDb.sql`
      update embody.outbox_deliveries
      set status = 'claimed', claimed_at = now() - interval '10 minutes'
      where subscriber = 'flaky:wtest.*'`;

    await worker.tick(); // reaper returns it to pending, then it is claimed again
    await runtime.ownerDb.sql`
      update embody.outbox_deliveries set next_run_at = now()
      where status = 'pending' and subscriber like '%wtest.*'`;
    await worker.tick();

    expect(
      (await deliveries()).find((d) => d.subscriber.startsWith("flaky"))?.status,
    ).toBe("dead");
  });

  it("advances past an event no subscriber matches instead of rescanning it", async () => {
    await runtime.ownerDb.sql`
      insert into embody.outbox (org_id, name, payload) values (${orgId}, 'nobody.cares', '{}')`;
    await worker.tick();

    // No deliveries, but every cursor moved past it — otherwise the row is rescanned
    // on every tick forever and eventually blocks the batch behind it.
    const [cursor] = await runtime.ownerDb.sql<{ n: string }[]>`
      select count(*) as n from embody.outbox_cursors c
      join embody.outbox o on o.id = c.last_id
      where o.name = 'nobody.cares'`;
    expect(Number(cursor!.n)).toBeGreaterThan(0);
  });

  it("delivers a backlog published before any worker ever ran", async () => {
    // The failure this prevents: you deploy, events accumulate, you start a worker for
    // the first time, and the entire backlog is silently skipped because a new cursor
    // began at "now". Timestamped in the past so it predates the worker's own start.
    await runtime.ownerDb.sql`
      delete from embody.outbox_cursors where subscriber like '%wtest.*'`;
    await runtime.ownerDb.sql`
      insert into embody.outbox (org_id, name, payload, at)
      values (${orgId}, 'wtest.thing.happened', '{"old":true}'::jsonb,
              now() - interval '1 hour')`;

    await worker.tick();
    expect(seen.map((s) => s.sub).sort()).toEqual(["flaky", "steady"]);
  });

  it("does not replay history through a subscriber added later", async () => {
    // The other half of the same rule. An event other subscribers already consumed is
    // history a new plugin missed by not existing — not a backlog to re-run.
    await emit();
    await worker.tick();
    expect(seen).toHaveLength(2);

    const latecomerSeen: string[] = [];
    const latecomer: EmbodyPlugin = {
      id: "latecomer",
      schema: "wtest_late",
      dependsOn: ["core"],
      capabilities: { events: { subscribe: ["wtest.*"] } },
      subscribe(bus) {
        bus.subscribe("wtest.*", () => void latecomerSeen.push("late"));
      },
    };
    const second = await bootRuntime({
      config: defineConfig({ plugins: [emitter, latecomer] }),
      logger: createSilentLogger(),
    });
    try {
      const w = startWorker({ runtime: second, autoStart: false, logger: createSilentLogger() });
      await w.tick();
      expect(latecomerSeen).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it("does not let one deployment's worker starve another's subscribers", async () => {
    // Two deployables sharing a database is supported (and `pnpm dev` does it). Under
    // a single "has this been fanned out?" flag, whichever worker got there first
    // stamped the row with ITS subscriber list and the other's subscribers silently
    // never fired. Per-subscriber cursors are what make this pass.
    const otherSeen: string[] = [];
    const otherDeployment: EmbodyPlugin = {
      id: "other-app",
      schema: "wtest_other",
      dependsOn: ["core"],
      capabilities: { events: { subscribe: ["wtest.*"] } },
      subscribe(bus) {
        bus.subscribe("wtest.*", () => void otherSeen.push("other"));
      },
    };
    const second = await bootRuntime({
      config: defineConfig({ plugins: [emitter, otherDeployment] }),
      logger: createSilentLogger(),
    });
    try {
      const secondWorker = startWorker({
        runtime: second,
        autoStart: false,
        logger: createSilentLogger(),
      });

      await emit();
      // The FIRST deployment drains it completely.
      await worker.tick();
      expect(seen.map((s) => s.sub).sort()).toEqual(["flaky", "steady"]);

      // The second deployment must still receive it.
      await secondWorker.tick();
      expect(otherSeen).toEqual(["other"]);
    } finally {
      await second.close();
    }
  });
});
