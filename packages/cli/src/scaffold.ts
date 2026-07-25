/**
 * Scaffolding — adding a plugin to an app you already have.
 *
 * This used to write into sibling directories of a cloned monorepo (`custom/`,
 * `deploy/`, `catalog/`) and emit `workspace:*` dependencies, because your app WAS the
 * embody repo. It is not any more: embody arrives from npm, and your app is an ordinary
 * project. So there is exactly one generator left, and it writes inside whatever
 * project you happen to be standing in.
 *
 * Creating the project itself is `npm create embody-app`, not this.
 */
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** "field-service" -> "fieldService". Kebab names are not valid JS identifiers. */
function camel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** "hipaa-rules" -> "hipaa_rules". Postgres schema names cannot contain hyphens. */
function schemaName(name: string): string {
  return name.replace(/-/g, "_");
}

/**
 * Walk up to the nearest package.json — the root of the developer's app.
 *
 * Deliberately not pnpm-workspace.yaml. That assumed the app lived inside a clone of
 * this monorepo, which is exactly the assumption npm distribution removes.
 */
export async function findProjectRoot(start = process.cwd()): Promise<string> {
  let dir = resolve(start);
  for (;;) {
    try {
      await access(join(dir, "package.json"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        throw new Error(
          "Not inside a project (no package.json found). Create one first:\n" +
            "  npm create embody-app <name>",
        );
      }
      dir = parent;
    }
  }
}

async function writeNew(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing file: ${path}`);
  } catch (err) {
    if (String(err).includes("Refusing")) throw err;
  }
  await writeFile(path, contents, "utf8");
}

/**
 * Stamp a new plugin inside the current app and enable it.
 *
 * The wiring is the part worth automating: without it you would add the import and the
 * array entry to embody.config.ts by hand, and a plugin that is not in that array does
 * nothing at all, silently.
 */
export async function newPlugin(name: string, configPath = "embody.config.ts"): Promise<string[]> {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid plugin name "${name}" (lowercase letters, digits, hyphens).`);
  }
  const root = await findProjectRoot();
  const dir = join(root, "plugins", name);
  const schema = schemaName(name);
  const ident = camel(name);
  const written: string[] = [];
  const put = async (rel: string, body: string) => {
    const p = join(dir, rel);
    await writeNew(p, body);
    written.push(p);
  };

  await put(
    "migrations/0001_init.sql",
    `-- ${name} — this plugin's own schema. It owns these tables outright.\n` +
      `-- Every table carries org_id and enables RLS, so a bug in application code\n` +
      `-- cannot leak another tenant's rows (Decision D1).\n\n` +
      `create schema if not exists ${schema};\n\n` +
      `-- create table ${schema}.example (\n` +
      `--   id         uuid primary key default gen_random_uuid(),\n` +
      `--   org_id     uuid not null references core.orgs(id) on delete cascade,\n` +
      `--   created_at timestamptz not null default now()\n` +
      `-- );\n` +
      `-- alter table ${schema}.example enable row level security;\n` +
      `-- create policy tenant_isolation on ${schema}.example\n` +
      `--   using (org_id = core.current_org())\n` +
      `--   with check (org_id = core.current_org());\n`,
  );

  await put(
    "plugin.ts",
    `/**\n * ${name} — your own plugin.\n *\n` +
      ` * It rides the same SPI a published plugin uses; the kernel cannot tell the\n` +
      ` * difference. Nothing in node_modules needs to change for this to take effect.\n */\n` +
      `import { fileURLToPath } from "node:url";\n` +
      `import type { EmbodyPlugin } from "@embody/plugin-sdk";\n\n` +
      `export const ${ident}MigrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));\n\n` +
      `export const ${ident}Plugin: EmbodyPlugin = {\n` +
      `  id: "${name}",\n  schema: "${schema}",\n  dependsOn: ["core"],\n` +
      `  // The kernel REJECTS anything you touch that is not declared here.\n` +
      `  capabilities: {\n` +
      `    // hooks: ["crm.deal.beforeUpdate"],\n` +
      `    // services: { consume: ["core.registry"] },\n` +
      `  },\n` +
      `  migrations: { dir: ${ident}MigrationsDir, schema: "${schema}" },\n\n` +
      `  init(ctx) {\n    ctx.logger.info("${name} loaded");\n  },\n\n` +
      `  // A vetoable rule. It runs INSIDE the tenant transaction around a real write,\n` +
      `  // so throwing here rolls the write back — for agents, REST and the CLI alike.\n` +
      `  // Declare the hook in capabilities.hooks above before enabling this.\n` +
      `  // registerHooks(hooks) {\n` +
      `  //   hooks.register("crm.deal.beforeUpdate", (deal: Record<string, unknown>) => {\n` +
      `  //     if (deal.stage === "closed_won" && !yourConditionHolds(deal)) {\n` +
      `  //       throw new Error("Company policy: ...");\n` +
      `  //     }\n` +
      `  //   });\n  // },\n};\n`,
  );
  await put(
    "index.ts",
    `export { ${ident}Plugin, ${ident}MigrationsDir } from "./plugin.ts";\n`,
  );
  await put(
    "plugin.test.ts",
    `import { describe, it, expect } from "vitest";\nimport { ${ident}Plugin } from "./plugin.ts";\n\n` +
      `describe("${name}", () => {\n` +
      `  it("declares an id and a schema it owns", () => {\n` +
      `    expect(${ident}Plugin.id).toBe("${name}");\n` +
      `    expect(${ident}Plugin.schema).toBe("${schema}");\n  });\n});\n`,
  );

  written.push(...(await wireIntoConfig(root, name, configPath)));
  return written;
}

/**
 * Add the plugin's import and array entry to the app's config, in place.
 *
 * Edits rather than instructs, because a plugin missing from `plugins: [...]` fails
 * silently — it simply does not run, with no error to notice.
 */
async function wireIntoConfig(
  root: string,
  pluginName: string,
  configPath: string,
): Promise<string[]> {
  const cfgPath = join(root, configPath);
  try {
    await access(cfgPath);
  } catch {
    throw new Error(
      `No config at ${configPath}. An embody app needs one that default-exports\n` +
        `defineConfig({ plugins: [...] }). Create a project with: npm create embody-app <name>`,
    );
  }

  const ident = `${camel(pluginName)}Plugin`;
  const specifier = `./plugins/${pluginName}/index.ts`;
  let cfg = await readFile(cfgPath, "utf8");

  if (!cfg.includes(`from "${specifier}"`)) {
    const importLine = `import { ${ident} } from "${specifier}";`;
    const imports = [...cfg.matchAll(/^import .*$/gm)];
    const last = imports.at(-1);
    if (last?.index === undefined) throw new Error(`Could not find imports in ${cfgPath}`);
    const at = last.index + last[0].length;
    cfg = cfg.slice(0, at) + "\n" + importLine + cfg.slice(at);
  }

  if (!new RegExp(`\\b${ident}\\b\\s*[,\\]]`).test(cfg)) {
    const list = cfg.match(/plugins:\s*\[([^\]]*)\]/);
    if (!list) throw new Error(`Could not find a \`plugins: [...]\` array in ${cfgPath}`);
    const inner = list[1]!.trim();
    cfg = cfg.replace(
      list[0],
      `plugins: [${inner ? `${inner.replace(/,\s*$/, "")}, ` : ""}${ident}]`,
    );
  }

  await writeFile(cfgPath, cfg, "utf8");
  return [cfgPath];
}
