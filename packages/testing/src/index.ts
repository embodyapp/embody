/**
 * @embody/testing — the harness for testing a plugin against a real runtime.
 *
 * `@embody/plugin-sdk` is deliberately the only embody package a plugin depends on at
 * runtime, and it cannot expose the machinery below: the host already depends on the
 * SDK, so re-exporting the host from it would be circular. This package is that
 * machinery, kept separate so it can be a devDependency and never ship in an app's
 * production graph.
 *
 * Declare it as a devDependency only:
 *
 *     "devDependencies": { "@embody/testing": "^1.0.0" }
 *
 * What a plugin author does with it: boot a kernel with their plugin plus whatever it
 * depends on, get an executor for a principal, and drive their tools through exactly
 * the code path an agent, the CLI, and REST all share — so a veto proven here is the
 * veto that fires in production.
 */
import { createDb } from "@embody/db";

/** The docker-compose default, matching what the host falls back to. */
export const DEFAULT_DATABASE_URL = "postgres://embody:embody@localhost:5432/embody";

/**
 * Whether a Postgres is actually up, so an integration suite can skip instead of fail.
 *
 * Integration tests here are worth more than they cost, but only if a contributor
 * without docker running still gets a clean run. Pair it with vitest's `describe.skip`:
 *
 *     const suite = (await databaseReachable()) ? describe : describe.skip;
 *
 * Returns a boolean rather than taking over the test framework, so this package needs
 * no opinion about which runner you use.
 */
export async function databaseReachable(url?: string): Promise<boolean> {
  const target = url ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  try {
    const handle = createDb(target, { max: 1 });
    await handle.sql`select 1`;
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

// ── Booting a runtime ────────────────────────────────────────────────────────
export { defineConfig, bootRuntime, makeExecutor, mountApi, createDevIdentity } from "@embody/host";
export type { Runtime, Executor, EmbodyConfig } from "@embody/host";

/**
 * The outbox drain. Pass `autoStart: false` and call `tick()` to advance delivery
 * deterministically — a test that sleeps on the poll loop is a test that flakes.
 */
export { startWorker } from "@embody/host";
export type { WorkerOptions, RunningWorker } from "@embody/host";

// ── Driving a kernel directly, without a host ────────────────────────────────
// For unit-level tests of boot order, capability enforcement, and hook composition.
export { EmbodyKernel, HookRegistry, createRequestContext, AllowAllAuthorizer } from "@embody/kernel";
export type { BootedKernel, KernelContext, EmbodyPlugin, Principal } from "@embody/kernel";

// ── Test doubles and fixtures ────────────────────────────────────────────────
export { createSilentLogger } from "@embody/kernel";
export { createDb } from "@embody/db";

/** `core` is always registered by the host; tests driving a bare kernel must add it. */
export { corePlugin } from "@embody/core";
