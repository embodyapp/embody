import { exportPKCS8, exportJWK, generateKeyPair, jwtVerify, createLocalJWKSet } from "jose";
import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { appRecord, credentialInput } from "./store-conformance.js";
import {
  hostedSigningIdentity,
  issueGatewayToken,
  createWorkspaceGateway,
  MemoryGatewayStore,
  newCredential,
} from "../src/index.js";
import { signingIdentity, publicKeys, privateKeyPem } from "./signing-fixture.js";

it("issues short-lived app-bound ES256 tokens and publishes only public keys without credentials", async () => {
  const principal = {
    orgId: "ws_workspace0001",
    actorId: "alice",
    actorType: "agent" as const,
    roles: [],
    scopes: ["kanban:*"],
    delegation: { subjectId: "alice", subjectType: "human" as const },
  };
  const token = await issueGatewayToken(principal, "kanban", "request-1", signingIdentity);
  const { payload, protectedHeader } = await jwtVerify(
    token,
    createLocalJWKSet({ keys: publicKeys }),
    {
      issuer: "test",
      audience: "kanban",
      algorithms: ["ES256"],
    },
  );
  expect(protectedHeader).toEqual({ alg: "ES256", kid: "test-key" });
  expect(payload).toMatchObject({ ...principal, requestId: "request-1" });
  expect(payload.exp! - payload.iat!).toBe(300);
  await expect(
    jwtVerify(token, createLocalJWKSet({ keys: publicKeys }), { audience: "email" }),
  ).rejects.toThrow();
  const store = new MemoryGatewayStore();
  await store.createWorkspace(principal.orgId);
  await store.putApp(appRecord(principal.orgId), null);
  const issued = newCredential(credentialInput(principal.orgId));
  await store.putCredential(issued.credential, null);
  const fetcher = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response('event: result\ndata: {"ok":true}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  );
  const gateway = createWorkspaceGateway({
    store,
    token: signingIdentity,
    fetch: fetcher,
    mcp: { actor: "token" }, // Hosted routes must ignore the legacy reference opt-out.
  });
  const client = new Client({ name: "hosted-identity-test", version: "1" });
  try {
    const response = await gateway.inject({ url: "/.well-known/jwks.json" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(signingIdentity.publicJwks);
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
    expect(response.body).not.toContain('"d":');
    const address = await gateway.listen({ port: 0, host: "127.0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`/w/${principal.orgId}/mcp`, address), {
        requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
      }) as unknown as Transport,
    );
    expect(await client.callTool({ name: "kanban__kanban_ping", arguments: {} })).not.toMatchObject(
      { isError: true },
    );
    const init = fetcher.mock.calls[0]![1]!;
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBeNull();
    const downstream = headers.get("x-gateway-auth")!.replace(/^Bearer /, "");
    expect(downstream).not.toBe(issued.token);
    const verified = await jwtVerify(downstream, createLocalJWKSet({ keys: publicKeys }), {
      algorithms: ["ES256"],
      issuer: "test",
      audience: "kanban",
    });
    expect(verified.payload).toMatchObject({
      orgId: principal.orgId,
      actorType: "agent",
      delegation: { subjectId: "alice", subjectType: "human" },
    });
  } finally {
    await client.close();
    await gateway.close();
  }
});

it("rejects symmetric hosted identities, private JWKS, duplicate keys and mismatched active keys", async () => {
  expect(() =>
    createWorkspaceGateway({
      store: new MemoryGatewayStore(),
      token: { issuer: "test", key: new Uint8Array(32) },
    }),
  ).toThrow("asymmetric");
  expect(() =>
    createWorkspaceGateway({
      store: new MemoryGatewayStore(),
      token: { ...signingIdentity, kid: "unpublished" },
    }),
  ).toThrow("must be published");
  const other = await generateKeyPair("ES256", { extractable: true });
  const badKeys = [
    [{ ...publicKeys[0], d: "private" }],
    [publicKeys[0]!, publicKeys[0]!],
    [{ ...publicKeys[0], alg: "HS256" }],
    [{ ...(await exportJWK(other.publicKey)), kid: "test-key", alg: "ES256", use: "sig" }],
  ];
  for (const keys of badKeys)
    await expect(
      hostedSigningIdentity({
        issuer: "test",
        kid: "test-key",
        privateKeyPem,
        publicKeys: keys,
      }),
    ).rejects.toThrow();
  await expect(
    hostedSigningIdentity({
      issuer: "test",
      kid: "test-key",
      privateKeyPem: await exportPKCS8(other.privateKey),
      publicKeys,
    }),
  ).rejects.toThrow("match");
});
