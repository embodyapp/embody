/**
 * Scaffolding tests. These run against a throwaway workspace in a temp directory, so
 * they exercise the real filesystem writes without touching the repo.
 *
 * The behaviour worth pinning is the wiring: `new custom --for` must leave a
 * deployment that actually compiles — a valid JS identifier for a kebab-case package
 * name, the import present, and the plugin in the `plugins` array.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp, newCustom, newDeployment } from "./scaffold.ts";

let root: string;
let cwd: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "embody-scaffold-"));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'custom/*'\n");
  await mkdir(join(root, "custom"), { recursive: true });
  await mkdir(join(root, "deploy"), { recursive: true });
  cwd = process.cwd();
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(cwd);
  await rm(root, { recursive: true, force: true });
});

const readJson = async (p: string) => JSON.parse(await readFile(join(root, p), "utf8"));

describe("newCustom", () => {
  it("names the package unscoped and private — @embody/* is the vendor's scope", async () => {
    await newCustom("hipaa-rules");
    const pkg = await readJson("custom/hipaa-rules/package.json");
    expect(pkg.name).toBe("hipaa-rules");
    expect(pkg.private).toBe(true);
    expect(JSON.stringify(pkg)).not.toContain("@embody/hipaa");
  });

  it("converts a kebab name into a legal schema and identifier", async () => {
    await newCustom("hipaa-rules");
    const plugin = await readFile(join(root, "custom/hipaa-rules/src/plugin.ts"), "utf8");
    expect(plugin).toContain("export const hipaaRulesPlugin");
    expect(plugin).toContain('schema: "hipaa_rules"');
    expect(plugin).toContain('id: "hipaa-rules"');
    const sql = await readFile(join(root, "custom/hipaa-rules/migrations/0001_init.sql"), "utf8");
    expect(sql).toContain("create schema if not exists hipaa_rules;");
  });

  it("rejects a name that is not a legal package name", async () => {
    await expect(newCustom("Not Valid")).rejects.toThrow(/Invalid plugin name/);
  });

  it("leaves the plugin disabled when no deployment is given", async () => {
    const written = await newCustom("standalone");
    expect(written.every((p) => p.includes("custom/standalone"))).toBe(true);
  });
});

describe("newCustom --for", () => {
  it("adds the dependency, the import and the array entry in one step", async () => {
    await newDeployment("northwind", ["crm"]);
    await newCustom("hipaa-rules", "deploy/northwind");

    const pkg = await readJson("deploy/northwind/package.json");
    expect(pkg.dependencies["hipaa-rules"]).toBe("workspace:*");

    const cfg = await readFile(join(root, "deploy/northwind/embody.config.ts"), "utf8");
    expect(cfg).toContain('import { hipaaRulesPlugin } from "hipaa-rules";');
    expect(cfg).toMatch(/plugins: \[crmPlugin, hipaaRulesPlugin\]/);
  });

  it("wires into an empty plugin list without leaving a stray comma", async () => {
    await newDeployment("bare");
    await newCustom("only-one", "deploy/bare");
    const cfg = await readFile(join(root, "deploy/bare/embody.config.ts"), "utf8");
    expect(cfg).toMatch(/plugins: \[onlyOnePlugin\]/);
  });

  it("accepts the deployment name with or without the deploy/ prefix", async () => {
    await newDeployment("northwind");
    await newCustom("rules-a", "northwind");
    const cfg = await readFile(join(root, "deploy/northwind/embody.config.ts"), "utf8");
    expect(cfg).toContain("rulesAPlugin");
  });

  it("fails clearly when the deployment does not exist", async () => {
    await expect(newCustom("orphan", "deploy/nope")).rejects.toThrow(
      /No deployment at deploy\/nope/,
    );
  });
});

describe("newDeployment", () => {
  it("emits `plugins:` and camel-cases hyphenated catalog apps", async () => {
    await newDeployment("acme", ["crm", "field-service"]);
    const cfg = await readFile(join(root, "deploy/acme/embody.config.ts"), "utf8");
    expect(cfg).toContain('import { fieldServicePlugin } from "@embody/field-service";');
    expect(cfg).toMatch(/plugins: \[crmPlugin, fieldServicePlugin\]/);
    expect(cfg).not.toContain("apps:");
  });

  it("writes an unscoped, private package", async () => {
    await newDeployment("acme");
    const pkg = await readJson("deploy/acme/package.json");
    expect(pkg.name).toBe("acme-deployment");
    expect(pkg.private).toBe(true);
  });
});

describe("newApp", () => {
  it("writes into catalog/ and keeps the vendor scope", async () => {
    await newApp("billing");
    const pkg = await readJson("catalog/billing/package.json");
    expect(pkg.name).toBe("@embody/billing");
  });
});
