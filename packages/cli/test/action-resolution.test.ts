import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const id = { type: "string" };
const manifest = {
  protocolVersion: 1,
  plugins: [{ id: "orders", version: "1.0.0" }],
  entities: { "orders.card": { schema: object({ title: { type: "string" } }) } },
  actions: {
    "orders.card.get": { generated: true, inputSchema: object({ id }, ["id"]) },
    "orders.card.create": {
      generated: true,
      inputSchema: object({ data: object({ title: { type: "string" } }) }, ["data"]),
    },
    // Two workflows: neither may shadow the other's controls.
    "orders.refund.start": {
      generated: true,
      inputSchema: object({ input: object({}), idempotencyKey: id }, ["input", "idempotencyKey"]),
    },
    "orders.fulfil.start": {
      generated: true,
      inputSchema: object({ input: object({}), idempotencyKey: id }, ["input", "idempotencyKey"]),
    },
    "orders.fulfil.status": { generated: true, inputSchema: object({ id }, ["id"]) },
    "orders.fulfil.cancel": { generated: true, inputSchema: object({ id }, ["id"]) },
    "orders.sync": { generated: false, inputSchema: object({ full: { type: "boolean" } }) },
  },
  eventSubscriptions: [],
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function run(args: string[], stdin = "") {
  const cache = await mkdtemp(join(tmpdir(), "embody-cli-resolve-"));
  cleanups.push(() => rm(cache, { recursive: true, force: true }));
  const calls: { target: string; body: unknown }[] = [];
  const fake: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("/api/catalog"))
      return Promise.resolve(Response.json([{ appId: "orders", manifest }]));
    calls.push({
      target: decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown,
    });
    return Promise.resolve(
      new Response("event: result\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  io.stdin.end(stdin);
  let stderr = "";
  io.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await runCli([...args, "--output", "json"], {
    fetch: fake,
    io,
    env: {
      EMBODY_TOKEN: "token",
      EMBODY_GATEWAY_URL: "http://gateway.test",
      EMBODY_CACHE_DIR: cache,
      EMBODY_CONFIG: join(cache, "missing.json"),
    },
  });
  return { code, calls, stderr };
}

describe("CLI action resolution", () => {
  it.each([
    [["orders", "fulfil", "status", "wf-1"], "orders.fulfil.status", { id: "wf-1" }],
    [["orders", "fulfil", "cancel", "wf-1"], "orders.fulfil.cancel", { id: "wf-1" }],
    [["orders", "card", "get", "card-1"], "orders.card.get", { id: "card-1" }],
    [["orders", "card", "create", "--title", "x"], "orders.card.create", { data: { title: "x" } }],
    [["orders", "sync", "--full"], "orders.sync", { full: true }],
  ])("%j calls %s", async (args, target, body) => {
    const result = await run(args);
    expect(result.code, result.stderr).toBe(0);
    expect(result.calls).toEqual([{ target, body }]);
  });

  it("resolves a workflow's start by name, not the first start in the app", async () => {
    const body = { input: {}, idempotencyKey: "k" };
    const result = await run(["orders", "fulfil", "start", "--json"], JSON.stringify(body));
    expect(result.code, result.stderr).toBe(0);
    expect(result.calls).toEqual([{ target: "orders.fulfil.start", body }]);
  });

  it("does not treat a flag as the record ID", async () => {
    const result = await run(["orders", "card", "get", "--title", "x"]);
    expect(result.code).not.toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toMatch(/get requires an ID/);
  });
});
