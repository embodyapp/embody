#!/usr/bin/env node
import { runCli, watchDevServer } from "./index.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
if (process.argv[2] === "dev") {
  const watcher = watchDevServer(
    process.argv[3],
    (server) => {
      console.log(`Embody Host running on ${server.url}`);
      console.log(`Dev Inspector: ${server.url}/__inspector`);
      console.log("Registered Tools:");
      for (const target of server.targets) console.log(`  ${target}`);
    },
    (error) => console.error(error instanceof Error ? error.message : "Development reload failed"),
  );
  await new Promise<void>((resolve) =>
    controller.signal.addEventListener("abort", () => resolve()),
  );
  await watcher.close();
} else {
  const code = await runCli(process.argv.slice(2), { signal: controller.signal });
  process.exitCode = code;
}
