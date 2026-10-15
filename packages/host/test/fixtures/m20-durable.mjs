// Shared by the M20 PostgreSQL suite and its crash-matrix child processes.
import { createRequire } from "node:module";
import { URL } from "node:url";
import { definePlugin, defineWorkflow, z } from "@embody/core";

const { Pool } = createRequire(new URL("../../../storage/package.json", import.meta.url))("pg");

export const APP_ID = "shop";
/** Delay of the `ship` step, so tests can move the clock past it. */
export const SHIP_DELAY_MS = 60_000;
/** Leaves of the `fan` workflow: well above the per-transaction step wakes. */
export const FAN_LEAVES = 40;

/** Tables owned by the maintenance role; the runtime role gets DML only. */
export const FIXTURE_TABLES = `
  CREATE TABLE IF NOT EXISTS m20_effects (key TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS m20_attempts (id BIGSERIAL PRIMARY KEY, key TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS m20_tasks (name TEXT PRIMARY KEY, schedule_at TIMESTAMPTZ NOT NULL,
    body JSONB NOT NULL, delivered BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;
export const FIXTURE_GRANTS = (role) => `
  GRANT SELECT, INSERT, UPDATE, DELETE ON m20_effects, m20_attempts, m20_tasks TO "${role}";
  GRANT USAGE ON SEQUENCE m20_attempts_id_seq TO "${role}";
