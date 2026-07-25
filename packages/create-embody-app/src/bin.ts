#!/usr/bin/env tsx
/**
 * `npm create embody-app <name> [--plugins crm,...] [--dir path]`
 */
import { createApp, nextSteps } from "./index.ts";

function parseArgs(argv: string[]): {
  name?: string;
  plugins?: string[];
  directory?: string;
} {
  let name: string | undefined;
  let plugins: string[] | undefined;
  let directory: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--plugins") {
      plugins = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--dir") {
      directory = argv[++i];
    } else if (arg && !arg.startsWith("-")) {
      name ??= arg;
    }
  }
  return { name, plugins, directory };
}

async function main(): Promise<void> {
  const { name, plugins, directory } = parseArgs(process.argv.slice(2));
  if (!name) {
    process.stderr.write(
      "Usage: npm create embody-app <name> [--plugins crm,...] [--dir <path>]\n",
    );
    process.exitCode = 1;
    return;
  }
  await createApp(name, { directory, plugins });
  process.stdout.write(nextSteps(name, directory));
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
