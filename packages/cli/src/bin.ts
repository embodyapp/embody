#!/usr/bin/env node
import { runCli, startMcpBridge, watchDevServer } from "./index.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

async function waitForAbort(): Promise<void> {
  if (controller.signal.aborted) return;
  await new Promise<void>((resolve) =>
    controller.signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

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
  await waitForAbort();
  await watcher.close();
} else if (process.argv[2] === "mcp") {
  const args = process.argv.slice(3);
  if (args.length === 1 && args[0] === "--help") {
    console.error("Usage: embody mcp --url <endpoint> [--token <token>]");
  } else {
    let urlValue: string | undefined;
    let token = process.env["EMBODY_TOKEN"];
    let invalid = false;
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if ((flag !== "--url" && flag !== "--token") || !value || value.startsWith("--")) {
        invalid = true;
        break;
      }
      if (flag === "--url") urlValue = value;
      else token = value;
    }
    if (!urlValue || invalid) {
      console.error("Usage: embody mcp --url <endpoint> [--token <token>]");
      process.exitCode = 2;
    } else {
      try {
        const bridge = await startMcpBridge({
          url: new URL(urlValue),
          ...(token ? { token } : {}),
        });
        await waitForAbort();
        await bridge.close();
      } catch (error) {
        console.error(error instanceof Error ? error.message : "Unable to start MCP bridge");
        process.exitCode = 1;
      }
    }
  }
} else {
  const code = await runCli(process.argv.slice(2), { signal: controller.signal });
  process.exitCode = code;
}
