import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { definePlugin, z } from "@embody/core";
import { startDevServer } from "../src/dev.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

it("spawns the binary, coerces schema flags, separates progress and JSON result", async () => {
  let dispatched: unknown;
  const manifest = {
    protocolVersion: 1,
    plugins: [{ id: "cards", version: "1.0.0" }],
    entities: {},
    actions: {
      "cards.sendBatch": {
        generated: false,
        inputSchema: {
          type: "object",
          properties: { count: { type: "integer" }, dryRun: { type: "boolean" } },
          required: ["count"],
        },
      },
    },
    eventSubscriptions: [],
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/api/catalog") {
        response.setHeader("content-type", "application/json");
        response.setHeader("etag", '"catalog"');
        response.end(JSON.stringify([{ appId: "cards", manifest }]));
        return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      dispatched = JSON.parse(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'event: progress\ndata: {"percent":50,"message":"Halfway"}\n\nevent: result\ndata: {"ok":true}\n\n',
      );
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const cache = await mkdtemp(join(tmpdir(), "embody-cli-"));
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(cache, { recursive: true, force: true });
  });
  const child = spawn(
    process.execPath,
    ["dist/bin.js", "cards", "sendBatch", "--count", "2", "--dryRun", "--output", "json"],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        EMBODY_TOKEN: "secret",
        EMBODY_GATEWAY_URL: `http://127.0.0.1:${address.port}`,
        EMBODY_CACHE_DIR: cache,
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [code] = (await once(child, "exit")) as [number];
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ ok: true });
  expect(stderr).toContain("Halfway");
  expect(stderr).not.toContain("secret");
  expect(dispatched).toEqual({ count: 2, dryRun: true });
});

it("serves development-only inspector JSON through the production execution pipeline", async () => {
  const source = {
    id: "dev",
    version: "1.0.0",
    actions: {
      echo: {
        input: z.object({ message: z.string() }),
        handler: (input: { message: string }) => input,
      },
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "embody-dev-"));
  const server = await startDevServer({
    appId: "dev",
    plugins: [definePlugin(source)],
    port: 0,
    sqlitePath: join(directory, "dev.sqlite"),
  });
  try {
    expect((await server.host.app.inject("/__inspector")).json()).toEqual({
      endpoints: [
        "/__inspector/manifest",
        "/__inspector/execute",
        "/__inspector/outbox",
        "/__inspector/workflows/:id",
        "/__inspector/workflows/tick",
      ],
    });
    const result = await server.host.app.inject({
      method: "POST",
      url: "/__inspector/execute",
      payload: { target: "dev.echo", input: { message: "ok" } },
    });
    expect(result.json()).toEqual({ message: "ok" });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
