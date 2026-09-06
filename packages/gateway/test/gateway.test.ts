import { describe, expect, it, vi } from "vitest";
import type { AppManifest } from "@embody/core";
import {
  apiKeyProvider,
  AuthChain,
  createGateway,
  GatewayRegistry,
  hashApiKey,
} from "../src/index.js";

const manifest: AppManifest = {
  protocolVersion: 1,
  plugins: [{ id: "kanban", version: "1.0.0" }],
  entities: {},
  actions: {
    "kanban.ping": {
      generated: false,
      inputSchema: { type: "object", properties: {} },
    },
  },
  eventSubscriptions: [],
};

describe("gateway remote dispatch", () => {
  it("forwards the versioned execution envelope required by app hosts", async () => {
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
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ ok: true }, { status: 200 })),
    );
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
              scopes: ["kanban:*"],
            },
          },
        ]),
      ]),
      token: { issuer: "test", key: new TextEncoder().encode("12345678901234567890123456789012") },
      fetch: fetcher,
    });
    const response = await gateway.inject({
      method: "POST",
      url: "/api/execute/kanban/kanban.ping",
      headers: { authorization: "Bearer api-key" },
      payload: { value: 1 },
    });
    expect(response.statusCode).toBe(200);
    const body = fetcher.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe("string");
    if (typeof body !== "string") throw new Error("Expected a serialized execution request");
    expect(JSON.parse(body)).toEqual({
      protocolVersion: 1,
      target: "kanban.ping",
      input: { value: 1 },
    });
    await gateway.close();
  });
});