`;

/**
 * An idempotent external system outside every app transaction: each execution is an attempt,
 * the effect itself is recorded once per key.
 */
export function createEffects(connectionString) {
  const pool = new Pool({ connectionString, max: 2 });
  return {
    async apply(key) {
      await pool.query("INSERT INTO m20_attempts (key) VALUES ($1)", [key]);
      await pool.query("INSERT INTO m20_effects (key) VALUES ($1) ON CONFLICT DO NOTHING", [key]);
    },
    async ledger(prefix) {
      const effects = await pool.query(
        "SELECT key FROM m20_effects WHERE key LIKE $1 ORDER BY key",
        [`${prefix}%`],
      );
      const attempts = await pool.query(
        "SELECT key, count(*)::int AS n FROM m20_attempts WHERE key LIKE $1 GROUP BY key ORDER BY key",
        [`${prefix}%`],
      );
      return {
        effects: effects.rows.map((row) => row.key),
        attempts: Object.fromEntries(attempts.rows.map((row) => [row.key, row.n])),
      };
    },
    close: () => pool.end(),
  };
}

/**
 * A wake queue that survives the process, like a real one: tasks are rows written on their own
 * connection, outside the app transaction that enqueues them. Duplicate names are rejected.
 */
export function createTableQueue(connectionString) {
  const pool = new Pool({ connectionString, max: 2 });
  return {
    outage: false,
    async enqueue(task) {
      if (this.outage) throw new Error("Wake queue unavailable");
      const result = await pool.query(
        "INSERT INTO m20_tasks (name, schedule_at, body) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING",
        [task.name, task.scheduleAt, JSON.stringify(task.body)],
      );
      return result.rowCount === 1 ? "created" : "duplicate";
    },
    async due(org, now = new Date()) {
      const result = await pool.query(
        "SELECT name, schedule_at, body FROM m20_tasks WHERE NOT delivered AND body->>'org' = $1 AND schedule_at <= $2 ORDER BY schedule_at, created_at",
        [org, now.toISOString()],
      );
      return result.rows.map((row) => ({
        name: row.name,
        scheduleAt: row.schedule_at.toISOString(),
        body: row.body,
      }));
    },
    async all(org) {
      const result = await pool.query(
        "SELECT name, body, delivered FROM m20_tasks WHERE body->>'org' = $1 ORDER BY created_at",
        [org],
      );
      return result.rows;
    },
    async acknowledge(name) {
      await pool.query("UPDATE m20_tasks SET delivered = TRUE WHERE name = $1", [name]);
    },
    close: () => pool.end(),
  };
}

/**
 * `pause(point)` lets a child process stop at a named crash point and wait to be killed. Event
 * handlers and steps apply their external effect with an idempotency key, as the contract asks.
 */
export function createPlugins(effects, pause = async () => undefined) {
  const fulfil = defineWorkflow(z.object({ orderId: z.string() }))({
    version: "1.0.0",
    resultStep: "ship",
    steps: {
      reserve: {
        timeoutMs: 10_000,
        handler: async (context) => {
          await pause("before-step-effect");
          await effects.apply(`${context.workflowId}:reserve`);
          await pause("after-step-effect");
          return { reserved: true };
        },
        compensate: async (_output, context) => {
          await pause("in-compensation");
          await effects.apply(`${context.workflowId}:undo:reserve`);
        },
      },
      ship: {
        dependsOn: ["reserve"],
        delayMs: SHIP_DELAY_MS,
        handler: async (context) => {
          await effects.apply(`${context.workflowId}:ship`);
          return { shipped: context.input.orderId };
        },
      },
    },
  });
  const flaky = defineWorkflow(z.object({ failures: z.number().int() }))({
    version: "1.0.0",
    steps: {
      call: {
        retry: { maxAttempts: 3, backoffMs: 5_000 },
        handler: async (context) => {
          if (context.attempt <= context.input.failures) throw new Error("transient");
          await effects.apply(`${context.workflowId}:call`);
          return { ok: true };
        },
      },
    },
  });
  // Wide fan-out: completing `root` makes every leaf runnable in one transaction.
  const leaves = Object.fromEntries(
    Array.from({ length: FAN_LEAVES }, (_, index) => [
      `leaf${index}`,
      {
        dependsOn: ["root"],
        handler: async (context) => {
          await effects.apply(`${context.workflowId}:leaf${index}`);
          return { index };
        },
        compensate: async (_output, context) => {
          await effects.apply(`${context.workflowId}:undo:leaf${index}`);
        },
      },
    ]),
  );
  const fan = defineWorkflow(z.object({}))({
    version: "1.0.0",
    resultStep: "final",
    steps: {
      root: {
        handler: async (context) => {
          await effects.apply(`${context.workflowId}:root`);
          return { fanned: true };
        },
      },
      ...leaves,
      final: {
        dependsOn: Object.keys(leaves),
        delayMs: SHIP_DELAY_MS,
        handler: () => ({ done: true }),
      },
    },
  });
  // Publishes more events than one transaction may wake: it can never commit.
  const noisy = defineWorkflow(z.object({}))({
    version: "1.0.0",
    steps: {
      shout: {
        retry: { maxAttempts: 3, backoffMs: 1_000 },
        handler: async (context) => {
          await effects.apply(`${context.workflowId}:shout`);
          for (let index = 0; index < 101; index++)
            await context.events.publish("shop.noise", { index });
          return { shouted: true };
        },
      },
    },
  });
  return [
    definePlugin({
      id: "shop",
      version: "1.0.0",
      actions: {
        order: {
          input: z.object({
            orderId: z.string(),
            events: z.number().int().min(1).max(200).default(1),
            failAfterPublish: z.boolean().default(false),
          }),
          handler: async (input, ctx) => {
            for (let index = 0; index < input.events; index++)
              await ctx.events.publish("shop.ordered", { orderId: input.orderId, index });
            await pause("after-publish");
            if (input.failAfterPublish) throw new Error("rejected after publishing");
            return { orderId: input.orderId };
          },
        },
      },
      events: {
        "shop.ordered": async (event) => {
          await pause("before-event-effect");
          await effects.apply(`ordered:${event.payload.orderId}:${event.payload.index}`);
          await pause("after-event-effect");
        },
      },
      workflows: { fulfil, flaky, fan, noisy },
    }),
  ];
}

export const principal = (orgId) => ({
  orgId,
  actorId: "m20",
  actorType: "human",
  roles: [],
  scopes: ["shop:*"],
});
