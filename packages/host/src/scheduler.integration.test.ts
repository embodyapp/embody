/**
 * Schedules, and the claim that a cron trigger is not a second kind of trigger.
 *
 * The property being tested is that a schedule *publishes an event* — the same durable
 * event any plugin publishes, going through the same outbox and the same worker. If
 * that holds, an automation triggering on a cron needs no engine support at all.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createSilentLogger, type EmbodyPlugin } from "@embody/kernel";
import { createDb } from "@embody/db";
import { defineConfig } from "./config.ts";
import { bootRuntime, type Runtime } from "./runtime.ts";
import { startWorker, type RunningWorker } from "./worker.ts";
import { nextRun, runDueSchedules } from "./scheduler.ts";

const seen: { name: string; payload: unknown }[] = [];

const listener: EmbodyPlugin = {
  id: "nightly-listener",
  schema: "sched_test",
  dependsOn: ["core"],
  capabilities: { events: { subscribe: ["ops.*"] } },
  subscribe(bus) {
    bus.subscribe("ops.*", (e) => {
      seen.push({ name: e.name, payload: e.payload });
    });
  },
};

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

describe("nextRun", () => {
  it("computes the next occurrence in the given zone", () => {
    const from = new Date("2026-07-26T00:00:00Z");
    expect(nextRun("0 2 * * *", "UTC", from)?.toISOString()).toBe("2026-07-26T02:00:00.000Z");
    // 02:00 in Tokyo is 17:00 UTC the previous day, so the next one is later today UTC.
    expect(nextRun("0 2 * * *", "Asia/Tokyo", from)?.toISOString()).toBe(
      "2026-07-26T17:00:00.000Z",
    );
  });

  it("returns undefined for a malformed expression rather than throwing", () => {
    expect(nextRun("not a cron", "UTC", new Date())).toBeUndefined();
  });
});

const suite = (await reachable()) ? describe : describe.skip;

suite("scheduler (integration)", () => {
  let runtime: Runtime;
  let worker: RunningWorker;
  let orgId: string;

  const addSchedule = (name: string, cron: string, event: string, dueNow = true) => {
    const when = new Date(Date.now() + (dueNow ? -60_000 : 86_400_000)).toISOString();
    return runtime.ownerDb.sql`
      insert into embody.schedules (org_id, name, cron, event_name, payload, next_run_at)
      values (${orgId}, ${name}, ${cron}, ${event}, '{"source":"cron"}'::jsonb,
              ${when}::timestamptz)
    `;
  };

  const scheduleRow = (name: string) =>
    runtime.ownerDb.sql<{ enabled: boolean; next_run_at: Date | string; last_run_at: Date | string | null }[]>`
      select enabled, next_run_at, last_run_at from embody.schedules
      where org_id = ${orgId} and name = ${name}`;

  beforeAll(async () => {
    runtime = await bootRuntime({
      config: defineConfig({ plugins: [listener] }),
      logger: createSilentLogger(),
    });
    worker = startWorker({ runtime, autoStart: false, logger: createSilentLogger() });

    const rand = Math.random().toString(36).slice(2, 8);
    const [org] = await runtime.ownerDb.sql<{ id: string }[]>`
      insert into core.orgs (name, slug) values ('S', ${`s-${rand}`}) returning id`;
    orgId = org!.id;
  });

  afterAll(async () => {
    await runtime?.close();
  });

  beforeEach(async () => {
    seen.length = 0;
    await runtime.ownerDb.sql`delete from embody.schedules where org_id = ${orgId}`;
    await runtime.ownerDb.sql`delete from embody.outbox where org_id = ${orgId}`;
  });

  it("publishes the named event when due, and a subscriber receives it", async () => {
    await addSchedule("nightly", "0 2 * * *", "ops.nightly");
    await worker.tick();

    // The whole claim: a cron fired, and it arrived as an ordinary domain event —
    // carrying which schedule produced it, plus the schedule's own payload.
    expect(seen).toEqual([
      { name: "ops.nightly", payload: { schedule: "nightly", source: "cron" } },
    ]);
  });

  it("does not fire a schedule that is not due", async () => {
    await addSchedule("later", "0 2 * * *", "ops.later", false);
    await worker.tick();
    expect(seen).toEqual([]);
  });

  it("advances next_run_at so one due time fires exactly once", async () => {
    await addSchedule("once", "0 2 * * *", "ops.once");
    await worker.tick();
    await worker.tick();
    await worker.tick();
    expect(seen).toHaveLength(1);

    const [row] = await scheduleRow("once");
    expect(new Date(row!.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(row!.last_run_at).not.toBeNull();
  });

  it("goes through the outbox, so the event survives having no live subscriber", async () => {
    await addSchedule("durable", "*/5 * * * *", "ops.durable");
    await runDueSchedules({
      sql: runtime.ownerDb.sql,
      events: runtime.booted.events,
      logger: createSilentLogger(),
    });
    // Published but not yet delivered: it is a row on disk, not an in-memory call.
    const rows = await runtime.ownerDb.sql<{ name: string }[]>`
      select name from embody.outbox where org_id = ${orgId}`;
    expect(rows.map((r) => r.name)).toEqual(["ops.durable"]);
    expect(seen).toEqual([]);

    await worker.tick();
    expect(seen).toHaveLength(1);
  });

  it("disables a schedule whose cron cannot be parsed instead of retrying forever", async () => {
    await addSchedule("broken", "definitely not cron", "ops.broken");
    await worker.tick();

    expect(seen).toEqual([]);
    expect((await scheduleRow("broken"))[0]!.enabled).toBe(false);
  });
});
