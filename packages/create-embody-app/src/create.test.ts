/**
 * What `npm create embody-app` produces.
 *
 * The load-bearing test is the last one: the generated project must have the same shape
 * as examples/custom-crm in this repository. That example is what people read to
 * understand how an embody app is put together, so if the generator drifts away from
 * it, every reader is learning a layout that no longer gets created.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, EMBODY_VERSION } from "./index.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const EXAMPLE = join(REPO_ROOT, "examples/custom-crm");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "embody-create-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const make = (name = "my-crm") => createApp(name, { directory: join(dir, name) });
const read = (name: string, rel: string) => readFile(join(dir, name, rel), "utf8");
const json = async (name: string, rel: string) =>
  JSON.parse(await read(name, rel)) as Record<string, never>;

describe("createApp", () => {
  it("writes a project you own outright, with no trace of this repo", async () => {
    const written = await make();
    const rels = written.map((p) => relative(join(dir, "my-crm"), p)).sort();
    expect(rels).toEqual([
      ".env.example",
      "README.md",
      "embody.config.ts",
      "migrations/0001_init.sql",
      "package.json",
      "src/index.ts",
      "src/plugin.ts",
      "tsconfig.json",
    ]);
  });

  it("depends on published versions, never the workspace protocol", async () => {
    await make();
    const pkg = (await json("my-crm", "package.json")) as unknown as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, range] of Object.entries(all)) {
      expect(range, `${name} must not use workspace:`).not.toContain("workspace:");
    }
    expect(pkg.dependencies["@embody/host"]).toBe(EMBODY_VERSION);
    expect(pkg.dependencies["@embody/crm"]).toBe(EMBODY_VERSION);
  });

  it("installs every tool its own README tells you to run", async () => {
    await make();
    const pkg = (await json("my-crm", "package.json")) as unknown as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const readme = await read("my-crm", "README.md");
    const installed = { ...pkg.dependencies, ...pkg.devDependencies };
    // `npx embody ...` silently reaches for the registry when the CLI is absent.
    if (readme.includes("npx embody ")) {
      expect(installed["@embody/cli"]).toBeDefined();
    }
    expect(installed["@embody/host"]).toBeDefined(); // provides embody-host
  });

  it("extends no tsconfig outside the project", async () => {
    // `extends: "../../tsconfig.base.json"` only resolves inside a clone of this repo.
    await make();
    const ts = await read("my-crm", "tsconfig.json");
    expect(ts).not.toContain("tsconfig.base.json");
    expect(ts).not.toContain("..");
  });

  it("generates a plugin that imports only the SDK", async () => {
    await make();
    const src = await read("my-crm", "src/plugin.ts");
    expect(src).toContain('from "@embody/plugin-sdk"');
    expect(src).not.toMatch(/@embody\/(kernel|core|db|host)/);
  });

  it("lists both the published plugin and the app's own in the config", async () => {
    await make();
    const cfg = await read("my-crm", "embody.config.ts");
    expect(cfg).toContain('import { crmPlugin } from "@embody/crm";');
    expect(cfg).toContain('import { myCrmPlugin } from "./src/plugin.ts";');
    expect(cfg).toMatch(/plugins: \[crmPlugin, myCrmPlugin\]/);
  });

  it("honours --plugins", async () => {
    await createApp("shop", {
      directory: join(dir, "shop"),
      plugins: ["crm", "b2b-saas"],
    });
    const cfg = await read("shop", "embody.config.ts");
    expect(cfg).toContain('import { b2bSaasPlugin } from "@embody/b2b-saas";');
    expect(cfg).toMatch(/plugins: \[crmPlugin, b2bSaasPlugin, shopPlugin\]/);
  });

  it("turns a hyphenated name into a valid identifier and schema", async () => {
    await createApp("field-service", { directory: join(dir, "field-service") });
    const src = await read("field-service", "src/plugin.ts");
    expect(src).toContain("export const fieldServicePlugin");
    expect(src).toContain('schema: "field_service"');
  });

  it("rejects invalid names", async () => {
    await expect(createApp("My App", { directory: dir })).rejects.toThrow(/Invalid app name/);
  });

  it("refuses to overwrite existing files", async () => {
    await make();
    await expect(make()).rejects.toThrow(/Refusing to overwrite/);
  });

  it("matches the shape of examples/custom-crm", async () => {
    // If this fails, fix the example or fix the generator — but do not let them differ.
    await access(EXAMPLE); // the example must exist for this test to mean anything
    await make();
    for (const rel of ["embody.config.ts", "src/plugin.ts", "src/index.ts", "migrations"]) {
      await expect(
        access(join(EXAMPLE, rel)),
        `examples/custom-crm is missing ${rel}, which the generator emits`,
      ).resolves.toBeUndefined();
      await expect(
        access(join(dir, "my-crm", rel)),
        `generated app is missing ${rel}, which examples/custom-crm has`,
      ).resolves.toBeUndefined();
    }

    // Both put the app's own plugin behind a relative import rather than a package name.
    const exampleCfg = await readFile(join(EXAMPLE, "embody.config.ts"), "utf8");
    const generatedCfg = await read("my-crm", "embody.config.ts");
    expect(exampleCfg).toContain('from "./src/plugin.ts"');
    expect(generatedCfg).toContain('from "./src/plugin.ts"');
  });
});
