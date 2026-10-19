import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey } from "jose";
import { describe, it, expect } from "vitest";
import { gatewayJwtVerifier } from "../src/index.js";

const principal = {
  orgId: "ws_workspace0001",
  actorId: "alice",
  actorType: "human",
  roles: [],
  scopes: ["kanban:*"],
};
describe("hosted app-bound public key authentication", () => {
  it("rejects token adversaries and bounds removed-key acceptance", async () => {
    const first = await generateKeyPair("ES256");
    const second = await generateKeyPair("ES256");
    const attacker = await generateKeyPair("ES256");
    const publicKey = async (key: CryptoKey, kid: string) => ({
      ...(await exportJWK(key)),
      kid,
      alg: "ES256",
      use: "sig",
    });
    const old = await publicKey(first.publicKey, "old");
    const next = await publicKey(second.publicKey, "next");
    let keys = [old];
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const verifier = gatewayJwtVerifier({
      issuer: "gateway",
      audience: "kanban",
      workspaceId: principal.orgId,
      algorithms: ["ES256"],
      jwksUrl: `http://127.0.0.1:${address.port}`,
      cacheMaxAge: 20,
    });
    const mint = (overrides: Record<string, unknown> = {}, key = first.privateKey, kid = "old") => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        ...principal,
        iss: "gateway",
        aud: "kanban",
        iat: now,
        exp: now + 300,
        ...overrides,
      })
        .setProtectedHeader({ alg: "ES256", kid })
        .sign(key);
    };
    try {
      const oldToken = await mint();
      await expect(verifier.verify(oldToken)).resolves.toMatchObject(principal);
      for (const override of [
        { iss: "attacker" },
        { aud: "email" },
        { aud: ["kanban", "email"] },
        { orgId: "ws_workspace0002" },
        { exp: Math.floor(Date.now() / 1000) - 1 },
        { exp: undefined },
        { iat: undefined },
        { exp: Math.floor(Date.now() / 1000) + 3600 },
        { iat: Math.floor(Date.now() / 1000) + 60 },
        { delegation: { subjectId: "admin", subjectType: "human" } },
        { actorType: "agent", delegation: { subjectId: "admin", subjectType: "agent" } },
      ])
        await expect(verifier.verify(await mint(override))).rejects.toThrow();
      await expect(verifier.verify(await mint({}, attacker.privateKey))).rejects.toThrow();
      const symmetric = await new SignJWT(principal)
        .setProtectedHeader({ alg: "HS256", kid: "old" })
        .setIssuer("gateway")
        .setAudience("kanban")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode("app-runtime-cannot-sign-gateway-tokens"));
      await expect(verifier.verify(symmetric)).rejects.toThrow();
      const noKid = await new SignJWT({ ...principal })
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer("gateway")
        .setAudience("kanban")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(first.privateKey);
      await expect(verifier.verify(noKid)).rejects.toThrow();
      const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", kid: "old" })).toString("base64url")}.${Buffer.from(JSON.stringify(principal)).toString("base64url")}.`;
      await expect(verifier.verify(unsigned)).rejects.toThrow();
      keys = [old, next];
      // Publish-before-switch: wait the test's cache bound before using the new signer.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const nextToken = await mint({}, second.privateKey, "next");
      await expect(verifier.verify(nextToken)).resolves.toMatchObject(principal);
      await expect(verifier.verify(oldToken)).resolves.toMatchObject(principal);
      keys = [next];
      await new Promise((resolve) => setTimeout(resolve, 30));
      await expect(verifier.verify(oldToken)).rejects.toThrow();
      await expect(verifier.verify(nextToken)).resolves.toMatchObject(principal);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      await expect(verifier.verify(nextToken)).rejects.toThrow();
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("does not permit symmetric workspace verifiers", () => {
    expect(() =>
      gatewayJwtVerifier({
        issuer: "gateway",
        audience: "kanban",
        workspaceId: principal.orgId,
        algorithms: ["HS256"],
        key: new Uint8Array(32),
      }),
    ).toThrow("ES256");
  });
});
