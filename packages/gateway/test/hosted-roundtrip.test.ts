import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { gatewayJwtVerifier } from "@embody/auth";
import type { Kernel } from "@embody/core";
import { createHost } from "@embody/host";
import { expect, it, vi } from "vitest";
import { createWorkspaceGateway, MemoryGatewayStore, newCredential } from "../src/index.js";
import { appRecord, credentialInput } from "./store-conformance.js";
import { signingIdentity } from "./signing-fixture.js";

it("round-trips hosted gateway public JWKS and distinct invocation credentials through HTTP, SSE and MCP", async () => {
  const workspace = "ws_roundtrip0001";
  const store = new MemoryGatewayStore();
  await store.createWorkspace(workspace);
  const credential = newCredential(credentialInput(workspace));
  await store.putCredential(credential.credential, null);
  let hostAddress = "";
  const admittedOrigin = "https://fixture.a.run.app";
  const fetcher = vi.fn<typeof fetch>((url, init) => {
    const requested = url instanceof URL ? url : new URL(typeof url === "string" ? url : url.url);
    expect(requested.origin).toBe(admittedOrigin);
    return fetch(new URL(requested.pathname, hostAddress), init);
  });
  const provider = vi.fn(() => Promise.resolve("fixture-provider-identity"));
  const gateway = createWorkspaceGateway({
    store,
    token: signingIdentity,
    fetch: fetcher,
    invocationToken: provider,
  });
  const gatewayAddress = await gateway.listen({ port: 0, host: "127.0.0.1" });
  const execute = vi.fn<Kernel["execute"]>(() => Promise.resolve({ ok: true }));
  const host = createHost({
    appId: "kanban",
    version: "1",
    environment: "production",
    kernel: { state: "ready", execute, manifest: {} } as unknown as Kernel,
    verifier: gatewayJwtVerifier({
      issuer: signingIdentity.issuer,
      audience: "kanban",
      workspaceId: workspace,
      algorithms: ["ES256"],
      jwksUrl: new URL("/.well-known/jwks.json", gatewayAddress),
    }),
  });
  const client = new Client({ name: "roundtrip", version: "1" });
  try {
    await host.start();
    hostAddress = await host.app.listen({ host: "127.0.0.1", port: 0 });
    await store.putApp(appRecord(workspace, admittedOrigin), null);
    const headers = { authorization: `Bearer ${credential.token}` };
    for (const path of ["execute", "execute/stream"]) {
      const response = await gateway.inject({
        method: "POST",
        url: `/w/${workspace}/api/${path}/kanban/kanban.ping`,
        headers,
        payload: {},
      });
      expect(response.statusCode).toBe(200);
    }
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`/w/${workspace}/mcp`, gatewayAddress), {
        requestInit: { headers },
      }) as unknown as Transport,
    );
    expect(await client.callTool({ name: "kanban__kanban_ping", arguments: {} })).not.toMatchObject(
      { isError: true },
    );
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0]![2]).toMatchObject({
      principal: {
        orgId: workspace,
        actorType: "human",
      },
    });
    expect(execute.mock.calls[1]![2]).toMatchObject({
      principal: {
        orgId: workspace,
        actorType: "human",
      },
    });
    expect(execute.mock.calls[2]![2]).toMatchObject({
      principal: {
        orgId: workspace,
        actorType: "agent",
        delegation: { subjectId: "alice", subjectType: "human" },
      },
    });
    expect(provider).toHaveBeenCalledTimes(3);
    expect(provider).toHaveBeenCalledWith(admittedOrigin);
    for (const [, init] of fetcher.mock.calls) {
      const downstreamHeaders = new Headers(init!.headers);
      expect(init!.redirect).toBe("error");
      expect(downstreamHeaders.get("authorization")).toBe("Bearer fixture-provider-identity");
      expect(downstreamHeaders.get("x-gateway-auth")).not.toBe(`Bearer ${credential.token}`);
    }
    const denied = await gateway.inject({
      method: "POST",
      url: "/w/ws_other0001/api/execute/kanban/kanban.ping",
      headers,
      payload: {},
    });
    expect(denied.statusCode).toBe(401);
    expect(provider).toHaveBeenCalledTimes(3);
  } finally {
    await client.close();
    await host.stop();
    await gateway.close();
    await store.close();
  }
});
