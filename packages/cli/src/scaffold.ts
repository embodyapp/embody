/**
 * Scaffolding — the developer half of the CLI.
 *
 * Every generator here writes into exactly one bucket, and which bucket it is decides
 * who owns the result (see OWNERSHIP.md):
 *   - `new custom`     -> custom/  — YOURS. The normal way to change how embody behaves.
 *   - `new deployment` -> deploy/  — YOURS. What you actually run.
 *   - `new app`        -> catalog/ — UPSTREAM. Only for contributing a first-party app;
 *                                   anything you write there conflicts on upgrade.
 *
 * Templates mirror catalog/crm and examples/service-crm so a scaffolded package
 * matches the conventions exactly.
 */
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** "b2b-saas" -> "b2bSaas". Kebab package names are not valid JS identifiers. */
function camel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** "hipaa-rules" -> "hipaa_rules". Postgres schema names cannot contain hyphens. */
function schemaName(name: string): string {
  return name.replace(/-/g, "_");
}

/** The banner stamped on generated files that the user owns. */
const OWNED_BY_YOU =
  " * YOURS. Upstream never writes to this directory, so `git merge upstream/main`\n" +
  " * cannot conflict with anything here. See OWNERSHIP.md.";

/** Walk up from cwd to the workspace root (the dir containing pnpm-workspace.yaml). */
export async function findRepoRoot(start = process.cwd()): Promise<string> {
  let dir = resolve(start);
  for (;;) {
    try {
      await access(join(dir, "pnpm-workspace.yaml"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) throw new Error("Not inside an embody workspace (no pnpm-workspace.yaml found).");
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
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      if (String(err).includes("Refusing")) throw err;
    }
  }
  await writeFile(path, contents, "utf8");
}

export async function newApp(name: string): Promise<string[]> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid app name "${name}"`);
  const root = await findRepoRoot();
  const dir = join(root, "catalog", name);
  const ident = camel(name);
  const schema = schemaName(name);
  const written: string[] = [];
  const put = async (rel: string, body: string) => {
    const p = join(dir, rel);
    await writeNew(p, body);
    written.push(p);
  };

  await put(
    "package.json",
    JSON.stringify(
      {
        name: `@embody/${name}`,
        version: "0.0.0",
        type: "module",
        exports: { ".": "./src/index.ts" },
        types: "./src/index.ts",
        scripts: { typecheck: "tsc --noEmit" },
        dependencies: { "@embody/kernel": "workspace:*", zod: "^3.24.1" },
      },
      null,
      2,
    ) + "\n",
  );
  await put("tsconfig.json", `{\n  "extends": "../../tsconfig.base.json",\n  "include": ["src"]\n}\n`);
  await put(
    "migrations/0001_init.sql",
    `-- @embody/${name} — initial schema.\ncreate schema if not exists ${schema};\n`,
  );
  await put(
    "src/plugin.ts",
    `import { fileURLToPath } from "node:url";\nimport type { EmbodyPlugin } from "@embody/kernel";\n\nexport const ${ident}MigrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));\n\nexport const ${ident}Plugin: EmbodyPlugin = {\n  id: "${name}",\n  schema: "${schema}",\n  dependsOn: ["core"],\n  capabilities: {},\n  migrations: { dir: ${ident}MigrationsDir, schema: "${schema}" },\n  init(ctx) {\n    ctx.logger.info("${name} plugin initialised");\n  },\n};\n`,
  );
  await put("src/index.ts", `export { ${ident}Plugin, ${ident}MigrationsDir } from "./plugin.ts";\n`);
  return written;
}

/**
 * Stamp a deployable under `deploy/` — the thing you actually run, and yours to edit.
 * `apps` names catalog packages (`@embody/<app>`); `customs` names your own plugins
 * under `custom/`, which are workspace packages with plain unscoped names.
 */
export async function newDeployment(
  name: string,
  apps: string[] = [],
  customs: string[] = [],
): Promise<string[]> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid deployment name "${name}"`);
  const root = await findRepoRoot();
  const dir = join(root, "deploy", name);
  const written: string[] = [];
  const put = async (rel: string, body: string) => {
    const p = join(dir, rel);
    await writeNew(p, body);
    written.push(p);
  };

  const deps: Record<string, string> = {
    "@embody/core": "workspace:*",
    "@embody/host": "workspace:*",
  };
  for (const a of apps) deps[`@embody/${a}`] = "workspace:*";
  for (const c of customs) deps[c] = "workspace:*";

  await put(
    "package.json",
    JSON.stringify(
      {
        // Unscoped: this is your deployment, not a vendor package.
        name: `${name}-deployment`,
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: {
          typecheck: "tsc --noEmit",
          start: "embody-host ./embody.config.ts",
          dev: "embody-host ./embody.config.ts",
          migrate: "embody-host ./embody.config.ts --mode migrate-only",
        },
        dependencies: Object.fromEntries(Object.entries(deps).sort()),
      },
      null,
      2,
    ) + "\n",
  );
  await put("tsconfig.json", `{\n  "extends": "../../tsconfig.base.json",\n  "include": ["embody.config.ts"]\n}\n`);

  const importLines = [
    ...apps.map((a) => `import { ${camel(a)}Plugin } from "@embody/${a}";`),
    ...customs.map((c) => `import { ${camel(c)}Plugin } from "${c}";`),
  ];
  const list = [...apps, ...customs].map((n) => `${camel(n)}Plugin`).join(", ");
  await put(
    "embody.config.ts",
    `/**\n * ${name} deployment.\n *\n${OWNED_BY_YOU}\n *\n` +
      ` * A deployment is the embody host plus this list — there is no server code to fork.\n` +
      ` * Enable a catalog app:  pnpm add @embody/<app>, then add its plugin below.\n` +
      ` * Enable your own:       embody new custom <name> --for deploy/${name}\n */\n` +
      `import { defineConfig } from "@embody/host";\n${importLines.join("\n")}\n\n` +
      `export default defineConfig({\n  plugins: [${list}],\n});\n`,
  );
  return written;
}

