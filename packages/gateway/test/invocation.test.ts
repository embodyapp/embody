import { expect, it, vi } from "vitest";
import { prepareDispatch } from "../src/dispatch.js";
import { MemoryAuditLog } from "../src/index.js";

it("keeps provider authorization separate and requests it only after app/scope authorization", async () => {
  const invocationToken = vi.fn(() => Promise.resolve("provider-identity-token"));
  const issueToken = vi.fn(() => Promise.resolve("embody-principal-token"));
  const deps = {
    lookup: () => ({
      endpoint: "https://app.example/path",
      status: "healthy",
      actions: { ping: {} },
    }),
    scopeAllows: () => true,
    invocationToken,
    issueToken,
    audit: new MemoryAuditLog(),
  };
  const context = {
    principal: {
      orgId: "ws_workspace0001",
      actorId: "alice",
      actorType: "human" as const,
      roles: [],
      scopes: [],
    },
    appId: "kanban",
    target: "ping",
    requestId: "req-1",
    surface: "http" as const,
  };
  const result = await prepareDispatch(context, deps);
  expect(invocationToken).toHaveBeenCalledWith("https://app.example");
  expect(result.headers).toMatchObject({
    authorization: "Bearer provider-identity-token",
    "x-gateway-auth": "Bearer embody-principal-token",
  });
  invocationToken.mockClear();
  issueToken.mockClear();
  await expect(prepareDispatch(context, { ...deps, scopeAllows: () => false })).rejects.toThrow();
  expect(invocationToken).not.toHaveBeenCalled();
  expect(issueToken).not.toHaveBeenCalled();
  await expect(
    prepareDispatch(context, {
      ...deps,
      invocationToken: () => Promise.reject(new Error("provider unavailable")),
    }),
  ).rejects.toThrow();
  expect(issueToken).not.toHaveBeenCalled();
  expect(deps.audit.records.at(-1)).toMatchObject({
    outcome: "failure",
    errorCode: "INTERNAL_ERROR",
  });
});
