import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { expect, it, vi } from "vitest";
import type { Kernel } from "@embody/core";
import { gatewayJwtVerifier } from "@embody/auth";
import { createHost, parseAppEnvironment } from "../src/index.js";

it("host HTTP and streaming paths reject workspace, app, delegation and unsigned callers before execution", async () => {
  const pair = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "current", alg: "ES256", use: "sig" };
  const server = createServer((_req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const execute = vi.fn(() => Promise.resolve({ ok: true }));
  const principal = {
    orgId: "ws_workspace0001",
    actorId: "alice",
    actorType: "human",
    roles: [],
    scopes: ["kanban:*"],
  };
  const host = createHost({
    appId: "kanban",
    version: "1.0.0",
    environment: "production",
    kernel: { state: "ready", execute, manifest: {} } as unknown as Kernel,
    verifier: gatewayJwtVerifier({
      issuer: "gateway",
      audience: "kanban",
      workspaceId: principal.orgId,
      algorithms: ["ES256"],
      jwksUrl: `http://127.0.0.1:${port}`,
    }),
  });
  const mint = (overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      ...principal,
      iss: "gateway",
      aud: "kanban",
      iat: now,
      exp: now + 300,
      ...overrides,
    })
      .setProtectedHeader({ alg: "ES256", kid: "current" })
      .sign(pair.privateKey);
  };
  try {
    await host.start();
    for (const url of ["/execute", "/execute/stream"]) {
      for (const token of [
        undefined,
        "raw-api-key",
        await mint({ orgId: "ws_workspace0002" }),
        await mint({ aud: "email" }),
        await mint({ iss: "wrong" }),
        await mint({ exp: 1 }),
        await mint({ delegation: { subjectId: "admin", subjectType: "human" } }),
      ]) {
        const response = await host.app.inject({
          method: "POST",
          url,
          headers: token ? { "x-gateway-auth": `Bearer ${token}` } : {},
          payload: { protocolVersion: 1, target: "kanban.ping", input: {} },
        });
        expect(response.statusCode).toBe(401);
      }
    }
    expect(execute).not.toHaveBeenCalled();
    const response = await host.app.inject({
      method: "POST",
      url: "/execute",
      headers: { "x-gateway-auth": `Bearer ${await mint()}` },
      payload: { protocolVersion: 1, target: "kanban.ping", input: {} },
    });
    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "kanban.ping",
      {},
      expect.objectContaining({ principal }),
    );
  } finally {
    await host.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("hosted environment rejects shared signing secrets, non-production, missing workspace and insecure JWKS", () => {
  const env = {
    NODE_ENV: "production",
    EMBODY_HOST_PROFILE: "hosted",
    DATABASE_URL: "postgres://localhost/app",
    EMBODY_WORKSPACE_ID: "ws_workspace0001",
    GATEWAY_JWT_ISSUER: "gateway",
    GATEWAY_JWKS_URL: "https://gateway.example/.well-known/jwks.json",
  };
  expect(parseAppEnvironment(env).EMBODY_WORKSPACE_ID).toBe("ws_workspace0001");
  for (const override of [
    { GATEWAY_JWT_SECRET: "private-secret-must-not-reach-runtime" },
    { GATEWAY_JWT_PRIVATE_KEY: "private-material" },
    { GATEWAY_PLATFORM_DATABASE_URL: "postgres://localhost/platform" },
    { EMBODY_EVENT_SECRET: "legacy-event-shared-secret" },
    { NODE_ENV: "development" },
    { EMBODY_WORKSPACE_ID: undefined },
    { GATEWAY_JWKS_URL: "http://localhost/keys" },
  ])
    expect(() => parseAppEnvironment({ ...env, ...override })).toThrow();
});
