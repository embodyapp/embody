#!/usr/bin/env tsx
/**
 * `embody-host` — the binary a service uses to run itself. It loads an
 * `embody.config.ts`, then starts the host.
 *
 *   embody-host [path-to-config] [--mode serve|migrate-only]
 *
 * Defaults: config path `./embody.config.ts`, mode `serve`. Environment (DATABASE_URL,
 * PORT) is read by startHost — nothing environment-specific belongs in the config file.
 */
import { createConsoleLogger } from "@embody/kernel";
import { startHost, type HostMode } from "./host.ts";
import { loadConfig } from "./runtime.ts";

function parseArgs(argv: string[]): { configPath: string; mode: HostMode } {
  let configPath = "./embody.config.ts";
  let mode: HostMode = "serve";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode") {
      const value = argv[++i];
      if (value !== "serve" && value !== "migrate-only") {
        throw new Error(`Invalid --mode "${value}" (expected serve|migrate-only)`);
      }
      mode = value;
    } else if (arg && !arg.startsWith("-")) {
      configPath = arg;
    }
  }
  return { configPath, mode };
}

async function main() {
  const logger = createConsoleLogger({ component: "embody-host" });
  const { configPath, mode } = parseArgs(process.argv.slice(2));

  const config = await loadConfig(configPath);
  const host = await startHost({ config, mode, logger });
  if (mode === "migrate-only") process.exit(0);

  const shutdown = async () => {
    await host.stop?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  createConsoleLogger({ component: "embody-host" }).error("host failed to start", {
    error: String(err),
  });
  process.exit(1);
});
