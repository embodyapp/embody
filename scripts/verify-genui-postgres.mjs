import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Do not count environment-gated database skips as release evidence. Provision
// an isolated PostgreSQL 16+ database first, migrate it with a maintenance role,
// and supply a non-owner, NOSUPERUSER/NOBYPASSRLS runtime URL. Never print it.
assert.ok(
  process.env.EMBODY_POSTGRES_URL,
  "Set EMBODY_POSTGRES_URL to an isolated PostgreSQL 16+ test database; skipped tests do not pass this gate.",
);
const env = {
  ...process.env,
  P14_DATABASE_URL: process.env.EMBODY_POSTGRES_URL,
  P14_BROWSER: "1",
};
for (const args of [
  [
    "--filter",
    "@embody/storage",
    "exec",
    "vitest",
    "run",
    "test/postgres.test.ts",
    "test/kernel-adapters.test.ts",
  ],
  ["--filter", "@embody/example-kanban", "exec", "vitest", "run", "test/interactive-hosts.test.ts"],
])
  execFileSync("pnpm", args, { env, stdio: "inherit" });
console.log(
  "PostgreSQL storage/RLS and authenticated HTTP/CLI/MCP/Apps/Pi/browser journey passed.",
);
