import { definePlugin, HookVetoError, z } from "@embody/core";
import { gatewayJwtVerifier } from "@embody/auth";
import { createAppHost, createRegistrationClient, defineApp } from "@embody/host";
import { defineGenUi, defineView, withGenUi } from "@embody/genui";
import { createGenUiGatewayConnection } from "@embody/genui/client";
import { expect, it } from "vitest";
import { jwtVerify, type JWTPayload } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import {
  apiKeyProvider,
  AuthChain,
  createGateway,
  GatewayRegistry,
  hashApiKey,
} from "../src/index.js";

it("discovers the host's exact enriched generation after authenticated registration and preserves ordinary execution", async () => {
  const secret = "registration-secret-1234";
  const key = new TextEncoder().encode("test-signing-key-with-at-least-32-bytes");
  const registry = new GatewayRegistry({
    allowPrivateEndpoints: true,
    credentials: { cards: secret },
  });
  const resourceGrants: JWTPayload[] = [];
  const resourceTokens: string[] = [];
  let resourceFault:
    | "none"
    | "bytes"
    | "uri"
    | "metadata"
    | "length"
    | "slow"
    | "outage"
    | "redirect"
    | "network"
    | "cancel" = "none";
  let bodyStarted!: () => void;
  let bodyCancelled!: () => void;
  const pendingBody = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const cancelledBody = new Promise<void>((resolve) => {
    bodyCancelled = resolve;
  });
  let canceledOversize = false;
  const gateway = createGateway({
    registry,
    resourceTimeoutMs: 50,
    fetch: async (input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.pathname === "/genui/resources/read") {
        const authorization = new Headers(init?.headers).get("x-gateway-auth");
        if (!authorization?.startsWith("Bearer ")) throw new Error("No resource grant");
        resourceTokens.push(authorization.slice(7));
        resourceGrants.push(
          (
            await jwtVerify(authorization.slice(7), key, {
              issuer: "gateway",
              audience: "cards",
              algorithms: ["HS256"],
            })
          ).payload,
        );
        expect(init?.redirect).toBe("error");
        if (resourceFault === "outage")
          return new Response("private outage cause", { status: 503 });
        if (resourceFault === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://private.example" },
          });
        if (resourceFault === "network") throw new Error("private network details");
        if (resourceFault === "cancel")
          return new Response(
            new ReadableStream<Uint8Array>({
              start() {
                bodyStarted();
              },
              cancel() {
                bodyCancelled();
              },
            }),
          );
        if (resourceFault === "slow") {
          let timer: ReturnType<typeof setTimeout>;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                timer = setTimeout(() => {
                  controller.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify({
                        uri: "ui://cards/board@1.0.0",
                        mimeType: RESOURCE_MIME_TYPE,
                        text: "<!doctype html><main>immutable code, not tenant data</main>",
                      }),
                    ),
                  );
                  controller.close();
                }, 200);
              },
              cancel() {
                clearTimeout(timer);
              },
            }),
          );
        }
        if (resourceFault === "length")
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                canceledOversize = true;
              },
            }),
            { headers: { "content-length": String(9 * 1024 * 1024) } },
          );
        if (resourceFault !== "none")
          return Response.json({
            uri: resourceFault === "uri" ? "ui://other/private" : "ui://cards/board@1.0.0",
            mimeType: RESOURCE_MIME_TYPE,
            text:
              resourceFault === "bytes"
                ? "private substituted content"
                : "<!doctype html><main>immutable code, not tenant data</main>",
            ...(resourceFault === "metadata" ? { metadata: { tenantSecret: "private" } } : {}),
          });
      }
      return fetch(input, init);
    },
    token: { issuer: "gateway", key },
    auth: new AuthChain([
      apiKeyProvider([
        {
          id: "test",
          hash: hashApiKey("test-api-key"),
          principal: {
            orgId: "org-1",
            actorId: "initiating-agent",
            actorType: "agent",
            roles: [],
            scopes: ["cards:*"],
            metadata: { privateHint: "not-for-frame" },
          },
        },
        {
          id: "human",
          hash: hashApiKey("human-api-key"),
          principal: {
            orgId: "org-1",
            actorId: "initiating-agent",
            actorType: "human",
            roles: [],
            scopes: ["cards:*"],
          },
        },
      ]),
    ]),
  });
  const gatewayUrl = await gateway.listen({ port: 0, host: "127.0.0.1" });
  const output = z.object({ title: z.string() });
  const plugin = definePlugin({ id: "cards", version: "1.0.0", entities: {} }, (define) => ({
    actions: {
      board: define.action({
        input: z.object({ veto: z.boolean().optional() }),
        output,
        handler: (input, context) => {
          if (input.veto) throw new HookVetoError("private fixture cause");
          return { title: context.principal.actorType };
        },
      }),
    },
  }));
  const application = withGenUi(
    defineApp({ appId: "cards", version: "1.0.0", plugins: [plugin] }),
    defineGenUi({
      views: {
        private: defineView({
          kind: "standard",
          version: "1.0.0",
          props: output,
          resource: { text: "<!doctype html><main>Private unbound view</main>" },
          callableTargets: ["cards.board"],
          fallback: "text",
        }),
        board: defineView({
          kind: "standard",
          version: "1.0.0",
          props: output,
          resource: { text: "<!doctype html><main>immutable code, not tenant data</main>" },
          callableTargets: ["cards.board"],
          fallback: "text",
        }),
      },
      actions: { "cards.board": "board" },
    }),
  );
  let runtime: Awaited<ReturnType<typeof createAppHost>> | undefined;
  const client = new Client(
    { name: "unknown-Apps-host", version: "fixture" },
    { capabilities: { extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } } } },
  );
  try {
    runtime = await createAppHost(application, {
      env: { NODE_ENV: "development", PORT: "0", DATABASE_FILE: ":memory:" },
      verifier: gatewayJwtVerifier({
        issuer: "gateway",
        audience: "cards",
        key,
        algorithms: ["HS256"],
        maxTokenAgeSeconds: 60,
      }),
    });
    const address = await runtime.start();
    const registration = createRegistrationClient({
      gatewayUrl,
      appId: "cards",
      version: "1.0.0",
      endpoint: address,
      healthCheckUrl: `${address}/health`,
      manifest: runtime.manifest,
      secret,
    });
    await registration.register();
    const catalog = await gateway.inject({
      url: "/api/catalog",
      headers: { authorization: "Bearer test-api-key" },
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject([
      {
        generation: runtime.generation,
        manifest: { ...runtime.manifest, views: { board: runtime.manifest.views?.["board"] } },
      },
    ]);
    expect(catalog.body).not.toContain("immutable code, not tenant data");
    expect(
      Object.keys(
        catalog.json<{ manifest: { views: Record<string, unknown> } }[]>()[0]!.manifest.views,
      ),
    ).toEqual(["board"]);
    const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/cards`), {
      requestInit: { headers: { authorization: "Bearer test-api-key" } },
    });
    await client.connect(transport as unknown as Transport);
    expect(
      (await client.listTools()).tools.find((tool) => tool.name === "cards_board")?._meta,
    ).toEqual({ ui: { resourceUri: "ui://cards/board@1.0.0", visibility: ["model", "app"] } });
    expect((await client.readResource({ uri: "ui://cards/board@1.0.0" })).contents).toEqual([
      {
        uri: "ui://cards/board@1.0.0",
        mimeType: RESOURCE_MIME_TYPE,
        text: "<!doctype html><main>immutable code, not tenant data</main>",
      },
    ]);
    expect(resourceGrants).toHaveLength(1);
    expect(resourceGrants[0]).toMatchObject({
      orgId: "org-1",
      actorId: "initiating-agent",
      actorType: "agent",
      roles: [],
      scopes: ["@embody/genui:resource:read"],
    });
    expect(resourceGrants[0]?.["metadata"]).toEqual({
      genuiResource: { uri: "ui://cards/board@1.0.0", generation: runtime.generation },
    });
    expect((resourceGrants[0]?.exp ?? 0) - (resourceGrants[0]?.iat ?? 0)).toBe(60);
    const grantCannotExecute = await runtime.app.inject({
      method: "POST",
      url: "/execute",
      headers: { "x-gateway-auth": `Bearer ${resourceTokens[0]}` },
      payload: { protocolVersion: 1, target: "cards.board", input: {} },
    });
    expect(grantCannotExecute.statusCode).toBe(403);
    for (const fault of [
      "bytes",
      "uri",
      "metadata",
      "length",
      "slow",
      "outage",
      "redirect",
      "network",
    ] as const) {
      resourceFault = fault;
      await expect(client.readResource({ uri: "ui://cards/board@1.0.0" })).rejects.toThrow(
        "Resource not found or unavailable",
      );
    }
    expect(canceledOversize).toBe(true);
    resourceFault = "cancel";
    const abort = new AbortController();
    const reading = client.readResource(
      { uri: "ui://cards/board@1.0.0" },
      { signal: abort.signal },
    );
    const rejection = expect(reading).rejects.toThrow();
    await pendingBody;
    abort.abort();
    await rejection;
    await cancelledBody;
    resourceFault = "none";
    expect(
      (await client.callTool({ name: "cards_board", arguments: {} })).structuredContent,
    ).toEqual({ title: "agent" });
    const veto = await client.callTool({ name: "cards_board", arguments: { veto: true } });
    expect(veto).toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool execution failed" }],
      _meta: { "embody/errorCode": "HOOK_VETO" },
    });
    const switchedPrincipal = await fetch(`${gatewayUrl}/mcp/cards`, {
      method: "POST",
      headers: {
        authorization: "Bearer human-api-key",
        "mcp-session-id": transport.sessionId!,
        "mcp-protocol-version": "2025-11-25",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wrong-principal",
        method: "tools/call",
        params: { name: "cards_board", arguments: {} },
      }),
    });
    expect(switchedPrincipal.status).toBe(404);
    await switchedPrincipal.body?.cancel();
    const response = await gateway.inject({
      method: "POST",
      url: "/api/execute/cards/cards.board",
      headers: { authorization: "Bearer test-api-key" },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ title: "agent" });
    expect(registration.manifestHash).toBe(runtime.generation);
    const connection = await createGenUiGatewayConnection({
      gatewayUrl,
      appId: "cards",
      authorization: "Bearer test-api-key",
    });
    try {
      const view = await connection.discover("cards.board");
      expect(view.generation).toBe(runtime.generation);
      expect(view.view.resourceUri).toBe("ui://cards/board@1.0.0");
      expect(await view.dispatch("cards.board", {}, new AbortController().signal)).toEqual({
        title: "agent",
      });
      await expect(
        view.dispatch("cards.board", { veto: true }, new AbortController().signal),
      ).rejects.toMatchObject({ code: "HOOK_VETO" });
      await expect(
        view.dispatch("other.board", {}, new AbortController().signal),
      ).rejects.toThrow();
    } finally {
      await connection.close();
    }
    for (const [generation, view] of [
      ["stale-generation", "board"],
      [runtime.generation, "foreign"],
      [runtime.generation, ""],
    ]) {
      const denied = await gateway.inject({
        method: "POST",
        url: "/api/execute/cards/cards.board",
        headers: {
          authorization: "Bearer test-api-key",
          "x-embody-genui-generation": generation,
          "x-embody-genui-view": view,
        },
        payload: {},
      });
      expect(denied.statusCode).toBe(403);
    }
    // The official client still owns its MCP session: shutdown must close hijacked
    // responses before waiting for sockets, without depending on client cooperation.
    const closing = gateway.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closing,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Gateway shutdown exceeded 2 seconds")), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await client.close();
      gateway.server.closeAllConnections();
      await closing;
    }
  } finally {
    await client.close();
    await runtime?.stop();
    await gateway.close();
  }
});
