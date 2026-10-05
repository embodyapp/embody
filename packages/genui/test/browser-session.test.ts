import { expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { createGenUiBrowserHost } from "../src/browser.js";
import { createGenUiController } from "../src/controller.js";
const document = {
  version: 1,
  root: {
    version: 1,
    type: "actions",
    actions: [
      {
        id: "save",
        label: "Save",
        effect: "Update",
        event: {
          intent: "invoke",
          target: "cards.update",
          schema: { type: "object", additionalProperties: false, required: [], properties: {} },
        },
      },
    ],
  },
};
it("exchanges a single-use fragment for a purpose-limited lease and denies replay, CSRF and revocation", async () => {
  let calls = 0;
  const host = await createGenUiBrowserHost({ mode: "development", ttlMs: 10000 });
  try {
    const controller = createGenUiController({
      document,
      callableTargets: ["cards.update", "cards.get"],
      readTargets: ["cards.get"],
      refresh: { target: "cards.get", input: {} },
      present: () => document,
      resolveAction: () => ({}),
      dispatch: () => {
        calls++;
        return Promise.resolve({});
      },
    });
    const lease = host.open({
      appId: "cards",
      viewId: "board",
      generation: "generation-1",
      controller,
      bindings: { save: { kind: "object", fields: {} } },
      publishOutcome: () => Promise.resolve(),
    });
    const url = new URL(lease.url);
    expect(url.search).toBe("");
    const exchange = () =>
      fetch(url.origin + "/session", {
        method: "POST",
        headers: { Origin: url.origin, Authorization: "Bearer " + url.hash.slice(1) },
      });
    const response = await exchange();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const result = (await response.json()) as { token: string; document: unknown };
    expect(result.document).toEqual(document);
    expect((await exchange()).status).toBe(404);
    const action = (origin: string) =>
      fetch(url.origin + "/action", {
        method: "POST",
        headers: {
          Origin: origin,
          Authorization: "Bearer " + result.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ nodeId: "save", payload: {} }),
      });
    expect((await action("https://evil.example")).status).toBe(404);
    expect(calls).toBe(0);
    expect((await action(url.origin)).status).toBe(200);
    expect(calls).toBe(2);
    lease.revoke();
    expect((await action(url.origin)).status).toBe(404);
    expect((await fetch(url.origin + "/?token=" + result.token)).status).toBe(404);
  } finally {
    await host.close();
  }
});
it("expires bounded leases deterministically without allowing a fragment replay", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const host = await createGenUiBrowserHost({ mode: "development", ttlMs: 1000, maxSessions: 1 });
  const create = () =>
    createGenUiController({
      document,
      callableTargets: ["cards.update", "cards.get"],
      readTargets: ["cards.get"],
      refresh: { target: "cards.get", input: {} },
      present: () => document,
      resolveAction: () => ({}),
      dispatch: () => Promise.resolve({}),
    });
  try {
    const open = () =>
      host.open({
        appId: "cards",
        viewId: "board",
        generation: "1",
        controller: create(),
        bindings: {},
        publishOutcome: () => Promise.resolve(),
      });
    const lease = open();
    expect(open).toThrow(/unavailable/);
    vi.setSystemTime(Date.now() + 1001);
    const url = new URL(lease.url);
    expect(
      (
        await fetch(url.origin + "/session", {
          method: "POST",
          headers: { Origin: url.origin, Authorization: "Bearer " + url.hash.slice(1) },
        })
      ).status,
    ).toBe(404);
    const next = open();
    expect(next.url).not.toBe(lease.url);
    next.revoke();
  } finally {
    await host.close();
    vi.useRealTimers();
  }
});
it("bounds 100 concurrent presentation leases and releases their authority on shutdown", async () => {
  const before = process.memoryUsage().heapUsed;
  const host = await createGenUiBrowserHost({ mode: "development", maxSessions: 100 });
  const open = () =>
    host.open({
      appId: "cards",
      viewId: "board",
      generation: "1",
      controller: createGenUiController({
        document,
        callableTargets: ["cards.update", "cards.get"],
        readTargets: ["cards.get"],
        refresh: { target: "cards.get", input: {} },
        present: () => document,
        resolveAction: () => ({}),
        dispatch: () => Promise.resolve({}),
      }),
      bindings: {},
      publishOutcome: () => Promise.resolve(),
    });
  try {
    const leases = Array.from({ length: 100 }, open);
    expect(open).toThrow(/unavailable/);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
    for (const lease of leases) lease.revoke();
    const reopened = open();
    reopened.revoke();
  } finally {
    await host.close();
  }
  expect(open).toThrow(/unavailable/);
});
it("keeps concurrent lease purposes isolated and rejects guessed, wrong-purpose and substituted authority", async () => {
  const host = await createGenUiBrowserHost({ mode: "development" });
  const dispatched: string[] = [];
  const leases = ["tenant-a", "tenant-b"].map((tenant) =>
    host.open({
      appId: "cards",
      viewId: "board",
      generation: "1",
      controller: createGenUiController({
        document,
        callableTargets: ["cards.update", "cards.get"],
        readTargets: ["cards.get"],
        refresh: { target: "cards.get", input: {} },
        present: () => document,
        resolveAction: () => ({}),
        dispatch: (target) => {
          if (target === "cards.update") dispatched.push(tenant);
          return Promise.resolve({});
        },
      }),
      bindings: {},
      publishOutcome: () => Promise.resolve(),
    }),
  );
  const origin = new URL(leases[0]!.url).origin;
  const request = (
    path: string,
    token: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(origin + path, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  try {
    const start = new URL(leases[0]!.url).hash.slice(1);
    expect((await request("/action", start, { nodeId: "save", payload: {} })).status).toBe(404);
    expect((await request("/session", "a".repeat(43))).status).toBe(404);
    const tokens: string[] = [];
    for (const lease of leases) {
      const exchange = await request("/session", new URL(lease.url).hash.slice(1));
      expect(exchange.status).toBe(200);
      expect(exchange.headers.get("x-frame-options")).toBe("DENY");
      expect(exchange.headers.get("x-content-type-options")).toBe("nosniff");
      expect(exchange.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(exchange.headers.get("access-control-allow-origin")).toBeNull();
      tokens.push(((await exchange.json()) as { token: string }).token);
    }
    expect((await request("/session", tokens[0]!)).status).toBe(404);
    expect(
      (
        await request("/action", tokens[0]!, {
          nodeId: "save",
          payload: {},
          appId: "foreign",
          viewId: "other",
        })
      ).status,
    ).toBe(404);
    expect((await request("/action", tokens[0]!, { nodeId: "foreign", payload: {} })).status).toBe(
      404,
    );
    // Fetch may normalize/ignore Host; exercise the actual HTTP boundary.
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        origin + "/action",
        {
          method: "POST",
          headers: {
            Host: "evil.example",
            Origin: origin,
            Authorization: "Bearer " + tokens[0]!,
            "Content-Type": "application/json",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({ nodeId: "save", payload: {} }));
    });
    expect(wrongHost).toBe(404);
    expect(dispatched).toEqual([]);
    const responses = await Promise.all(
      tokens.map((token) => request("/action", token, { nodeId: "save", payload: {} })),
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(dispatched.sort()).toEqual(["tenant-a", "tenant-b"]);
    leases[0]!.revoke();
    expect((await request("/action", tokens[0]!, { nodeId: "save", payload: {} })).status).toBe(
      404,
    );
    expect((await request("/action", tokens[1]!, { nodeId: "save", payload: {} })).status).toBe(
      200,
    );
  } finally {
    await host.close();
  }
});
it("refuses production and non-loopback listeners", async () => {
  await expect(createGenUiBrowserHost({ mode: "production" })).rejects.toThrow();
  await expect(createGenUiBrowserHost({ mode: "development", host: "0.0.0.0" })).rejects.toThrow();
});
