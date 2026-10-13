import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  MemoryGatewayStore,
  MemoryAuditLog,
  createWorkspaceGateway,
  newCredential,
} from "../src/index.js";
import { SseFrameDecoder } from "../src/dispatch.js";
import { signingIdentity } from "./signing-fixture.js";
import { appRecord, credentialInput } from "./store-conformance.js";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
const surfaces = ["http", "stream", "mcp"] as const;
const terminal = (value: unknown) =>
  new Response(`event: result\ndata: ${JSON.stringify(value)}\n\n`);
const failure = (code = "HOOK_VETO") => ({
  error: { code, message: "Known host failure", requestId: "host-id" },
});

async function fixture(
  fetcher: typeof fetch,
  completionTimeoutMs?: number,
  requestTimeoutMs?: number,
) {
  const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
  const store = new MemoryGatewayStore();
  await store.createWorkspace(workspace);
  const issued = newCredential(credentialInput(workspace));
  await store.putCredential(issued.credential, null);
  await store.putApp(appRecord(workspace), null);
  const audit = new MemoryAuditLog();
  const admit = vi.spyOn(store, "admit");
  const complete = vi.spyOn(store, "complete");
  const fetchSpy = vi.fn(fetcher);
  const gateway = createWorkspaceGateway({
    store,
    token: signingIdentity,
    fetch: fetchSpy,
    audit,
    actionTimeoutMs: 100,
    ...(completionTimeoutMs ? { auditCompletionTimeoutMs: completionTimeoutMs } : {}),
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
  });
  closers.push(
    () => store.close(),
    () => gateway.close(),
  );
  const headers = { authorization: `Bearer ${issued.token}` };
  const call = async (surface: (typeof surfaces)[number]) => {
    if (surface === "mcp") {
      const address = await gateway.listen({ host: "127.0.0.1", port: 0 });
      const client = new Client({ name: "m07-safety", version: "1" });
      closers.push(() => client.close());
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`/w/${workspace}/mcp`, address), {
          requestInit: { headers },
        }) as unknown as Transport,
      );
      const result = await client.callTool({ name: "kanban__kanban_ping", arguments: {} });
      return {
        text: JSON.stringify(result),
        id: result._meta?.["embody/requestId"],
        isError: result.isError === true,
      };
    }
    const response = await gateway.inject({
      method: "POST",
      url: `/w/${workspace}/api/${surface === "http" ? "execute" : "execute/stream"}/kanban/kanban.ping`,
      headers,
      payload: {},
    });
    return {
      text: response.body,
      id: response.headers["x-request-id"],
      isError: response.statusCode >= 400 || response.body.includes("event: error"),
    };
  };
  return { store, gateway, audit, admit, complete, fetchSpy, call, workspace, headers };
}

it.each(surfaces)(
  "M07.b %s error-body ambiguity preserves warning/ID and never replays",
  async (surface) => {
    let effects = 0;
    const f = await fixture(() => {
      effects++;
      return Promise.resolve(new Response("{truncated", { status: 500 }));
    });
    const result = await f.call(surface);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("outcome unknown");
    expect(result.id).toBe(f.admit.mock.calls[0]![0].requestId);
    expect(f.complete).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown", requestId: result.id }),
    );
    expect(effects).toBe(1);
  },
);

it.each(
  surfaces.flatMap((surface) =>
    ["INTERNAL_ERROR", "UNAVAILABLE"].map((code) => ({ surface, code })),
  ),
)("M07.b $surface normalizes host $code to unknown", async ({ surface, code }) => {
  const f = await fixture(() => Promise.resolve(Response.json(failure(code), { status: 503 })));
  const result = await f.call(surface);
  expect(result.text).toContain("outcome unknown");
  expect(result.id).toBe(f.admit.mock.calls[0]![0].requestId);
  expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unknown" }));
  expect(f.fetchSpy).toHaveBeenCalledTimes(1);
});

it.each(surfaces.flatMap((surface) => ["stalled", "oversized"].map((mode) => ({ surface, mode }))))(
  "M07.c $surface bounds $mode error bodies",
  async ({ surface, mode }) => {
    const f = await fixture(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (mode === "oversized") controller.enqueue(new Uint8Array(1_048_577));
            },
          }),
          { status: 500 },
        ),
      ),
    );
    const result = await f.call(surface);
    expect(result.text).toContain("outcome unknown");
    expect(result.id).toBe(f.admit.mock.calls[0]![0].requestId);
    expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unknown" }));
  },
);

it.each(
  surfaces.flatMap((surface) => ["success", "failure"].map((outcome) => ({ surface, outcome }))),
)(
  "M07.d $surface preserves known $outcome and ID during completion outage",
  async ({ surface, outcome }) => {
    const f = await fixture(() =>
      Promise.resolve(
        outcome === "failure"
          ? Response.json(failure(), { status: 403 })
          : surface === "http"
            ? Response.json({ ok: true })
            : terminal({ ok: true }),
      ),
    );
    f.complete.mockRejectedValueOnce(new Error("sensitive database error"));
    const result = await f.call(surface);
    expect(result.id).toBe(f.admit.mock.calls[0]![0].requestId);
    expect(result.isError).toBe(outcome === "failure");
    expect(result.text).toContain(outcome === "failure" ? "Known host failure" : "ok");
    expect(result.text).not.toContain("sensitive");
    expect(f.audit.records).toMatchObject([
      { requestId: result.id, outcome: "unknown", errorCode: "UNAVAILABLE" },
    ]);
    expect(f.fetchSpy).toHaveBeenCalledTimes(1);
  },
);