/** @deprecated Renamed to `newDeployment` (it writes to deploy/, not services/). */
export const newService = newDeployment;

/**
 * Stamp a customization under `custom/` — the normal way to bend embody to your own
 * process. With `forDeployment` it also does the wiring that is otherwise four manual
 * steps: adds the workspace dependency, and inserts the import + array entry into that
 * deployment's embody.config.ts.
 */
export async function newCustom(
  name: string,
  forDeployment?: string,
): Promise<string[]> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid plugin name "${name}"`);
  const root = await findRepoRoot();
  const dir = join(root, "custom", name);
  const schema = schemaName(name);
  const ident = camel(name);
  const written: string[] = [];
  const put = async (rel: string, body: string) => {
    const p = join(dir, rel);
    await writeNew(p, body);
    written.push(p);
  };

  await put(
    "package.json",
    JSON.stringify(
      {
        // Unscoped and private: `@embody/*` is the vendor's npm scope, never yours,
        // and this package is only ever consumed inside this workspace.
        name,
        version: "0.0.0",
        private: true,
        type: "module",
        exports: { ".": "./src/index.ts" },
        types: "./src/index.ts",
        scripts: { typecheck: "tsc --noEmit", test: "vitest run" },
        dependencies: {
          "@embody/kernel": "workspace:*",
          "@embody/plugin-sdk": "workspace:*",
          zod: "^3.24.1",
        },
      },
      null,
      2,
    ) + "\n",
  );
  await put("tsconfig.json", `{\n  "extends": "../../tsconfig.base.json",\n  "include": ["src"]\n}\n`);

  await put(
    "migrations/0001_init.sql",
    `-- ${name} — your own schema. Owned by you; embody never migrates it for you.\n` +
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
    "src/plugin.ts",
    `/**\n * ${name} — your customization.\n *\n${OWNED_BY_YOU}\n *\n` +
      ` * It rides the same plugin SPI a first-party app uses. Enable it from your\n` +
      ` * deployment's embody.config.ts; nothing under framework/ or catalog/ changes.\n */\n` +
      `import { fileURLToPath } from "node:url";\n` +
      `import type { EmbodyPlugin } from "@embody/kernel";\n\n` +
      `export const ${ident}MigrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));\n\n` +
      `export const ${ident}Plugin: EmbodyPlugin = {\n` +
      `  id: "${name}",\n  schema: "${schema}",\n  dependsOn: ["core", "crm"],\n` +
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
    "src/index.ts",
    `export { ${ident}Plugin, ${ident}MigrationsDir } from "./plugin.ts";\n`,
  );
  await put(
    "src/plugin.test.ts",
    `import { describe, it, expect } from "vitest";\nimport { ${ident}Plugin } from "./plugin.ts";\n\n` +
      `describe("${name}", () => {\n` +
      `  it("declares an id and a schema it owns", () => {\n` +
      `    expect(${ident}Plugin.id).toBe("${name}");\n` +
      `    expect(${ident}Plugin.schema).toBe("${schema}");\n  });\n});\n`,
  );

  if (forDeployment) written.push(...(await wireIntoDeployment(root, name, forDeployment)));
  return written;
}

/**
 * Add a custom plugin to a deployment: workspace dependency + import + array entry.
 * Edits the two files in place rather than asking the developer to do it by hand.
 */
async function wireIntoDeployment(
  root: string,
  pluginName: string,
  target: string,
): Promise<string[]> {
  // Accept "acme", "deploy/acme" or an absolute path.
  const rel = target.replace(/^\.?\/?deploy\//, "");
  const dir = join(root, "deploy", rel);
  const pkgPath = join(dir, "package.json");
  const cfgPath = join(dir, "embody.config.ts");

  try {
    await access(cfgPath);
  } catch {
    throw new Error(
      `No deployment at deploy/${rel} (expected ${cfgPath}). ` +
        `Create one first: embody new deployment ${rel}`,
    );
  }

  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  pkg.dependencies = Object.fromEntries(
    Object.entries({ ...pkg.dependencies, [pluginName]: "workspace:*" }).sort(),
  );
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

  const ident = `${camel(pluginName)}Plugin`;
  let cfg = await readFile(cfgPath, "utf8");
  if (!cfg.includes(`from "${pluginName}"`)) {
    const importLine = `import { ${ident} } from "${pluginName}";`;
    const imports = [...cfg.matchAll(/^import .*$/gm)];
    const last = imports.at(-1);
    if (!last?.index) throw new Error(`Could not find imports in ${cfgPath}`);
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

  return [pkgPath, cfgPath];
}
