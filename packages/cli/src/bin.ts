#!/usr/bin/env node
import { runCli } from "./index.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
const code = await runCli(process.argv.slice(2), { signal: controller.signal });
process.exitCode = code;
