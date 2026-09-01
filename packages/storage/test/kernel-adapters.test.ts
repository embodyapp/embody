import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@embody/core";
import { describe, expect, it } from "vitest";

import { PostgresStorage, SqliteStorage } from "../src/index.js";

async function boots(storage: {
  ensureSchema(): Promise<void>;
  close(): Promise<void>;
}): Promise<void> {
  const kernel = new Kernel({
    storage,
    plugins: [
      { id: "source", version: "1.0.0", services: () => ({ answer: 42 }) },
      {
        id: "dependent",
        version: "1.0.0",
        dependsOn: ["source"],
        init: (context) => {
          expect(context.services.get<number>("source.answer")).toBe(42);
        },
      },
    ],
  });
  await kernel.boot();
  expect(kernel.state).toBe("ready");
  await kernel.stop();
}

describe("kernel storage adapter integration", () => {
  it("boots with a real SQLite adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "embody-kernel-"));
    await boots(new SqliteStorage({ filename: join(directory, "storage.sqlite") }));
  });

  const connectionString = process.env["EMBODY_POSTGRES_URL"];
  const postgres = connectionString === undefined ? it.skip : it;
  postgres("boots with a real PostgreSQL runtime-role adapter", async () => {
    const storage = new PostgresStorage({ connectionString });
    await boots({
      ensureSchema:
        process.env["EMBODY_POSTGRES_SKIP_SCHEMA"] === "true"
          ? () => Promise.resolve()
          : () => storage.ensureSchema(),
      close: () => storage.close(),
    });
  });
});
