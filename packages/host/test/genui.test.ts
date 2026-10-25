import { definePlugin, z } from "@embody/core";
import { gatewayJwtVerifier } from "@embody/auth";
import { SignJWT } from "jose";
import { defineGenUi, defineView, withGenUi } from "@embody/genui";
import { expect, it } from "vitest";
import { createAppHost, createHost, compileHostPresentation, defineApp } from "../src/index.js";

const output = z.object({ title: z.string() });
const plugin = definePlugin({
  id: "cards",
  version: "1.0.0",
  actions: { board: { input: z.object({}), output, handler: () => ({ title: "Private board" }) } },
});
const resource = {
  text: "<!doctype html><main>Static application code</main>",
  metadata: { prefersBorder: true },
};
const presentation = () =>
  defineGenUi({
    views: {
      board: defineView({
        kind: "standard",
        version: "1.0.0",
        props: output,
        resource: { ...resource, metadata: { ...resource.metadata } },
        callableTargets: ["cards.board"],
        fallback: "text",
      }),
    },
    actions: { "cards.board": "board" },
  });
const definition = () =>
  withGenUi(defineApp({ appId: "cards", version: "1.0.0", plugins: [plugin] }), presentation());
const env = { NODE_ENV: "development", PORT: "0", DATABASE_FILE: ":memory:" };
const key = new TextEncoder().encode("test-key-with-at-least-thirty-two-bytes");
async function credential(
  binding: { uri: string; generation: string } | undefined,
  scopes = ["@embody/genui:resource:read"],
  audience = "cards",
  expires = "60s",
) {
  return new SignJWT({
    orgId: "org-1",
    actorId: "agent-1",
    actorType: "agent",
    roles: [],
    scopes,
    ...(binding === undefined ? {} : { metadata: { genuiResource: binding } }),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("gateway")
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(key);
}
const verifier = () =>
  gatewayJwtVerifier({
    issuer: "gateway",
    audience: "cards",
    key,
    algorithms: ["HS256"],
    maxTokenAgeSeconds: 60,
  });

it("serves immutable generation-bound resources only to gateway resource credentials", async () => {
  const app = definition();
  const runtime = await createAppHost(app, { env, verifier: verifier() });
  try {
    await runtime.start();
    Object.assign(app.genui.views.board.resource, { text: "Changed after boot" });
    const payload = {
      protocolVersion: 1,
      uri: "ui://cards/board@1.0.0",
      generation: runtime.generation,
    };
    const response = await runtime.app.inject({
      method: "POST",
      url: "/genui/resources/read",
      headers: {
        "x-gateway-auth": `Bearer ${await credential({ uri: payload.uri, generation: runtime.generation })}`,
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      uri: "ui://cards/board@1.0.0",
      mimeType: "text/html;profile=mcp-app",
      text: resource.text,
      metadata: { prefersBorder: true },
    });
    expect(response.headers["etag"]).toMatch(/^"sha256:[a-f0-9]{64}"$/);
  } finally {
    await runtime.stop();
  }
});

it("denies a resource credential without an exact signed URI/generation purpose", async () => {
  const runtime = await createAppHost(definition(), { env, verifier: verifier() });
  try {
    await runtime.start();
    const payload = {
      protocolVersion: 1,
      uri: "ui://cards/board@1.0.0",
      generation: runtime.generation,
    };
    for (const binding of [
      undefined,
      { uri: "ui://cards/other@1.0.0", generation: runtime.generation },
      { uri: payload.uri, generation: "0".repeat(64) },
    ]) {
      const response = await runtime.app.inject({
        method: "POST",
        url: "/genui/resources/read",
        headers: { "x-gateway-auth": `Bearer ${await credential(binding)}` },
        payload,
      });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain("Static application code");
    }
  } finally {
    await runtime.stop();
  }
});

it.each([
  ["missing token", 401],
  ["wrong audience", 401],
  ["expired", 401],
  ["no resource scope", 403],
  ["unknown URI", 404],
  ["stale generation", 404],
  ["encoded traversal", 404],
] as const)("does not disclose resources for %s", async (scenario, status) => {
  const runtime = await createAppHost(definition(), { env, verifier: verifier() });
  try {
    await runtime.start();
    const uri =
      scenario === "unknown URI"
        ? "ui://cards/missing@1.0.0"
        : scenario === "encoded traversal"
          ? "ui://cards/%2e%2e/private"
          : "ui://cards/board@1.0.0";
    const binding = {
      uri,
      generation: scenario === "stale generation" ? "0".repeat(64) : runtime.generation,
    };
    const token = await credential(
      binding,
      scenario === "no resource scope" ? ["cards:*"] : undefined,
      scenario === "wrong audience" ? "other" : undefined,
      scenario === "expired" ? "-1s" : undefined,
    );
    const response = await runtime.app.inject({
      method: "POST",
      url: "/genui/resources/read",
      headers: scenario === "missing token" ? {} : { "x-gateway-auth": `Bearer ${token}` },
      payload: { protocolVersion: 1, ...binding },
    });
    expect(response.statusCode).toBe(status);
    expect(response.body).not.toContain("Static application code");
  } finally {
    await runtime.stop();
  }
});

it("returns conditional responses without widening the resource credential into action permission", async () => {
  const runtime = await createAppHost(definition(), { env, verifier: verifier() });
  try {
    await runtime.start();
    const binding = { uri: "ui://cards/board@1.0.0", generation: runtime.generation };
    const headers = { "x-gateway-auth": `Bearer ${await credential(binding)}` };
    const payload = { protocolVersion: 1, ...binding };
    const first = await runtime.app.inject({
      method: "POST",
      url: "/genui/resources/read",
      headers,
      payload,
    });
    const cached = await runtime.app.inject({
      method: "POST",
      url: "/genui/resources/read",
      headers: { ...headers, "if-none-match": first.headers["etag"] as string },
      payload,
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe("");
    const denied = await runtime.app.inject({
      method: "POST",
      url: "/execute",
      headers,
      payload: { protocolVersion: 1, target: "cards.board", input: {} },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain("Private board");
  } finally {
    await runtime.stop();
  }
});

it("leaves a plain app's manifest and resource-route behavior unchanged", async () => {
  const runtime = await createAppHost(
    defineApp({ appId: "cards", version: "1.0.0", plugins: [plugin] }),
    { env },
  );
  try {
    await runtime.start();
    expect(runtime.manifest).toBe(runtime.kernel.manifest);
    expect(runtime.manifest.views).toBeUndefined();
    const response = await runtime.app.inject({
      method: "POST",
      url: "/genui/resources/read",
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  } finally {
    await runtime.stop();
  }
});

it("rejects a provider's substituted resource bytes without changing ordinary action success", async () => {
  const runtime = await createAppHost(definition(), { env, verifier: verifier() });
  const snapshot = compileHostPresentation(definition(), runtime.kernel.manifest);
  const host = createHost({
    kernel: runtime.kernel,
    verifier: verifier(),
    appId: "cards",
    version: "1.0.0",
    presentation: {
      ...snapshot,
      readResource: (uri, generation) => {
        const original = snapshot.readResource(uri, generation);
        return original === undefined
          ? undefined
          : { ...original, text: "private substituted resource" };
      },
    },
  });
  try {
    await host.start();
    const result = await host.app.inject({
      method: "POST",
      url: "/execute",
      headers: { "x-gateway-auth": `Bearer ${await credential(undefined, ["cards:*"])}` },
      payload: { protocolVersion: 1, target: "cards.board", input: {} },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ title: "Private board" });
    const binding = { uri: "ui://cards/board@1.0.0", generation: snapshot.generation };
    const response = await host.app.inject({
      method: "POST",
      url: "/genui/resources/read",
      headers: { "x-gateway-auth": `Bearer ${await credential(binding)}` },
      payload: { protocolVersion: 1, ...binding },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private substituted resource");
  } finally {
    await host.stop();
    await runtime.stop();
  }
});

it("rechecks mutated bindings and rejects undeclared security metadata before readiness", async () => {
  const badBinding = definition();
  Object.assign(badBinding.genui.actions, { "cards.board": "missing" });
  await expect(createAppHost(badBinding, { env })).rejects.toThrow(
    "GenUI bound view was not found",
  );
  const badMetadata = definition();
  Object.assign(badMetadata.genui.views.board.resource.metadata, {
    tenantData: "must never be a resource",
  });
  await expect(createAppHost(badMetadata, { env })).rejects.toThrow(
    "GenUI resource metadata is invalid",
  );
});

it("requires an issued-at claim and bounded credential age even when expiration is in the future", async () => {
  const runtime = await createAppHost(definition(), { env, verifier: verifier() });
  try {
    await runtime.start();
    for (const issuedAt of [undefined, Math.floor(Date.now() / 1000) - 120]) {
      const claims = {
        orgId: "org-1",
        actorId: "agent-1",
        actorType: "agent",
        roles: [],
        scopes: ["@embody/genui:resource:read"],
        ...(issuedAt === undefined ? {} : { iat: issuedAt }),
      };
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("gateway")
        .setAudience("cards")
        .setExpirationTime("1h")
        .sign(key);
      const response = await runtime.app.inject({
        method: "POST",
        url: "/genui/resources/read",
        headers: { "x-gateway-auth": `Bearer ${token}` },
        payload: {
          protocolVersion: 1,
          uri: "ui://cards/board@1.0.0",
          generation: runtime.generation,
        },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain("Static application code");
    }
  } finally {
    await runtime.stop();
  }
});

it("exposes an enriched runtime manifest while HTTP keeps the ordinary validated action output", async () => {
  const runtime = await createAppHost(definition(), { env });
  try {
    await runtime.start();
    expect(runtime.manifest.actions["cards.board"]?.presentation).toEqual({ view: "board" });
    expect(runtime.manifest.views?.["board"]?.resourceUri).toBe("ui://cards/board@1.0.0");
    expect(runtime.generation).toMatch(/^[a-f0-9]{64}$/);
    const response = await runtime.app.inject({
      method: "POST",
      url: "/execute",
      headers: { "x-gateway-auth": "Bearer local" },
      payload: { protocolVersion: 1, target: "cards.board", input: {} },
    });
    expect(response.json()).toEqual({ title: "Private board" });
    expect(JSON.stringify(runtime.manifest)).not.toContain("Static application code");
    expect(JSON.stringify(runtime.manifest)).not.toContain("Private board");
  } finally {
    await runtime.stop();
  }
});
