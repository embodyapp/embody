/**
 * `npm create embody-app <name>` — the entry point that replaces forking.
 *
 * embody is a headless business operating system: you compose an app from plugins
 * rather than editing a runtime. That only works if getting started produces a project
 * you own outright — no clone of this repo, no upstream remote, nothing to merge. What
 * this writes is an ordinary npm project that happens to depend on @embody/*.
 *
 * The output deliberately mirrors examples/custom-crm in the embody repository. If the
 * two ever drift, the example is what is wrong: it exists to be the readable version of
 * whatever this generates.
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * The version range stamped into generated dependencies.
 *
 * Pinned to this generator's own version so a project is always scaffolded against the
 * runtime it was designed for, rather than whatever happens to be latest that day.
 */
export const EMBODY_VERSION: string = "^0.0.0";

function camel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function schemaName(name: string): string {
  return name.replace(/-/g, "_");
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

export interface CreateOptions {
  /** Directory to create the app in. Defaults to `./<name>`. */
  directory?: string;
  /** Published plugins to enable up front. */
  plugins?: string[];
}

export async function createApp(name: string, options: CreateOptions = {}): Promise<string[]> {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid app name "${name}" (lowercase letters, digits, hyphens).`);
  }
  const root = resolve(options.directory ?? name);
  const appIdent = camel(name);
  const schema = schemaName(name);
  const plugins = options.plugins ?? ["crm"];

  const written: string[] = [];
  const put = async (rel: string, body: string) => {
    const p = join(root, rel);
    await writeNew(p, body);
    written.push(p);
  };

  const deps: Record<string, string> = {
    "@embody/host": EMBODY_VERSION,
    "@embody/plugin-sdk": EMBODY_VERSION,
    zod: "^3.24.1",
  };
  for (const p of plugins) deps[`@embody/${p}`] = EMBODY_VERSION;

  await put(
    "package.json",
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          start: "embody-host ./embody.config.ts",
          dev: "embody-host ./embody.config.ts",
          migrate: "embody-host ./embody.config.ts --mode migrate-only",
        },
        dependencies: Object.fromEntries(Object.entries(deps).sort()),
        devDependencies: {
          // The CLI is what the generated README tells you to reach for
          // (`npx embody doctor`, `npx embody new plugin`), so it has to be here
          // rather than resolved from the registry on first use.
          "@embody/cli": EMBODY_VERSION,
          "@embody/testing": EMBODY_VERSION,
          typescript: "^5.7.2",
          vitest: "^2.1.8",
        },
        engines: { node: ">=20" },
      },
      null,
      2,
    ) + "\n",
  );

  await put(
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          isolatedModules: true,
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
        },
        include: ["src", "plugins", "embody.config.ts"],
      },
      null,
      2,
    ) + "\n",
  );

  const importLines = plugins.map((p) => `import { ${camel(p)}Plugin } from "@embody/${p}";`);
  const pluginList = [...plugins.map((p) => `${camel(p)}Plugin`), `${appIdent}Plugin`];

  await put(
    "embody.config.ts",
    `/**\n * ${name} — which plugins this app runs.\n *\n` +
      ` * This file is the selection mechanism, and it is the whole of your server. There\n` +
      ` * is no framework to fork: \`core\` is always registered by the host, published\n` +
      ` * plugins are imported by package name, and your own come from ./plugins — the\n` +
      ` * kernel does not distinguish them.\n *\n` +
      ` * DATABASE_URL and PORT come from the environment, so this same file runs\n` +
      ` * unchanged locally and in production.\n */\n` +
      `import { defineConfig } from "@embody/host";\n${importLines.join("\n")}\n` +
      `import { ${appIdent}Plugin } from "./src/plugin.ts";\n\n` +
      `export default defineConfig({\n  plugins: [${pluginList.join(", ")}],\n});\n`,
  );

  await put(
    "migrations/0001_init.sql",
    `-- ${name} — your app's own schema. You own these tables outright.\n` +
      `-- Every table carries org_id and enables RLS, so a bug in application code\n` +
      `-- cannot leak another tenant's rows.\n\n` +
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
    `/**\n * ${name} — this app's own plugin.\n *\n` +
      ` * Everything specific to your business goes here: rules that gate writes, extra\n` +
      ` * fields, tools your agents can call. It uses exactly the same SPI a published\n` +
      ` * plugin uses, so anything you build here could later be published for others.\n */\n` +
      `import { fileURLToPath } from "node:url";\n` +
      `import type { EmbodyPlugin } from "@embody/plugin-sdk";\n\n` +
      `export const ${appIdent}MigrationsDir = fileURLToPath(\n` +
      `  new URL("../migrations", import.meta.url),\n);\n\n` +
      `export const ${appIdent}Plugin: EmbodyPlugin = {\n` +
      `  id: "${name}",\n  schema: "${schema}",\n  dependsOn: ["core"],\n` +
      `  // The kernel REJECTS anything you touch that is not declared here.\n` +
      `  capabilities: {\n` +
      `    // hooks: ["crm.deal.beforeUpdate"],\n` +
      `    // services: { consume: ["core.registry"] },\n` +
      `  },\n` +
      `  migrations: { dir: ${appIdent}MigrationsDir, schema: "${schema}" },\n\n` +
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
    `export { ${appIdent}Plugin, ${appIdent}MigrationsDir } from "./plugin.ts";\n`,
  );

  await put(
    ".env.example",
    `# The owner role runs migrations and bypasses RLS.\n` +
      `DATABASE_URL=postgres://embody:embody@localhost:5432/embody\n` +
      `# Optional: the request-path role, which is SUBJECT to RLS.\n` +
      `# APP_DATABASE_URL=postgres://embody_app:embody_app@localhost:5432/embody\n` +
      `PORT=3000\n`,
  );

  await put(
    "README.md",
    `# ${name}\n\nAn [embody](https://github.com/nimrod4278/embody) app.\n\n` +
      `## Run it\n\n\`\`\`bash\nnpm install\ncp .env.example .env\nnpm run migrate\nnpm run dev\n\`\`\`\n\n` +
      `## Customize it\n\nEdit \`src/plugin.ts\`. Add another plugin with:\n\n` +
      `\`\`\`bash\nnpx embody new plugin <name>\n\`\`\`\n\n` +
      `Check your wiring at any time with \`npx embody doctor\`.\n\n` +
      `## What you own\n\nAll of it. embody arrives from npm, so there is no framework\n` +
      `checked in here to conflict with — upgrades are \`npm update\`, not a merge.\n`,
  );

  return written;
}

/** Next-steps text, kept next to the generator so the two cannot disagree. */
export function nextSteps(name: string, directory?: string): string {
  const where = directory ? basename(resolve(directory)) : name;
  return (
    `\nCreated ${where}/\n\n` +
    `  cd ${where}\n` +
    `  npm install\n` +
    `  cp .env.example .env      # point DATABASE_URL at your Postgres\n` +
    `  npm run migrate\n` +
    `  npm run dev\n\n` +
    `Your business logic goes in src/plugin.ts. Nothing else needs to change.\n`
  );
}
