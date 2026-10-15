#!/usr/bin/env node
import { createApp } from "./index.js";

const [name, ...flags] = process.argv.slice(2);
if (
  !name ||
  flags.some(
    (flag) =>
      flag !== "--no-install" &&
      flag !== "--allow-empty-directory" &&
      flag !== "--request-only" &&
      flag !== "--durable",
  ) ||
  (flags.includes("--request-only") && flags.includes("--durable"))
) {
  console.error(
    "Usage: create-embody-app <name> [--no-install] [--allow-empty-directory] [--request-only | --durable]",
  );
  process.exitCode = 2;
} else {
  try {
    const app = await createApp({
      name,
      profile: flags.includes("--durable")
        ? "durable"
        : flags.includes("--request-only")
          ? "request-only"
          : "reference",
      noInstall: flags.includes("--no-install"),
      allowEmptyDirectory: flags.includes("--allow-empty-directory"),
    });
    console.log(`Created ${app.directory}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to create application");
    process.exitCode = 1;
  }
}