it.each(surfaces)(
  "M07.d %s completion deadline retains known result and drains late completion",
  async (surface) => {
    const f = await fixture(
      () =>
        Promise.resolve(surface === "http" ? Response.json({ ok: true }) : terminal({ ok: true })),
      20,
    );
    // Capture the original implementation, not the spy itself.
    f.complete.mockRestore();
    const complete = f.store.complete.bind(f.store);
    const delayed = vi.spyOn(f.store, "complete").mockImplementationOnce(async (record) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await complete(record);
    });
    const result = await f.call(surface);
    expect(result.isError).toBe(false);
    expect(result.id).toBe(f.admit.mock.calls[0]![0].requestId);
    await f.gateway.close();
    expect(delayed).toHaveBeenCalledTimes(1);
    expect(f.audit.records[0]).toMatchObject({ outcome: "unknown", errorCode: "UNAVAILABLE" });
  },
);

it("M07.a whole request deadline bounds a stalled inbound body before admission", async () => {
  const f = await fixture(() => Promise.resolve(Response.json({ ok: true })), undefined, 20);
  const address = await f.gateway.listen({ host: "127.0.0.1", port: 0 });
  const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const request = httpRequest(
      new URL(`/w/${f.workspace}/api/execute/kanban/kanban.ping`, address),
      {
        method: "POST",
        headers: { ...f.headers, "content-type": "application/json", "content-length": "100" },
      },
      (result) => {
        let text = "";
        result.setEncoding("utf8");
        result.on("data", (chunk: string) => {
          text += chunk;
        });
        result.on("error", reject);
        result.on("end", () => {
          request.destroy();
          resolve({ status: result.statusCode ?? 0, text });
        });
      },
    );
    request.on("error", reject);
    request.write("{");
  });
  expect(response.status).toBe(503);
  expect(response.text).toContain("Request deadline");
  expect(f.admit).not.toHaveBeenCalled();
  expect(f.fetchSpy).not.toHaveBeenCalled();
});

it("M07.c SSE backpressure with no drain ends at the action deadline", async () => {
  const f = await fixture(() =>
    Promise.resolve(
      new Response(
        'event: progress\ndata: {"message":"waiting"}\n\nevent: result\ndata: {"ok":true}\n\n',
      ),
    ),
  );
  f.gateway.addHook("onRequest", (request, reply, done) => {
    if (request.url.includes("execute/stream")) {
      const write = reply.raw.write.bind(reply.raw);
      vi.spyOn(reply.raw, "write").mockImplementation((chunk: string | Uint8Array) => {
        write(chunk);
        return false;
      });
    }
    done();
  });
  const address = await f.gateway.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(
    new URL(`/w/${f.workspace}/api/execute/stream/kanban/kanban.ping`, address),
    { method: "POST", headers: { ...f.headers, "content-type": "application/json" }, body: "{}" },
  );
  expect(response.status).toBe(200);
  await expect(response.text()).rejects.toThrow();
  await expect.poll(() => f.complete.mock.calls.length).toBe(1);
  expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unknown" }));
  expect(f.fetchSpy).toHaveBeenCalledTimes(1);
});

it("M07.c SSE frame limits are independent of chunk coalescing and UTF-8 splits", () => {
  const frame = `event: progress\ndata: ${JSON.stringify({ message: "é".repeat(20_000) })}\n\n`;
  const bytes = new TextEncoder().encode(frame + frame);
  const coalesced = new SseFrameDecoder().push(bytes);
  const split = new SseFrameDecoder();
  const frames = [];
  for (let i = 0; i < bytes.length; i += 17) frames.push(...split.push(bytes.slice(i, i + 17)));
  expect(coalesced).toEqual(frames);
  expect(coalesced).toHaveLength(2);
  expect(() =>
    new SseFrameDecoder().push(
      new TextEncoder().encode(`event: progress\ndata: ${"é".repeat(33_000)}\n\n`),
    ),
  ).toThrow("too large");
});

it("M07.a controlled cold hosted gateway/store/real HTTP host succeeds", async () => {
  let invoked = 0;
  const host: Server = createServer((_request, response) => {
    invoked++;
    setTimeout(() => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ cold: true }));
    }, 20);
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  closers.push(
    () =>
      new Promise<void>((resolve, reject) =>
        host.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = host.address();
  if (!address || typeof address === "string") throw new Error("Missing host address");
  const f = await fixture((url, init) =>
    fetch(
      new URL(
        new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname,
        `http://127.0.0.1:${address.port}`,
      ),
      init,
    ),
  );
  const result = await f.call("http");
  expect(result.isError).toBe(false);
  expect(result.text).toContain('"cold":true');
  expect(invoked).toBe(1);
  expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
});
