import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { Kernel, z } from "@embody/core";
import { PostgresStorage } from "../src/index.js";

const connectionString = process.env["EMBODY_POSTGRES_URL"];
if (process.env["EMBODY_POSTGRES_REQUIRED"] === "true" && !connectionString)
  throw new Error("Request-only PostgreSQL proof requires EMBODY_POSTGRES_URL");
const suite = connectionString ? describe : describe.skip;
const plugins = [
  { id: "app", version: "1.0.0", entities: { card: { schema: z.object({ title: z.string() }) } } },
];
const boot = async () => {
  const storage = new PostgresStorage({ connectionString, max: 5 }, { schemaMode: "verify" });
  const kernel = new Kernel({ plugins, storage, profile: "request-only" });
  await kernel.boot();
  return { kernel, storage };
};

suite("request-only PostgreSQL runtime", () => {
  it("20 concurrent read-only cold boots succeed under a runtime role with no DDL privileges", async () => {
    const pool = new Pool({ connectionString });
    try {
      await expect(pool.query("CREATE TABLE public.m08_forbidden (id integer)")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        pool.query("ALTER TABLE public.embody_entities ADD COLUMN m08_forbidden integer"),
      ).rejects.toThrow(/must be owner/);
      const runtimes = await Promise.all(Array.from({ length: 20 }, boot));
      await Promise.all(runtimes.map(({ kernel }) => kernel.stop()));
    } finally {
      await pool.end();
    }
  });

  it("replacement preserves CRUD data with zero retained outbox work", async () => {
    const principal = {
      orgId: `m08-${randomUUID()}`,
      actorId: "test",
      actorType: "human" as const,
      roles: [],
      scopes: ["app:*"],
    };
    let runtime = await boot();
    try {
      const created = (await runtime.kernel.execute(
        "app.card.create",
        { data: { title: "durable" } },
        { principal },
      )) as { id: string };
      await runtime.kernel.stop();
      runtime = await boot();
      expect(
        await runtime.kernel.execute("app.card.get", { id: created.id }, { principal }),
      ).toMatchObject({ data: { title: "durable" } });
      await runtime.kernel.execute(
        "app.card.update",
        { id: created.id, data: { title: "replacement" } },
        { principal },
      );
      await runtime.kernel.stop();
      runtime = await boot();
      expect(
        await runtime.kernel.execute("app.card.get", { id: created.id }, { principal }),
      ).toMatchObject({ data: { title: "replacement" } });
      await runtime.storage.transaction(principal.orgId, async (tx) => {
        expect(await tx.outbox.list()).toEqual([]);
      });
    } finally {
      await runtime.kernel.stop();
    }
  });

  it("process/scratch replacement after SIGKILL preserves committed data but no partial transaction", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "embody-m08-scratch-"));
    const orgId = `m08-kill-${randomUUID()}`;
    const source = `import { PostgresStorage } from './dist/index.js';
import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(join(scratch, "marker"))}, 'ephemeral');
const storage = new PostgresStorage({ connectionString: process.env.EMBODY_POSTGRES_URL });
await storage.transaction(${JSON.stringify(orgId)}, tx => tx.entities.create(${JSON.stringify(orgId)}, 'card', { data: { title: 'committed' } }));
await storage.transaction(${JSON.stringify(orgId)}, async tx => {
  await tx.entities.create(${JSON.stringify(orgId)}, 'card', { data: { title: 'uncommitted' } });
  process.stdout.write('READY\\n');
  await new Promise(() => {});
});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Child never entered transaction")), 5_000);
        child.stdout.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Child exited before ready: ${code}`));
        });
      });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      await rm(scratch, { recursive: true, force: true });
      const runtime = await boot();
      try {
        await runtime.storage.transaction(orgId, async (tx) => {
          expect(await tx.entities.list(orgId, "card", {})).toMatchObject([
            { data: { title: "committed" } },
          ]);
          expect(await tx.entities.list(orgId, "card", {})).toHaveLength(1);
          expect(await tx.outbox.list()).toEqual([]);
        });
      } finally {
        await runtime.kernel.stop();
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
