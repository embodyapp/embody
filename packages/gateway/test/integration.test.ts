import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, HookVetoError, Kernel, z, type Principal } from "@embody/core";
import { createHost } from "@embody/host";
import {
  apiKeyProvider,
  AuthChain,
  createGateway,
  FixedWindowRateLimiter,
  GatewayRegistry,
  hashApiKey,
  MemoryAuditLog,
} from "../src/index.js";

// A real kernel/HTTP host and official MCP client exercise the combined P15-01/02/06 wire path.
// This fixture has no entities; PostgreSQL isolation is a separate, mandatory M03/M04 gate.
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function fixture(limit = 100) {
  const seen: Principal[] = [];
  const kernel = new Kernel({
    app: { title: "Review app", instructions: "Supply approval for an agent write." },
    storage: {
      ensureSchema: () => Promise.resolve(),
      close: () => Promise.resolve(),
      transaction: async <T>(_org: string, callback: (tx: never) => Promise<T>) =>
        callback({} as never),
    },
    plugins: [
      definePlugin({
        id: "review",
        version: "1.0.0",
        actions: {
          save: {
            title: "Save reviewed value",
            effect: "write",
            input: z.object({ value: z.string().min(1), approved: z.boolean().default(false) }),
            output: z.object({ value: z.string() }),
            handler: (input: { value: string; approved: boolean }, context) => {
              seen.push(context.principal);
              if (context.principal.actorType === "agent" && !input.approved)
                throw new HookVetoError("Agents need approval");
              return { value: input.value };
            },
          },
        },
      }),
    ],
  });
  await kernel.boot();
  closers.push(() => kernel.stop());
  const key = new TextEncoder().encode("integration-key-at-least-32-bytes-long");
  const host = createHost({
    kernel,
    appId: "review",
    version: "1.0.0",
    environment: "production",
    verifier: {
      id: "signed-integration-principal",
      async verify(token) {
        const { payload } = await jwtVerify(token, key, {
          issuer: "integration",
          audience: "review",
          algorithms: ["HS256"],
        });
        return payload as unknown as Principal;
      },
    },
  });
  await host.start();
  closers.push(() => host.stop());
  const endpoint = await host.app.listen({ port: 0, host: "127.0.0.1" });
  const registry = new GatewayRegistry({
    allowPrivateEndpoints: true,
    credentials: { review: "registration" },
  });
  registry.register(
    {
      protocolVersion: 1,
      appId: "review",
      version: "1.0.0",
      endpoint,
      healthCheckUrl: `${endpoint}/health`,
      manifest: kernel.manifest,
    },
    "registration",
  );
  const audit = new MemoryAuditLog();
  const gateway = createGateway({
    registry,
    auth: new AuthChain([
      apiKeyProvider([
        {
          id: "human",
          hash: hashApiKey("human-key"),
          principal: {
            orgId: "workspace",
            actorId: "alice",
            actorType: "human",
            roles: [],
            scopes: ["review:*"],
            metadata: { client: "verified-client" },
          },
        },
      ]),
    ]),
    token: { issuer: "integration", key },
    limiter: new FixedWindowRateLimiter(limit, 60_000),
    audit,
  });
  const address = await gateway.listen({ port: 0, host: "127.0.0.1" });
  closers.push(() => gateway.close());
  const client = new Client({ name: "untrusted-client-label", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: "Bearer human-key" } },
    }) as unknown as Transport,
  );
  closers.push(() => client.close());
  const execute = (input: unknown, stream = false) =>
    gateway.inject({
      method: "POST",
      url: `/api/execute/${stream ? "stream/" : ""}review/review.save`,
      payload: JSON.stringify(input),
      // Injected string bodies require the same content type as a real CLI request.
      headers: { authorization: "Bearer human-key", "content-type": "application/json" },
    });
  return { kernel, gateway, client, audit, seen, execute };
}

describe("combined gateway integration", () => {
  it("preserves metadata and delegated guardrails through signed tokens to a real host", async () => {
    const { gateway, client, audit, seen, execute } = await fixture();
    const catalog = await gateway.inject({
      url: "/api/catalog",
      headers: { authorization: "Bearer human-key" },
    });
    expect(catalog.body).toContain("Review app");
    expect(catalog.body).toContain("Save reviewed value");
    expect(catalog.body).toContain('"effect":"write"');
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      "review__review_save",
    );

    expect((await execute({ value: "human" })).statusCode).toBe(200);
    const veto = await client.callTool({
      name: "review__review_save",
      arguments: { value: "agent" },
    });
    expect(veto.isError).toBe(true);
    expect(veto._meta?.["embody/errorCode"]).toBe("HOOK_VETO");
    expect(JSON.stringify(veto.content)).toContain("Agents need approval");
    const saved = await client.callTool({
      name: "review__review_save",
      arguments: { value: "approved", approved: true },
    });
    expect(saved.isError).not.toBe(true);
    expect(seen[0]?.actorType).toBe("human");
    expect(seen[1]).toMatchObject({
      actorType: "agent",
      actorId: "verified-client:alice",
      delegation: { subjectId: "alice", subjectType: "human", client: "verified-client" },
    });
    expect(audit.records).toHaveLength(3);
    expect(
      audit.records.map(({ surface, outcome, errorCode }) => ({ surface, outcome, errorCode })),
    ).toEqual([
      { surface: "http", outcome: "success", errorCode: undefined },
      { surface: "mcp", outcome: "failure", errorCode: "HOOK_VETO" },
      { surface: "mcp", outcome: "success", errorCode: undefined },
    ]);
  });

  it("retains validation errors and exactly one failure audit on each execution surface", async () => {
    const { client, audit, execute, seen } = await fixture();
    const json = await execute({});
    expect(json.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    const stream = await execute({}, true);
    expect(stream.body).toContain('"code":"VALIDATION_ERROR"');
    const mcp = await client.callTool({ name: "review__review_save", arguments: {} });
    expect(mcp._meta?.["embody/errorCode"]).toBe("VALIDATION_ERROR");
    expect(audit.records.map(({ surface, errorCode }) => ({ surface, errorCode }))).toEqual([
      { surface: "http", errorCode: "VALIDATION_ERROR" },
      { surface: "stream", errorCode: "VALIDATION_ERROR" },
      { surface: "mcp", errorCode: "VALIDATION_ERROR" },
    ]);
    expect(seen).toEqual([]);
  });

  it("shares HTTP/stream limits and applies MCP limits before host execution", async () => {
    const { client, audit, execute, seen } = await fixture(1);
    expect((await execute({ value: "first" })).statusCode).toBe(200);
    expect((await execute({ value: "blocked" }, true)).statusCode).toBe(429);
    const call = () =>
      client.callTool({
        name: "review__review_save",
        arguments: { value: "agent", approved: true },
      });
    expect((await call()).isError).not.toBe(true);
    expect((await call())._meta?.["embody/errorCode"]).toBe("RATE_LIMITED");
    expect(seen).toHaveLength(2);
    expect(audit.records).toHaveLength(4);
    expect(
      audit.records.filter((row) => row.errorCode === "RATE_LIMITED").map((row) => row.surface),
    ).toEqual(["stream", "mcp"]);
  });
});
