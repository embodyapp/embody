#!/usr/bin/env tsx
/** `embody` binary entry point. */
import { run } from "./index.ts";

run(process.argv).catch((err) => {
  process.stderr.write(`embody: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
