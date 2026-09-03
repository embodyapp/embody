#!/usr/bin/env node
import { createApp } from "./index.js";

const [name, ...flags] = process.argv.slice(2);
if (!name || flags.some((flag) => flag !== "--no-install" && flag !== "--allow-empty-directory")) {
  console.error("Usage: create-embody-app <name> [--no-install] [--allow-empty-directory]");
  process.exitCode = 2;
} else {
  try {
    const app = await createApp({
      name,
      noInstall: flags.includes("--no-install"),
      allowEmptyDirectory: flags.includes("--allow-empty-directory"),
    });
    console.log(`Created ${app.directory}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to create application");
    process.exitCode = 1;
  }
}
