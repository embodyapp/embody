import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;

export interface CreateAppOptions {
  readonly name: string;
  readonly destination?: string;
  /** Required to scaffold into an existing empty directory. Never overwrites files. */
  readonly allowEmptyDirectory?: boolean;
  /** Skip dependency installation for CI and offline callers. */
  readonly noInstall?: boolean;
  /** Hosted production starter; never silently falls back to local SQLite. */
  readonly profile?: "reference" | "request-only";
}
export interface CreatedApp {
  readonly directory: string;
  readonly files: readonly string[];
}

const namePattern = /^[a-z][a-z0-9-]*$/;
function assertName(name: string): void {
  if (!namePattern.test(name) || name.length > 63 || name === "." || name === "..")
    throw new Error("Project name must use lowercase letters, digits, and hyphens");
}
function template(
  name: string,
  profile: "reference" | "request-only",
): Readonly<Record<string, string>> {
  const hosted = profile === "request-only";
  return {
    "package.json":
      JSON.stringify(
        {
          name,
          private: true,
          version: "0.1.0",
          license: "UNLICENSED",
          type: "module",
          engines: { node: "^22.0.0 || ^24.0.0" },
          scripts: {
            dev: "embody dev",
            build: "tsc -p tsconfig.json",
            typecheck: "tsc -p tsconfig.json --noEmit",
            test: "vitest run",
            prestart: "pnpm build",
            start: "node dist/src/index.js",
          },
          dependencies: {
            "@embody/cli": `^${packageVersion}`,
            "@embody/core": `^${packageVersion}`,
            "@embody/host": `^${packageVersion}`,
          },
          devDependencies: {
            "@embody/testing": `^${packageVersion}`,
            "@types/node": "^22.20.1",
            typescript: "^5.9.3",
            vitest: "^4.0.18",
          },
        },
        null,
        2,
      ) + "\n",
    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            outDir: "dist",
            declaration: true,
            rootDir: ".",
          },
          include: ["src/**/*.ts", "embody.config.ts"],
        },
        null,
        2,
      ) + "\n",
    "embody.config.ts": `import { definePlugin, z } from "@embody/core";\nimport { defineApp } from "@embody/host";\n\nexport default defineApp({\n  appId: "${name}",\n  version: "0.1.0",\n  title: "${name}",\n  description: "Describe what this app does for people and agents.",\n  plugins: [definePlugin({\n    id: "app",\n    version: "0.1.0",\n    actions: {\n      ping: { effect: "read", input: z.object({}), handler: () => ({ ok: true }) },\n    },\n  })],\n});\n`,
    "src/index.ts": `import config from "../embody.config.js";\nimport { createAppHost } from "@embody/host";\n\nconst runtime = await createAppHost(config);\nawait runtime.start();\nconsole.log(runtime.url);\nconst close = () => void runtime.stop();\nprocess.once("SIGINT", close);\nprocess.once("SIGTERM", close);\n`,
    "src/plugin.ts": `export { default } from "../embody.config.js";\n`,
    "src/plugin.test.ts": `import { expect, it } from "vitest";\nimport { createTestHarness } from "@embody/testing";\nimport config from "../embody.config.js";\n\nit("runs the starter action", async () => {\n  const harness = await createTestHarness({ plugins: config.plugins });\n  try { expect(await harness.call("app.ping", {})).toEqual({ ok: true }); } finally { await harness.close(); }\n});\n`,
    "README.md": `# ${name}\n\nRun \`pnpm install\`, \`pnpm test\`, then \`pnpm dev\`. The dev host is loopback-only.\n\nDurable workflows can be added with \`defineWorkflow(inputSchema)({ version, steps })\`; start them through the generated \`<plugin>.<workflow>.start\` action and use idempotent external side effects.\n\nThis generated application belongs to its creator and is UNLICENSED by default. Choose and add your own license before distributing it.\n`,
    ".env.example": hosted
      ? "NODE_ENV=production\nEMBODY_HOST_PROFILE=hosted\nDATABASE_URL=postgresql://runtime@db/app\nEMBODY_WORKSPACE_ID=ws_replace123\nGATEWAY_JWT_ISSUER=https://gateway.example\nGATEWAY_JWKS_URL=https://gateway.example/.well-known/jwks.json\n# Pre-migrate separately. Never pass migration credentials to this process.\n"
      : "# Add deployment credentials here; never commit .env\n",
    ".gitignore": "node_modules\ndist\n.embody\n.env\n",
    ".dockerignore": "node_modules\ndist\n.git\n.env\n",
    Dockerfile:
      'FROM node:24-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install && npm run build && chown -R node:node /app\nUSER node\nEXPOSE 8080\nHEALTHCHECK CMD node -e "fetch(\'http://127.0.0.1:8080/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"\nCMD ["node", "dist/src/index.js"]\n',
  };
}

/** Creates a deterministic app layout without evaluating project-controlled strings in a shell. */
export async function createApp(options: CreateAppOptions): Promise<CreatedApp> {
  assertName(options.name);
  const directory = resolve(options.destination ?? options.name);
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  let entries: readonly string[] | undefined;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (entries !== undefined && (entries.length > 0 || !options.allowEmptyDirectory))
    throw new Error("Destination must not exist or must be explicitly allowed and empty");
  const profile = options.profile ?? "reference";
  if (profile !== "reference" && profile !== "request-only")
    throw new Error("Unsupported scaffold profile");
  const files = { ...template(options.name, profile) };
  if (profile === "request-only") {
    files["embody.config.ts"] = files["embody.config.ts"]!.replace(
      "    actions: {",
      "    entities: { card: { schema: z.object({ title: z.string().min(1) }) } },\n    actions: {",
    );
    files["src/index.ts"] = files["src/index.ts"]!.replace(
      "const runtime = await createAppHost(config);",
      'if (process.env.EMBODY_HOST_PROFILE !== "hosted") throw new Error("This starter requires EMBODY_HOST_PROFILE=hosted and pre-migrated PostgreSQL");\nconst runtime = await createAppHost(config);',
    );
    files["README.md"] =
      `# ${options.name}\n\nHosted request-only starter (Node 22/24). Run pnpm install, pnpm test and pnpm build. Supply the settings in .env.example through your deployment environment; pnpm start does not load that file. Do not use pnpm dev as a production verifier.\n\nPre-migrate PostgreSQL with a separate maintenance identity. Runtime credentials must have no DDL privileges. No registration, heartbeat, workflow, event subscription, init or service factory callbacks. Generated CRUD writes and synchronous hooks remain atomic, but notifications have zero retention and no delivery guarantee. Custom event publishing fails. Start on a fresh database; drain legacy outbox work in reference mode before switching. Use /tmp only for disposable scratch; PostgreSQL is the only durable request state.\n\nArbitrary module timers, filesystem writes and external side effects are not statically sandboxed. Action cancellation is cooperative; external effects need idempotency. See docs/mvp/RUNTIME.md in the framework repository for the contract and qualification limits.\n\nThis application belongs to its creator and is UNLICENSED by default.\n`;
  }
  const created: string[] = [];
  try {
    await mkdir(directory, { recursive: true });
    for (const [relative, content] of Object.entries(files)) {
      const path = resolve(directory, relative);
      if (!path.startsWith(`${directory}/`)) throw new Error("Invalid template path");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, { flag: "wx" });
      created.push(relative);
    }
  } catch (error) {
    await Promise.all(created.map((file) => rm(resolve(directory, file), { force: true })));
    throw error;
  }
  void options.noInstall;
  return { directory, files: created };
}

export async function destinationExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
