/**
 * Host tests.
 *   - defineConfig is a pass-through (always runs, no DB).
 *   - startHost registers `core` (foundation) plus the config's apps, in dependsOn
 *     order, and its migrate-only mode boots without serving. Requires the
 *     docker-compose Postgres; skips cleanly if unreachable.
 *
 * Run: `pnpm --filter @embody/host exec vitest run`
 */
import { describe, it, expect } from "vitest";
import { createSilentLogger, type EmbodyPlugin } from "@embody/kernel";
import { createDb } from "@embody/db";
import { defineConfig, resolvePlugins } from "./config.ts";
import { startHost } from "./host.ts";

describe("defineConfig", () => {
  it("returns the config unchanged", () => {
    const config = { plugins: [] };
    expect(defineConfig(config)).toBe(config);
  });
});

describe("resolvePlugins", () => {
  const plugin: EmbodyPlugin = { id: "x", schema: "x", capabilities: {} };

  it("reads the `plugins` key", () => {
    expect(resolvePlugins({ plugins: [plugin] })).toEqual([plugin]);
  });

  it("still honours the deprecated `apps` key, with a warning", () => {
    const warnings: string[] = [];
    const logger = { ...createSilentLogger(), warn: (m: string) => void warnings.push(m) };
    expect(resolvePlugins({ apps: [plugin] }, logger)).toEqual([plugin]);
    expect(warnings.join()).toMatch(/deprecated `apps:` key/);
  });

  it("does not warn when `plugins` is used", () => {
    const warnings: string[] = [];
    const logger = { ...createSilentLogger(), warn: (m: string) => void warnings.push(m) };
    resolvePlugins({ plugins: [] }, logger);
    expect(warnings).toEqual([]);
  });
});

const OWNER_URL =
  process.env.DATABASE_URL ?? "postgres://embody:embody@localhost:5432/embody";

async function reachable(url: string): Promise<boolean> {
  try {
    const h = createDb(url, { max: 1 });
    await h.sql`select 1`;
    await h.close();
    return true;
  } catch {
    return false;
  }
}

// A minimal selectable app: enough to prove config-driven registration + ordering,
// without owning migrations (so the test needs no app-specific schema).
const billingApp: EmbodyPlugin = {
  id: "billing",
  schema: "billing",
  dependsOn: ["core"],
  capabilities: {},
};

const canRun = await reachable(OWNER_URL);
const suite = canRun ? describe : describe.skip;

suite("startHost (integration)", () => {
  it("registers core + configured apps in dependsOn order", async () => {
    const host = await startHost({
      config: defineConfig({ plugins: [billingApp] }),
      mode: "migrate-only",
      databaseUrl: OWNER_URL,
      logger: createSilentLogger(),
    });
    expect(host.plugins.map((p) => p.id)).toEqual(["core", "billing"]);
    // migrate-only does not start a server.
    expect(host.stop).toBeUndefined();
  });

  it("registers only core when no apps are enabled", async () => {
    const host = await startHost({
      config: defineConfig({ plugins: [] }),
      mode: "migrate-only",
      databaseUrl: OWNER_URL,
      logger: createSilentLogger(),
    });
    expect(host.plugins.map((p) => p.id)).toEqual(["core"]);
  });
});
