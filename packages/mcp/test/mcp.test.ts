import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AppManifest } from "@embody/core";
import {
  createMcpCatalog,
  McpHttpHandler,
  mcpErrorResult,
  mcpResult,
  mcpTargetName,
  type McpHttpOptions,
} from "../src/index.js";

const manifest: AppManifest = {
  protocolVersion: 1,
  plugins: [{ id: "cards", version: "1.0.0" }],
  entities: {},
  actions: {
    "cards.sendBatch": {
      description: "Send cards",
      inputSchema: { type: "object", properties: { count: { type: "number" } } },
      generated: false,
    },
  },
  eventSubscriptions: [],
};
const closers: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(closers.splice(0).map((close) => close())));

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.method !== "POST") return undefined;
  let value = "";
  for await (const chunk of request) value += String(chunk);
  return value ? JSON.parse(value) : undefined;
}

async function fixture(
  execute?: McpHttpOptions<string>["execute"],
  stateless = false,
  disconnectBeforeDispatch = false,
  replaceEachRequest = false,
) {
  const catalog = createMcpCatalog([{ appId: "kanban", manifest }]);
  const createHandler = () =>
    new McpHttpHandler<string>({
      ...(stateless ? { sessionMode: "stateless" as const } : {}),
      catalog: () => catalog,
      execute:
        execute ??
        async function* (_context, _entry, input) {
          await Promise.resolve();
          yield { type: "progress", update: { percent: 50, message: "Halfway" } };
          yield { type: "result", value: input };
        },
    });
  const handlers = Array.from({ length: stateless ? 2 : 1 }, createHandler);
  let next = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const index = next++ % handlers.length;
      const parsed = await body(request);
      if (replaceEachRequest) {
        await handlers[index]!.close();
        handlers[index] = createHandler();
      }
      if (disconnectBeforeDispatch) response.destroy();
      await handlers[index]!.handle({
        request,
        response,
        body: parsed,
        identity: String(request.headers.authorization),
        context: stateless ? `replica-${index}` : "principal",
      });
      if (disconnectBeforeDispatch)
        expect(
          (handlers[index] as unknown as { activeStateless: Map<unknown, unknown> }).activeStateless
            .size,
        ).toBe(0);
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  closers.push(async () => {
    await Promise.all(handlers.map((handler) => handler.close()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return Object.assign(url, {
    shutdown: () => Promise.all(handlers.map((handler) => handler.close())),
    activeRequests: () =>
      handlers.reduce(
        (total, handler) =>
          total +
          (handler as unknown as { activeStateless: Map<unknown, unknown> }).activeStateless.size,
        0,
      ),
  });
}

describe("MCP results", () => {
  it("preserves text and adds structured content only for object results", () => {
    expect(mcpResult({ count: 2 })).toEqual({
      content: [{ type: "text", text: '{"count":2}' }],
      structuredContent: { count: 2 },
    });
    for (const value of [null, [1, 2], "plain", 42, false]) {
      expect(mcpResult(value)).toEqual({
        content: [{ type: "text", text: JSON.stringify(value) }],
      });
    }
  });
});

describe("MCP error results", () => {
  it("formats message, issues, retry hint and metadata", () => {
    expect(
      mcpErrorResult({
        message: "Input is invalid",
        code: "VALIDATION_ERROR",
        requestId: "r-1",
        details: [{ path: ["data", "title"], message: "Required" }],
        retryAfterSeconds: 3,
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: "Input is invalid\n- data.title: Required\nRetry after 3 seconds.",
        },
      ],
      isError: true,
      _meta: { "embody/errorCode": "VALIDATION_ERROR", "embody/requestId": "r-1" },
    });
  });

  it("adds the request ID only for internal errors and omits empty metadata", () => {
    expect(
      mcpErrorResult({ message: "Tool execution failed", code: "INTERNAL_ERROR", requestId: "r" })
        .content,
    ).toEqual([{ type: "text", text: "Tool execution failed\nRequest ID: r" }]);
    expect(mcpErrorResult({ message: "Cancelled" })).toEqual({
      content: [{ type: "text", text: "Cancelled" }],
      isError: true,
    });
  });
});

describe("MCP surface", () => {
  it("does not open an idle stream for stateless GET or DELETE", async () => {
    const url = await fixture(undefined, true);
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(url, { method, headers: { accept: "text/event-stream" } });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(await response.text()).toBe("");
    }
  });
  it("does not dispatch or retain a server after a pre-dispatch disconnect", async () => {
    let executions = 0;
    const url = await fixture(
      async function* () {
        executions++;
        await Promise.resolve();
        yield { type: "result", value: null };
      },
      true,
      true,
    );
    await expect(
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "kanban__cards_send_batch", arguments: {} },
        }),
      }),
    ).rejects.toThrow();
    expect(executions).toBe(0);
  });

  it.each([false, true])(
    "routes stateless official-client requests across independent replicas (replacement=%s)",
    async (replacement) => {
      const replicas = new Set<string>();
      const url = await fixture(
        async function* (context, _entry, input) {
          replicas.add(context);
          await Promise.resolve();
          yield { type: "result", value: input };
        },
        true,
        false,
        replacement,
      );
      const transport = new StreamableHTTPClientTransport(url);
      const client = new Client({ name: "round-robin", version: "1.0.0" });
      try {
        await client.connect(transport as unknown as Transport);
        expect(transport.sessionId).toBeUndefined();
        expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
        expect((await client.listTools()).tools[0]?.name).toBe("kanban__cards_send_batch");
        for (let count = 0; count < 4; count++) {
          const result = await client.callTool({
            name: "kanban__cards_send_batch",
            arguments: { count },
          });
          expect(result.isError).not.toBe(true);
          expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ count }) }]);
          expect(result.structuredContent).toEqual({ count });
        }
        expect([...replicas].sort()).toEqual(["replica-0", "replica-1"]);
      } finally {
        await client.close();
      }
    },
  );

  it("preserves ordered progress without prior initialization on the execution replica", async () => {
    const url = await fixture(
      async function* () {
        await Promise.resolve();
        for (const percent of [10, 50, 100]) {
          yield { type: "progress", update: { percent, message: `Progress ${percent}` } };
        }
        yield { type: "result", value: { done: true } };
      },
      true,
      false,
      true,
    );
    const client = new Client({ name: "progress", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url) as unknown as Transport);
      const progress: number[] = [];
      const result = await client.callTool(
        { name: "kanban__cards_send_batch", arguments: {} },
        undefined,
        { onprogress: (update) => progress.push(update.progress) },
      );
      expect(progress).toEqual([10, 50, 100]);
      expect(result.structuredContent).toEqual({ done: true });
      await expect.poll(url.activeRequests).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("aborts in-flight execution and releases request servers on gateway shutdown", async () => {
    let markStarted = () => {};
    let markCancelled = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const url = await fixture(async function* (_context, _entry, _input, signal) {
      markStarted();
      if (!signal.aborted)
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      if (signal.aborted) markCancelled();
      yield { type: "result", value: null };
    }, true);
    const client = new Client({ name: "shutdown", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url) as unknown as Transport);
      const call = client.callTool({ name: "kanban__cards_send_batch", arguments: {} });
      const rejected = expect(call).rejects.toThrow();
      await started;
      expect(url.activeRequests()).toBe(1);
      await url.shutdown();
      await cancelled;
      await rejected;
      expect(url.activeRequests()).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("fences new requests after shutdown and closes idempotently", async () => {
    let executions = 0;
    const url = await fixture(async function* () {
      executions++;
      await Promise.resolve();
      yield { type: "result", value: null };
    }, true);
    await Promise.all([url.shutdown(), url.shutdown()]);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "kanban__cards_send_batch",
          arguments: {},
        },
      }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("shutting down");
    expect(executions).toBe(0);
    expect(url.activeRequests()).toBe(0);
  });

  it.each(["resources/list", "resources/read", "prompts/list", "prompts/get"])(
    "does not enable unsupported hosted capability %s without initialization",
    async (method) => {
      const url = await fixture(undefined, true);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"code":-32601');
      await expect.poll(url.activeRequests).toBe(0);
    },
  );

  it("normalizes camel case and rejects collisions", () => {
    expect(mcpTargetName("cards.sendBatchURL")).toBe("cards_send_batch_url");
    expect(createMcpCatalog([{ appId: "one", manifest }])[0]?.tool.name).toBe(
      "one__cards_send_batch",
    );
    expect(createMcpCatalog([{ appId: "one", manifest }], "one")[0]?.tool.name).toBe(
      "cards_send_batch",
    );
    expect(() =>
      createMcpCatalog(
        [
          {
            appId: "one",
            manifest: {
              ...manifest,
              actions: {
                "cards.sendBatch": manifest.actions["cards.sendBatch"]!,
                "cards.send_batch": manifest.actions["cards.sendBatch"]!,
              },
            },
          },
        ],
        "one",
      ),
    ).toThrow(/collision/);
  });

  it("initializes, lists, calls and forwards progress with the official client", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    const url = await fixture();
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: "Bearer test" } },
    });
    await client.connect(transport as unknown as Transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["kanban__cards_send_batch"]);
    const progress: number[] = [];
    const result = await client.callTool(
      { name: "kanban__cards_send_batch", arguments: { count: 2 } },
      undefined,
      { onprogress: (update) => progress.push(update.progress) },
    );
    expect(progress).toEqual([50]);
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: '{"count":2}' }]);
    const wrongIdentity = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": transport.sessionId ?? "missing",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(wrongIdentity.status).toBe(404);
    await client.close();
  });

  it.each([false, true])(
    "aborts execution on stateful cancellation or stateless HTTP disconnect (stateless=%s)",
    async (stateless) => {
      let cancelled = false;
      let markStarted = () => {};
      let markCancelled = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const observedCancellation = new Promise<void>((resolve) => {
        markCancelled = resolve;
      });
      const url = await fixture(async function* (_context, _entry, _input, signal) {
        markStarted();
        if (!signal.aborted)
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        cancelled = signal.aborted;
        markCancelled();
        if (!signal.aborted) yield { type: "result", value: null };
      }, stateless);
      const client = new Client({ name: "test", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: "Bearer test" } },
      });
      await client.connect(transport as unknown as Transport);
      const controller = new AbortController();
      const call = client.callTool({ name: "kanban__cards_send_batch", arguments: {} }, undefined, {
        signal: controller.signal,
      });
      // Cancellation must occur after server execution starts, not race HTTP dispatch.
      await started;
      controller.abort();
      await expect(call).rejects.toThrow();
      // Stateless cancellation notifications may reach another replica; HTTP disconnect owns
      // the execution lifecycle instead. Stateful mode retains notification cancellation.
      if (stateless) await client.close();
      await observedCancellation;
      expect(cancelled).toBe(true);
      await client.close();
    },
  );
});
