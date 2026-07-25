/**
 * `embody new plugin` against a real project directory.
 *
 * The wiring assertions carry the weight: a plugin that exists on disk but is missing
 * from `plugins: [...]` does nothing at all, and says nothing about it. Generating the
 * files without enabling them would be the worst of both outcomes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newPlugin, findProjectRoot } from "./scaffold.ts";

let root: string;
let cwd: string;

const CONFIG = `import { defineConfig } from "@embody/host";
import { crmPlugin } from "@embody/crm";

export default defineConfig({
  plugins: [crmPlugin],
});
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "embody-scaffold-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "an-app" }));
  await writeFile(join(root, "embody.config.ts"), CONFIG);
  cwd = process.cwd();
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(cwd);
  await rm(root, { recursive: true, force: true });
});

const config = () => readFile(join(root, "embody.config.ts"), "utf8");

describe("findProjectRoot", () => {
  it("finds the nearest package.json, not a workspace file", async () => {
    // The old implementation required pnpm-workspace.yaml, which assumed your app was
    // a clone of the embody monorepo. An installed app has no such file.
    await mkdir(join(root, "src/deep"), { recursive: true });
    expect(await findProjectRoot(join(root, "src/deep"))).toBe(root);
  });

  it("explains how to create a project when there is no package.json", async () => {
    const orphan = await mkdtemp(join(tmpdir(), "embody-orphan-"));
    await expect(findProjectRoot(orphan)).rejects.toThrow(/npm create embody-app/);
    await rm(orphan, { recursive: true, force: true });
  });
});

describe("newPlugin", () => {
  it("writes the plugin inside the project, not a sibling bucket", async () => {
    const written = await newPlugin("field-service");
    expect(written.some((p) => p.endsWith("plugins/field-service/plugin.ts"))).toBe(true);
    expect(written.some((p) => p.endsWith("plugins/field-service/migrations/0001_init.sql"))).toBe(
      true,
    );
  });

  it("enables the plugin in the config, since an unlisted plugin fails silently", async () => {
    await newPlugin("field-service");
    const cfg = await config();
    expect(cfg).toContain(
      'import { fieldServicePlugin } from "./plugins/field-service/index.ts";',
    );
    expect(cfg).toMatch(/plugins: \[crmPlugin, fieldServicePlugin\]/);
  });

  it("camel-cases hyphenated names into valid identifiers", async () => {
    await newPlugin("field-service");
    const src = await readFile(join(root, "plugins/field-service/plugin.ts"), "utf8");
    expect(src).toContain("export const fieldServicePlugin");
    // Postgres schemas cannot contain hyphens.
    expect(src).toContain('schema: "field_service"');
  });

  it("imports only the SDK, so a generated plugin obeys the one-package rule", async () => {
    await newPlugin("billing");
    const src = await readFile(join(root, "plugins/billing/plugin.ts"), "utf8");
    expect(src).toContain('from "@embody/plugin-sdk"');
    expect(src).not.toMatch(/@embody\/(kernel|core|db|host)/);
  });

  it("generates no workspace: dependencies or repo-relative tsconfig paths", async () => {
    // Both were artifacts of scaffolding into a clone of this monorepo.
    const written = await newPlugin("billing");
    for (const path of written) {
      const body = await readFile(path, "utf8");
      expect(body).not.toContain("workspace:*");
      expect(body).not.toContain("../../tsconfig.base.json");
    }
  });

  it("is idempotent about the config when run twice for different plugins", async () => {
    await newPlugin("billing");
    await newPlugin("field-service");
    const cfg = await config();
    expect(cfg).toMatch(/plugins: \[crmPlugin, billingPlugin, fieldServicePlugin\]/);
  });

  it("rejects names that are not valid package or schema names", async () => {
    await expect(newPlugin("Field Service")).rejects.toThrow(/Invalid plugin name/);
    await expect(newPlugin("9lives")).rejects.toThrow(/Invalid plugin name/);
  });

  it("refuses to overwrite an existing plugin", async () => {
    await newPlugin("billing");
    await expect(newPlugin("billing")).rejects.toThrow(/Refusing to overwrite/);
  });

  it("fails clearly when the project has no embody config", async () => {
    await rm(join(root, "embody.config.ts"));
    await expect(newPlugin("billing")).rejects.toThrow(/No config at embody\.config\.ts/);
  });
});
