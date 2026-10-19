import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppManifest } from "@embody/core";
import {
  apiKeyProvider,
  AuthChain,
  createGateway,
  FixedWindowRateLimiter,
  GatewayRegistry,
  hashApiKey,
  MemoryAuditLog,
  parseErrorEnvelope,
  sanitizeText,
} from "../src/index.js";

const manifest: AppManifest = {
  protocolVersion: 1,
  plugins: [{ id: "kanban", version: "1.0.0" }],
  entities: {},
  actions: {
    "kanban.ping": { generated: false, inputSchema: { type: "object", properties: {} } },
  },
  eventSubscriptions: [],
};

type HostReply = (init?: RequestInit) => Response;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(closers.splice(0).map((close) => close())));

function sse(...frames: readonly [event: string, data: string][]): Response {
  const body = frames.map(([event, data]) => `event: ${event}\ndata: ${data}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
const envelope = (code: string, message: string, details?: unknown) =>
  JSON.stringify({ error: { code, message, requestId: "host-request", details } });

function fixture(host: HostReply, limiter?: FixedWindowRateLimiter, scopes = ["kanban:*"]) {
  const registry = new GatewayRegistry({
    allowPrivateEndpoints: true,
    credentials: { kanban: "registration-secret" },
  });
  registry.register(
    {
      protocolVersion: 1,
      appId: "kanban",
      version: "1.0.0",
      endpoint: "http://127.0.0.1:8081",
      healthCheckUrl: "http://127.0.0.1:8081/health",
      manifest,
    },
    "registration-secret",
  );
  const audit = new MemoryAuditLog();
  const gateway = createGateway({
    registry,
    auth: new AuthChain([
      apiKeyProvider([
        {
          id: "key",
          hash: hashApiKey("api-key"),
          principal: {
            orgId: "org-1",
            actorId: "agent-1",
            actorType: "agent",
            roles: [],
            scopes,
          },
        },
      ]),
    ]),
    token: { issuer: "test", key: new TextEncoder().encode("12345678901234567890123456789012") },
    fetch: (_url, init) => Promise.resolve(host(init)),
    audit,
    ...(limiter ? { limiter } : {}),
  });
  closers.push(() => gateway.close());
  return { gateway, audit };
}

async function mcpCall(host: HostReply, limiter?: FixedWindowRateLimiter, scopes?: string[]) {
  const { gateway, audit } = fixture(host, limiter, scopes);
  const address = await gateway.listen({ port: 0, host: "127.0.0.1" });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: "Bearer api-key" } },
    }) as unknown as Transport,
  );
  closers.unshift(() => client.close());
  const call = (signal?: AbortSignal) =>
    client.callTool(
      { name: "kanban__kanban_ping", arguments: {} },
      undefined,
      signal ? { signal } : undefined,
    );
  return { call, audit, client };
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as readonly { type: string; text?: string }[];
  return content.map((item) => item.text ?? "").join("\n");
}

describe("error envelope parsing", () => {
  it("keeps known codes, messages and bounded validation details", () => {
    const parsed = parseErrorEnvelope(
      JSON.parse(
        envelope("VALIDATION_ERROR", "Input is invalid", [
          { path: ["data", "title"], message: "Required" },
          { path: "not-an-array", message: "dropped" },
        ]),
      ),
      "gateway-request",
    );
    expect(parsed).toEqual({
      code: "VALIDATION_ERROR",
      message: "Input is invalid",
      requestId: "gateway-request",
      details: [{ path: ["data", "title"], message: "Required" }],
    });
  });

  it("turns malformed or unknown envelopes into INTERNAL_ERROR without host text", () => {
    for (const value of [
      undefined,
      "boom",
      { error: "boom" },
      { error: { code: "SECRET_CODE", message: "stack trace here" } },
      { error: { code: "HOOK_VETO" } },
    ])
      expect(parseErrorEnvelope(value, "r")).toEqual({
        code: "INTERNAL_ERROR",
        message: "Tool execution failed",
        requestId: "r",
      });
  });

  it("strips control and bidi characters and bounds length", () => {
    expect(sanitizeText("a\u0000b\u001b[31mc‮d\nok")).toBe("ab[31mcd\nok");
    expect(sanitizeText("x".repeat(3000))).toHaveLength(2000);
  });
});

describe("MCP execution errors", () => {
  it("relays a hook veto message and code to the agent", async () => {
    const { call, audit } = await mcpCall(() =>
      sse(["error", envelope("HOOK_VETO", "Agents cannot mark a task done without a PR URL")]),
    );
    const result = await call();
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Agents cannot mark a task done without a PR URL");
    expect(result._meta?.["embody/errorCode"]).toBe("HOOK_VETO");
    expect(audit.records).toMatchObject([
      { surface: "mcp", outcome: "failure", errorCode: "HOOK_VETO", orgId: "org-1" },
    ]);
  });

  it("lists validation issues", async () => {
    const { call } = await mcpCall(() =>
      sse([
        "error",
        envelope("VALIDATION_ERROR", "Input is invalid", [
          { path: ["data", "title"], message: "Required" },
          { path: [], message: "Unknown key" },
        ]),
      ]),
    );
    expect(text(await call())).toBe(
      "Input is invalid\n- data.title: Required\n- (input): Unknown key",
    );
  });

  it("relays envelopes from non-streaming host failures", async () => {
    const { call } = await mcpCall(() =>
      Response.json(JSON.parse(envelope("NOT_FOUND", "Card not found")), { status: 404 }),
    );
    const result = await call();
    expect(text(result)).toBe("Card not found");
    expect(result._meta?.["embody/errorCode"]).toBe("NOT_FOUND");
  });

  it("hides unknown host errors behind a request ID", async () => {
    const { call } = await mcpCall(() => sse(["error", '{"error":{"code":"X","message":"leak"}}']));
    const result = await call();
    expect(text(result)).toMatch(/^Tool execution failed\nRequest ID: /);
    expect(text(result)).not.toContain("leak");
    expect(result._meta?.["embody/errorCode"]).toBe("INTERNAL_ERROR");
  });

  it("rejects oversized frames without relaying their content", async () => {
    const { call } = await mcpCall(() =>
      sse(["progress", JSON.stringify({ message: "x".repeat(70_000) })]),
    );
    const result = await call();
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain("xxxx");
  });

  it("audits successful MCP calls", async () => {
    const { call, audit } = await mcpCall(() => sse(["result", '{"ok":true}']));
    const result = await call();
    expect(result.isError).not.toBe(true);
    expect(audit.records).toMatchObject([
      { surface: "mcp", outcome: "success", appId: "kanban", target: "kanban.ping" },
    ]);
    expect(audit.records[0]?.errorCode).toBeUndefined();
  });

  it("audits cancelled MCP calls as cancelled", async () => {
    let started!: () => void;
    const hostStarted = new Promise<void>((resolve) => (started = resolve));
    const { call, audit, client } = await mcpCall((init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          started();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const controller = new AbortController();
    const pending = call(controller.signal);
    await hostStarted;
    controller.abort();
    await expect(pending).rejects.toThrow();
    // Stateless MCP cancellation crosses replicas; disconnect the HTTP transport to abort
    // the request-owned execution and publish its cancellation audit.
    await client.close();
    await expect.poll(() => audit.records[0]?.outcome).toBe("cancelled");
  });

  it("applies the rate limiter to MCP calls with a retry hint", async () => {
    const { call, audit } = await mcpCall(
      () => sse(["result", "{}"]),
      new FixedWindowRateLimiter(1, 60_000),
    );
    await call();
    const limited = await call();
    expect(limited.isError).toBe(true);
    expect(text(limited)).toMatch(/Retry after \d+ seconds\.$/);
    expect(limited._meta?.["embody/errorCode"]).toBe("RATE_LIMITED");
    expect(audit.records.map((record) => record.errorCode)).toEqual([undefined, "RATE_LIMITED"]);
  });
});

describe("M01 review regressions: error and audit parity", () => {
  it.each(["/api/execute/kanban/kanban.ping", "/api/execute/stream/kanban/kanban.ping"])(
    "normalizes raw host failure bodies at %s",
    async (url) => {
      for (const body of [
        "raw stack secret",
        envelope("UNKNOWN", "raw stack secret"),
        envelope("INTERNAL_ERROR", "raw stack secret"),
      ]) {
        const { gateway, audit } = fixture(() => new Response(body, { status: 500 }));
        const response = await gateway.inject({
          method: "POST",
          url,
          headers: { authorization: "Bearer api-key" },
          payload: {},
        });
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain("raw stack secret");
        expect(response.json()).toEqual({
          error: {
            code: "INTERNAL_ERROR",
            message: "Tool execution failed",
            requestId: response.headers["x-request-id"],
          },
        });
        expect(audit.records[0]).toMatchObject({ outcome: "failure", errorCode: "INTERNAL_ERROR" });
      }
    },
  );
  it.each([
    ["error", envelope("UNKNOWN", "raw stack secret"), "INTERNAL_ERROR"],
    ["error", "malformed raw stack secret", "INTERNAL_ERROR"],
    ["progress", JSON.stringify({ message: "x".repeat(70_000) }), "UNAVAILABLE"],
  ])("normalizes HTTP SSE %s frames with code %s", async (event, data, code) => {
    const { gateway, audit } = fixture(() => sse([event, data]));
    const response = await gateway.inject({
      method: "POST",
      url: "/api/execute/stream/kanban/kanban.ping",
      headers: { authorization: "Bearer api-key" },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: error");
    expect(response.body).toContain(code);
    expect(response.body).not.toContain("raw stack secret");
    expect(response.body).not.toContain("xxxx");
    expect(audit.records[0]).toMatchObject({ outcome: "failure", errorCode: code });
  });
  it("audits forbidden and unknown MCP calls without catalog disclosure or host calls", async () => {
    let calls = 0;
    const { call, client, audit } = await mcpCall(
      () => {
        calls++;
        return sse(["result", "{}"]);
      },
      undefined,
      [],
    );
    expect((await client.listTools()).tools).toEqual([]);
    const forbidden = await call();
    const unknown = await client.callTool({ name: "missing__tool", arguments: {} });
    for (const result of [forbidden, unknown]) {
      expect(result.isError).toBe(true);
      expect(text(result)).toBe("Tool not found or no longer authorized");
      expect(result._meta?.["embody/errorCode"]).toBe("FORBIDDEN");
      expect(result._meta?.["embody/requestId"]).toEqual(expect.any(String));
    }
    expect(calls).toBe(0);
    expect(audit.records).toHaveLength(2);
    expect(audit.records[0]).toMatchObject({
      surface: "mcp",
      appId: "kanban",
      target: "kanban.ping",
      outcome: "failure",
      errorCode: "FORBIDDEN",
    });
    expect(audit.records[1]).toMatchObject({
      surface: "mcp",
      outcome: "failure",
      errorCode: "FORBIDDEN",
    });
  });
  it("records a disconnected host stream as failure, not cancellation, across surfaces", async () => {
    const disconnected = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("raw transport secret"));
          },
        }),
      );
    const { gateway, audit } = fixture(disconnected);
    const response = await gateway.inject({
      method: "POST",
      url: "/api/execute/stream/kanban/kanban.ping",
      headers: { authorization: "Bearer api-key" },
      payload: {},
    });
    expect(response.body).toContain("INTERNAL_ERROR");
    expect(response.body).not.toContain("raw transport secret");
    expect(audit.records[0]).toMatchObject({ outcome: "failure", errorCode: "INTERNAL_ERROR" });
    const mcp = await mcpCall(disconnected);
    expect((await mcp.call())._meta?.["embody/errorCode"]).toBe("INTERNAL_ERROR");
    expect(mcp.audit.records[0]).toMatchObject({ outcome: "failure", errorCode: "INTERNAL_ERROR" });
  });
  it("fails closed and audits malformed successful JSON as failure", async () => {
    const { gateway, audit } = fixture(
      () => new Response("raw successful response secret", { status: 200 }),
    );
    const response = await gateway.inject({
      method: "POST",
      url: "/api/execute/kanban/kanban.ping",
      headers: { authorization: "Bearer api-key" },
      payload: {},
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("INTERNAL_ERROR");
    expect(response.body).not.toContain("raw successful response secret");
    expect(audit.records[0]).toMatchObject({ outcome: "failure", errorCode: "INTERNAL_ERROR" });
  });
  it("audits client closure during stream backpressure as cancellation without throwing", async () => {
    const { gateway, audit } = fixture(() =>
      sse(["progress", '{"message":"working"}'], ["result", "{}"]),
    );
    gateway.addHook("onRequest", (_request, reply, done) => {
      const write = reply.raw.write.bind(reply.raw);
      vi.spyOn(reply.raw, "write").mockImplementationOnce((chunk: string | Uint8Array) => {
        write(chunk);
        // Deterministic close after the backpressure waiter is installed, no timers.
        queueMicrotask(() => reply.raw.emit("close"));
        return false;
      });
      done();
    });
    await expect(
      gateway.inject({
        method: "POST",
        url: "/api/execute/stream/kanban/kanban.ping",
        headers: { authorization: "Bearer api-key" },
        payload: {},
      }),
    ).rejects.toThrow("response destroyed before completion");
    await expect.poll(() => audit.records.length).toBe(1);
    expect(audit.records[0]?.outcome).toBe("cancelled");
    expect(audit.records[0]?.errorCode).toBeUndefined();
  });
  it("returns an audited error when a stream ends without a terminal frame", async () => {
    const { gateway, audit } = fixture(() => sse(["progress", '{"message":"working"}']));
    const response = await gateway.inject({
      method: "POST",
      url: "/api/execute/stream/kanban/kanban.ping",
      headers: { authorization: "Bearer api-key" },
      payload: {},
    });
    expect(response.body).toContain("INTERNAL_ERROR");
    expect(audit.records[0]).toMatchObject({ outcome: "failure", errorCode: "INTERNAL_ERROR" });
  });
});

describe("HTTP execution audit and limits", () => {
  it("audits streaming calls and records the terminal error code", async () => {
    const { gateway, audit } = fixture(() => sse(["error", envelope("HOOK_VETO", "No")]));
    const response = await gateway.inject({
      method: "POST",
      url: "/api/execute/stream/kanban/kanban.ping",
      headers: { authorization: "Bearer api-key" },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: error");
    expect(audit.records).toMatchObject([
      { surface: "stream", outcome: "failure", errorCode: "HOOK_VETO" },
    ]);
  });

  it("rate-limits streaming calls with retry-after", async () => {
    const { gateway, audit } = fixture(
      () => sse(["result", "{}"]),
      new FixedWindowRateLimiter(1, 60_000),
    );
    const send = () =>
      gateway.inject({
        method: "POST",
        url: "/api/execute/stream/kanban/kanban.ping",
        headers: { authorization: "Bearer api-key" },
        payload: {},
      });
    expect((await send()).statusCode).toBe(200);
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toMatch(/^\d+$/);
    expect(audit.records.map((record) => record.outcome)).toEqual(["success", "failure"]);
  });

  it("audits JSON execution with surface and downstream error code", async () => {
    const { gateway, audit } = fixture(() =>
      Response.json(JSON.parse(envelope("HOOK_VETO", "No")), { status: 422 }),
    );
    const response = await gateway.inject({
      method: "POST",
      url: "/api/execute/kanban/kanban.ping",
      headers: { authorization: "Bearer api-key" },
      payload: {},
    });
    expect(response.statusCode).toBe(422);
    expect(audit.records).toMatchObject([
      { surface: "http", outcome: "failure", errorCode: "HOOK_VETO", actorId: "agent-1" },
    ]);
  });

  it.each([
    ["http", "/api/execute/kanban/kanban.ping"],
    ["stream", "/api/execute/stream/kanban/kanban.ping"],
    ["mcp", "/mcp"],
  ])("audits authentication failures on %s without contacting the host", async (surface, url) => {
    let hostCalls = 0;
    const { gateway, audit } = fixture(() => {
      hostCalls++;
      return Response.json({});
    });
    const response = await gateway.inject({
      method: "POST",
      url,
      headers: { authorization: "Bearer wrong" },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(hostCalls).toBe(0);
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      surface,
      outcome: "failure",
      errorCode: "UNAUTHENTICATED",
    });
    expect(audit.records[0]?.actorId).toBeUndefined();
  });

  it("audits authentication failures on JSON execution", async () => {
    const { gateway, audit } = fixture(() => Response.json({}));
    const response = await gateway.inject({
      method: "POST",
      url: "/api/execute/kanban/kanban.ping",
      headers: { authorization: "Bearer wrong" },
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(audit.records).toMatchObject([
      { surface: "http", outcome: "failure", errorCode: "UNAUTHENTICATED" },
    ]);
  });
});
