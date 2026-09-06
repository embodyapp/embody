import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface CreateAppOptions {
  readonly name: string;
  readonly destination?: string;
  /** Required to scaffold into an existing empty directory. Never overwrites files. */
  readonly allowEmptyDirectory?: boolean;
  /** Skip dependency installation for CI and offline callers. */
  readonly noInstall?: boolean;
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
function template(name: string): Readonly<Record<string, string>> {
  return {
    "package.json":
      JSON.stringify(
        {
          name,
          private: true,
          version: "0.1.0",
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
            "@embody/cli": "^0.0.0",
            "@embody/core": "^0.0.0",
            "@embody/host": "^0.0.0",
          },
          devDependencies: {
            "@embody/testing": "^0.0.0",
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
    "embody.config.ts": `import { definePlugin, z } from "@embody/core";\nimport { defineApp } from "@embody/host";\n\nexport default defineApp({\n  appId: "${name}",\n  version: "0.1.0",\n  plugins: [definePlugin({\n    id: "app",\n    version: "0.1.0",\n    actions: { ping: { input: z.object({}), handler: () => ({ ok: true }) } },\n  })],\n});\n`,
    "src/index.ts": `import config from "../embody.config.js";\nimport { createAppHost } from "@embody/host";\n\nconst runtime = await createAppHost(config);\nawait runtime.start();\nconsole.log(runtime.url);\nconst close = () => void runtime.stop();\nprocess.once("SIGINT", close);\nprocess.once("SIGTERM", close);\n`,
    "src/plugin.ts": `export { default } from "../embody.config.js";\n`,
    "src/plugin.test.ts": `import { expect, it } from "vitest";\nimport { createTestHarness } from "@embody/testing";\nimport config from "../embody.config.js";\n\nit("runs the starter action", async () => {\n  const harness = await createTestHarness({ plugins: config.plugins });\n  try { expect(await harness.call("app.ping", {})).toEqual({ ok: true }); } finally { await harness.close(); }\n});\n`,
    "README.md": `# ${name}\n\nRun \`pnpm install\`, \`pnpm test\`, then \`pnpm dev\`. The dev host is loopback-only.\n`,
    ".env.example": "# Add deployment credentials here; never commit .env\n",
    ".gitignore": "node_modules\ndist\n.embody\n.env\n",
    ".dockerignore": "node_modules\ndist\n.git\n.env\n",
    Dockerfile:
      'FROM node:24-alpine\nWORKDIR /app\nCOPY . .\nRUN corepack enable && pnpm install --frozen-lockfile && pnpm build\nEXPOSE 8080\nHEALTHCHECK CMD node -e "fetch(\'http://127.0.0.1:8080/health\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"\nCMD ["node", "dist/src/index.js"]\n',
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
  const files = template(options.name);
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
