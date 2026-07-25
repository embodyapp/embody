/**
 * `embody doctor` against real directory trees in a tmpdir.
 *
 * The duplicate-SDK case is the one that matters. It is the only failure in the whole
 * system that produces no error at runtime — a plugin whose hooks registered against a
 * second SDK copy simply never fires — so the check is worth testing against an actual
 * node_modules layout rather than a mock.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, formatReport } from "./doctor.ts";

let root: string;

const pkg = async (dir: string, body: Record<string, unknown>) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(body, null, 2));
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "embody-doctor-"));
  await pkg(root, { name: "an-app", private: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("embody doctor", () => {
  it("passes a clean app with one SDK copy", async () => {
    await pkg(join(root, "node_modules/@embody/plugin-sdk"), {
      name: "@embody/plugin-sdk",
      version: "1.0.0",
    });

    const report = await runDoctor(root);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(formatReport(report).code).toBe(0);
  });

  it("FAILS when two copies of the SDK are installed, and prints both paths", async () => {
    await pkg(join(root, "node_modules/@embody/plugin-sdk"), {
      name: "@embody/plugin-sdk",
      version: "1.0.0",
    });
    // A plugin that dragged in its own copy — the shape that breaks hook registration.
    await pkg(join(root, "node_modules/embody-plugin-billing"), {
      name: "embody-plugin-billing",
      version: "1.0.0",
      keywords: ["embody-plugin"],
    });
    await pkg(
      join(root, "node_modules/embody-plugin-billing/node_modules/@embody/plugin-sdk"),
      { name: "@embody/plugin-sdk", version: "2.0.0" },
    );

    const report = await runDoctor(root);
    expect(report.ok).toBe(false);
    const { text, code } = formatReport(report);
    expect(code).toBe(1);
    expect(text).toContain("2 separate copies");
    expect(text).toContain("1.0.0");
    expect(text).toContain("2.0.0");
    // The message has to explain the silence, or a reader will not believe it matters.
    expect(text).toMatch(/silently never run/);
  });

  it("counts a symlinked SDK as one copy, not two", async () => {
    // pnpm's node_modules is a forest of symlinks into one store. Resolving through
    // realpath is what keeps this from reporting a false positive on every pnpm app.
    const real = join(root, "node_modules/@embody/plugin-sdk");
    await pkg(real, { name: "@embody/plugin-sdk", version: "1.0.0" });
    await pkg(join(root, "node_modules/embody-plugin-billing"), {
      name: "embody-plugin-billing",
      keywords: ["embody-plugin"],
    });
    await mkdir(join(root, "node_modules/embody-plugin-billing/node_modules/@embody"), {
      recursive: true,
    });
    await symlink(
      real,
      join(root, "node_modules/embody-plugin-billing/node_modules/@embody/plugin-sdk"),
    );

    const report = await runDoctor(root);
    expect(report.ok).toBe(true);
  });

  it("warns when a plugin depends on the SDK instead of peering it", async () => {
    await pkg(join(root, "node_modules/@embody/plugin-sdk"), {
      name: "@embody/plugin-sdk",
      version: "1.0.0",
    });
    await pkg(join(root, "node_modules/embody-plugin-billing"), {
      name: "embody-plugin-billing",
      keywords: ["embody-plugin"],
      dependencies: { "@embody/plugin-sdk": "^1.0.0" },
    });

    const report = await runDoctor(root);
    const { text, code } = formatReport(report);
    // A warning, not an error: it is the cause of a duplicate, not a duplicate itself.
    expect(code).toBe(0);
    expect(text).toContain("embody-plugin-billing declares @embody/plugin-sdk as a dependency");
  });

  it("ignores packages that are not plugins", async () => {
    await pkg(join(root, "node_modules/some-lib"), {
      name: "some-lib",
      dependencies: { "@embody/plugin-sdk": "^1.0.0" },
    });
    const report = await runDoctor(root);
    expect(report.findings).toEqual([]);
  });

  it("FAILS when two plugins claim the same Postgres schema", async () => {
    const report = await runDoctor(root, {
      configPath: "embody.config.ts",
      loadPlugins: async () => [
        { id: "crm", schema: "crm" },
        { id: "billing", schema: "shared" },
        { id: "invoicing", schema: "shared" },
      ],
    });
    expect(report.ok).toBe(false);
    const { text } = formatReport(report);
    expect(text).toContain("billing, invoicing");
    expect(text).toContain('"shared"');
  });

  it("reports a config that will not load, rather than crashing", async () => {
    const report = await runDoctor(root, {
      configPath: "embody.config.ts",
      loadPlugins: async () => {
        throw new Error("Cannot find module './nope.ts'");
      },
    });
    expect(report.ok).toBe(false);
    expect(formatReport(report).text).toContain("Cannot find module");
  });

  it("says which checks it ran, so a pass is not mistaken for a full audit", async () => {
    const { text } = formatReport(await runDoctor(root));
    expect(text).toContain("checked: one shared @embody/plugin-sdk instance");
    // Config checks did not run here; the report must not imply they did.
    expect(text).not.toContain("config loads");
  });
});
