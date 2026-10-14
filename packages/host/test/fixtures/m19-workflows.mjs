// Shared by the M19 PostgreSQL suite and its crash-matrix child worker process.
import { createRequire } from "node:module";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { definePlugin, defineWorkflow, z } from "@embody/core";

const { Pool } = createRequire(new URL("../../../storage/package.json", import.meta.url))("pg");

/**
 * An idempotent "external system" outside the step transaction. Tables are created by the
 * maintenance role in the test setup; the runtime role only gets DML on them.
 */
export function createEffects(connectionString) {
  const pool = new Pool({ connectionString, max: 2 });
  return {
    async apply(key) {
      await pool.query("INSERT INTO m19_attempts (key) VALUES ($1)", [key]);
      await pool.query("INSERT INTO m19_effects (key) VALUES ($1) ON CONFLICT DO NOTHING", [key]);
    },
    async has(key) {
      return (await pool.query("SELECT 1 FROM m19_effects WHERE key = $1", [key])).rowCount === 1;
    },
    async allow(key) {
      await pool.query("INSERT INTO m19_effects (key) VALUES ($1) ON CONFLICT DO NOTHING", [key]);
    },
    async ledger(prefix) {
      const effects = await pool.query(
        "SELECT key FROM m19_effects WHERE key LIKE $1 ORDER BY key",
        [`${prefix}%`],
      );
      const attempts = await pool.query(
        "SELECT key, count(*)::int AS n FROM m19_attempts WHERE key LIKE $1 GROUP BY key ORDER BY key",
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
 * `effects.apply(key)` stands in for an idempotent external system: every execution is
 * recorded as an attempt, while the effect itself is recorded once per idempotency key.
 * `pause(point)` lets the child process stop at a named crash point and wait to be killed.
 */
export function createPlugins(effects, pause = async () => undefined) {
  const effect = (step) => async (context) => {
    await pause(`before-effect:${step}`);
    await effects.apply(`${context.workflowId}:${step}`);
    await pause(`after-effect:${step}`);
    return { step };
  };
  const compensate = (step) => async (_output, context) => {
    await effects.apply(`${context.workflowId}:undo:${step}`);
    await pause(`after-compensation:${step}`);
  };
  const linear = defineWorkflow(z.object({ label: z.string() }))({
    version: "1.0.0",
    resultStep: "finish",
    steps: {
      start: { handler: effect("start"), compensate: compensate("start") },
      finish: { dependsOn: ["start"], handler: effect("finish") },
    },
  });
  const diamond = defineWorkflow(z.object({ label: z.string() }))({
    version: "1.0.0",
    resultStep: "join",
    steps: {
      root: { handler: effect("root"), compensate: compensate("root") },
      left: { dependsOn: ["root"], handler: effect("left"), compensate: compensate("left") },
      right: { dependsOn: ["root"], handler: effect("right"), compensate: compensate("right") },
      join: { dependsOn: ["left", "right"], handler: effect("join") },
    },
  });
  // Waits cooperatively; `ignoreSignal` models a handler that finishes its effect anyway.
  const slow = defineWorkflow(z.object({ ms: z.number(), ignoreSignal: z.boolean() }))({
    version: "1.0.0",
    steps: {
      prepare: { handler: effect("prepare"), compensate: compensate("prepare") },
      wait: {
        dependsOn: ["prepare"],
        compensate: compensate("wait"),
        handler: async (context) => {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, context.input.ms);
            if (!context.input.ignoreSignal)
              context.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve(undefined);
              });
          });
          if (!context.input.ignoreSignal && context.signal?.aborted) throw new Error("aborted");
          await effects.apply(`${context.workflowId}:wait`);
          return { waited: true };
        },
      },
      after: { dependsOn: ["wait"], handler: effect("after") },
    },
  });
  let flaky = 0;
  const retrying = defineWorkflow(z.object({ failures: z.number() }))({
    version: "1.0.0",
    steps: {
      call: {
        retry: { maxAttempts: 3, backoffMs: 1_000 },
        handler: async (context) => {
          if (flaky++ < context.input.failures) throw new Error("transient");
          await effects.apply(`${context.workflowId}:call`);
          return { ok: true };
        },
      },
    },
  });
  const brokenUndo = defineWorkflow(z.object({ label: z.string() }))({
    version: "1.0.0",
    steps: {
      charge: {
        handler: effect("charge"),
        compensate: async (_output, context) => {
          if (!(await effects.has(`${context.workflowId}:allow-undo`)))
            throw new Error("refund provider unavailable");
          await effects.apply(`${context.workflowId}:undo:charge`);
        },
      },
      ship: { dependsOn: ["charge"], handler: effect("ship") },
    },
  });
  // Writes inside the step transaction, then overruns its timeout on the first attempt.
  const timed = defineWorkflow(z.object({ slowFirstMs: z.number() }))({
    version: "1.0.0",
    steps: {
      record: {
        timeoutMs: 300,
        retry: { maxAttempts: 2, backoffMs: 0 },
        handler: async (context) => {
          await context.entities.note.create({
            workflowId: context.workflowId,
            attempt: context.attempt,
          });
          if (context.attempt === 1)
            await new Promise((resolve) => setTimeout(resolve, context.input.slowFirstMs));
          return { attempt: context.attempt };
        },
      },
    },
  });
  // Writes, then notices cancellation and gives up.
  const abortWrite = defineWorkflow(z.object({}))({
    version: "1.0.0",
    steps: {
      record: {
        handler: async (context) => {
          await context.entities.note.create({
            workflowId: context.workflowId,
            attempt: context.attempt,
          });
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 20_000);
            context.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve(undefined);
            });
          });
          throw new Error("cancelled by signal");
        },
      },
    },
  });
  return [
    definePlugin({
      id: "orders",
      version: "1.0.0",
      entities: {
        note: { schema: z.object({ workflowId: z.string(), attempt: z.number() }) },
      },
      workflows: { linear, diamond, slow, retrying, brokenUndo, timed, abortWrite },
    }),
  ];
}
