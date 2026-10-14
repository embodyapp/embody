import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { definePlugin, defineWorkflow, Kernel, z, type Principal } from "@embody/core";
import { createHost, WorkflowWorker } from "@embody/host";
import { PostgresStorage } from "@embody/storage";
import {
  apiKeyProvider,
  AuthChain,
  createGateway,
  GatewayRegistry,
  hashApiKey,
  MemoryAuditLog,
} from "../src/index.js";

// M19.d / P11-03: the packed CLI binary and the official MCP client drive generated workflow
// controls through the real gateway to a real host on PostgreSQL under the runtime role.
const connectionString = process.env["EMBODY_POSTGRES_URL"];
if (process.env["EMBODY_POSTGRES_REQUIRED"] === "true" && !connectionString)
  throw new Error("M19 workflow journey requires EMBODY_POSTGRES_URL");
const suite = connectionString ? describe : describe.skip;
const cliBin = fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));

interface Snapshot {
  readonly id: string;
  readonly status: string;
  readonly output?: unknown;
}

suite("workflow journey through gateway, packed CLI and MCP", () => {
  const closers: Array<() => Promise<void>> = [];
  const orgId = `m19-journey-${randomUUID()}`;
  let shipments = 0;
  let allowFlaky = false;
  let gatewayUrl = "";
  let worker: WorkflowWorker;
  let mcp: Client;
  let cache = "";

  beforeAll(async () => {
    const fulfil = defineWorkflow(z.object({ orderId: z.string() }))({
      version: "1.0.0",
      resultStep: "ship",
      output: z.object({ shipped: z.string() }),
      steps: {
        reserve: { handler: ({ input }) => ({ reservation: `r-${input.orderId}` }) },
        ship: {
          dependsOn: ["reserve"],
          handler: ({ input }) => {
            shipments++;
            return { shipped: input.orderId };
          },
        },
      },
    });
    const flaky = defineWorkflow(z.object({}))({
      version: "1.0.0",
      steps: {
        call: {
          handler: () => {
            if (!allowFlaky) throw new Error("provider unavailable");
            return { ok: true };
          },
        },
      },
    });
    const storage = new PostgresStorage({ connectionString, max: 5 }, { schemaMode: "verify" });
    const kernel = new Kernel({
      storage,
      plugins: [definePlugin({ id: "orders", version: "1.0.0", workflows: { fulfil, flaky } })],
    });
    await kernel.boot();
    closers.unshift(() => kernel.stop());
    worker = new WorkflowWorker({ storage, kernel, cancelPollMs: 0 });
    const key = new TextEncoder().encode("m19-journey-key-at-least-32-bytes-long");
    const host = createHost({
      kernel,
      appId: "orders",
      version: "1.0.0",
      environment: "production",
      verifier: {
        id: "m19-journey",
        async verify(token) {
          const { payload } = await jwtVerify(token, key, {
            issuer: "m19",
            audience: "orders",
            algorithms: ["HS256"],
          });
          return payload as unknown as Principal;
        },
      },
    });
    await host.start();
    closers.unshift(() => host.stop());
    const endpoint = await host.app.listen({ port: 0, host: "127.0.0.1" });
    const registry = new GatewayRegistry({
      allowPrivateEndpoints: true,
      credentials: { orders: "registration" },
    });
    registry.register(
      {
        protocolVersion: 1,
        appId: "orders",
        version: "1.0.0",
        endpoint,
        healthCheckUrl: `${endpoint}/health`,
        manifest: kernel.manifest,
      },
      "registration",
    );
    const person = (actorId: string, org: string, scopes: string[]): Principal => ({
      orgId: org,
      actorId,
      actorType: "human",
      roles: [],
      scopes,
    });
    const gateway = createGateway({
      registry,
      auth: new AuthChain([
        apiKeyProvider([
          {
            id: "owner",
            hash: hashApiKey("owner-key"),
            principal: person("alice", orgId, ["orders:*"]),
          },
          {
            id: "stranger",
            hash: hashApiKey("stranger-key"),
            principal: person("bob", `${orgId}-other`, ["orders:*"]),
          },
          {
            id: "reader",
            hash: hashApiKey("reader-key"),
            principal: person("carol", orgId, ["other:*"]),
          },
        ]),
      ]),
      token: { issuer: "m19", key },
      audit: new MemoryAuditLog(),
    });
    gatewayUrl = await gateway.listen({ port: 0, host: "127.0.0.1" });
    closers.unshift(() => gateway.close());
    mcp = new Client({ name: "m19-journey", version: "1" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`), {
        requestInit: { headers: { authorization: "Bearer owner-key" } },
      }) as unknown as Transport,
    );
    closers.unshift(() => mcp.close());
    cache = await mkdtemp(join(tmpdir(), "embody-m19-cli-"));
    closers.push(() => rm(cache, { recursive: true, force: true }));
  });
  afterAll(async () => {
    for (const close of closers.splice(0)) await close();
  });

  const cli = async (args: string[], token = "owner-key", stdin?: string) => {
    const child = spawn(process.execPath, [cliBin, ...args, "--output", "json"], {
      env: {
        ...process.env,
        EMBODY_TOKEN: token,
        EMBODY_GATEWAY_URL: gatewayUrl,
        EMBODY_CACHE_DIR: cache,
        EMBODY_CONFIG: join(cache, "missing-config.json"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.end(stdin ?? "");
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    const last = stdout.trim().split("\n").at(-1);
    return { code, stderr, result: last ? (JSON.parse(last) as Snapshot) : undefined };
  };
  const tool = async (name: string, args: Record<string, unknown>) => {
    const tools = (await mcp.listTools()).tools.map((item) => item.name);
    const match = tools.find((candidate) => candidate.endsWith(name));
    if (!match) throw new Error(`MCP tool ${name} not listed: ${tools.join(", ")}`);
    const result = await mcp.callTool({ name: match, arguments: args });
    return result as { isError?: boolean; structuredContent?: Snapshot };
  };
  const drain = async () => {
    for (let tick = 0; tick < 4; tick++) await worker.tick();
  };

  it("CLI starts a workflow, reads its completed status, and starts are idempotent", async () => {
    const body = JSON.stringify({ input: { orderId: "42" }, idempotencyKey: `order-${orgId}` });
    const started = await cli(["orders", "fulfil", "start", "--json"], "owner-key", body);
    expect(started.code, started.stderr).toBe(0);
    expect(["pending", "running"]).toContain(started.result?.status);
    const again = await cli(["orders", "fulfil", "start", "--json"], "owner-key", body);
    expect(again.result?.id).toBe(started.result?.id);
    await drain();
    const status = await cli(["orders", "fulfil", "status", started.result!.id]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.result).toMatchObject({ status: "completed", output: { shipped: "42" } });
    expect(shipments).toBe(1);
  });

  it("MCP starts and cancels a workflow before it runs; CLI sees the cancellation", async () => {
    const started = await tool("orders_fulfil_start", {
      input: { orderId: "43" },
      idempotencyKey: `cancel-${orgId}`,
    });
    expect(started.isError).not.toBe(true);
    const id = started.structuredContent!.id;
    const cancelled = await tool("orders_fulfil_cancel", { id });
    expect(cancelled.structuredContent?.status).toBe("cancelled");
    await drain();
    expect((await cli(["orders", "fulfil", "status", id])).result?.status).toBe("cancelled");
    expect(shipments).toBe(1);
  });

  it("CLI retries a failed workflow and MCP observes it complete", async () => {
    const started = await cli(
      ["orders", "flaky", "start", "--json"],
      "owner-key",
      JSON.stringify({ input: {}, idempotencyKey: `flaky-${orgId}` }),
    );
    const id = started.result!.id;
    await drain();
    expect((await tool("orders_flaky_status", { id })).structuredContent?.status).toBe("failed");
    allowFlaky = true;
    const retried = await cli(["orders", "flaky", "retry", id]);
    expect(retried.code, retried.stderr).toBe(0);
    expect(retried.result?.status).toBe("running");
    await drain();
    expect((await tool("orders_flaky_status", { id })).structuredContent?.status).toBe("completed");
  });

  it("denies unauthorized and cross-workspace workflow control", async () => {
    const owned = await cli(
      ["orders", "fulfil", "start", "--json"],
      "owner-key",
      JSON.stringify({ input: { orderId: "44" }, idempotencyKey: `deny-${orgId}` }),
    );
    const id = owned.result!.id;
    const forbidden = await cli(["orders", "fulfil", "cancel", id], "reader-key");
    expect(forbidden.code).not.toBe(0);
    expect(forbidden.result).toBeUndefined();
    const foreign = await cli(["orders", "fulfil", "cancel", id], "stranger-key");
    expect(foreign.code).not.toBe(0);
    expect(foreign.result).toBeUndefined();
    expect((await cli(["orders", "fulfil", "status", id])).result?.status).not.toBe("cancelled");
  });
});
