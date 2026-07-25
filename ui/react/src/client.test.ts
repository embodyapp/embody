/**
 * The transport, against an injected fetch. What matters here is that every failure
 * mode the bridge can produce arrives as a value a UI can branch on — especially the
 * two the server cannot tell you about: a request that never arrived, and a response
 * that isn't JSON at all.
 *
 * Run: `pnpm --filter @embody/react exec vitest run`
 */
import { describe, it, expect, vi } from "vitest";
import { createEmbodyClient } from "./client.ts";
import { EmbodyError } from "./types.ts";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that always answers the same way, recording what it was asked. */
function fakeFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

describe("createEmbodyClient.call", () => {
  it("posts the input envelope and unwraps the result", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ result: [{ id: "deal-1" }] }));
    const client = createEmbodyClient({ fetch: fn });

    const result = await client.call("crm_query_deals", { stage: "lead" } as never);

    expect(result).toEqual([{ id: "deal-1" }]);
    expect(calls[0]?.url).toBe("/api/tools/crm_query_deals");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ input: { stage: "lead" } });
    // Required by the bridge's CSRF check, and how the session cookie travels.
    expect((calls[0]?.init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    expect(calls[0]?.init?.credentials).toBe("same-origin");
  });

  it("sends {} when no input is given", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ result: null }));
    await createEmbodyClient({ fetch: fn }).call("crm_query_deals");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ input: {} });
  });

  it("honours a custom baseUrl and per-request headers", async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse({ result: 1 }));
    const client = createEmbodyClient({
      fetch: fn,
      baseUrl: "http://localhost:3100/api/",
      headers: () => ({ "x-embody-org": "org-1" }),
    });
    await client.call("crm_query_deals");
    expect(calls[0]?.url).toBe("http://localhost:3100/api/tools/crm_query_deals");
    expect((calls[0]?.init?.headers as Record<string, string>)["x-embody-org"]).toBe("org-1");
  });

  it("turns each error kind into a typed EmbodyError", async () => {
    const cases: Array<[number, string]> = [
      [400, "invalid_input"],
      [401, "unauthenticated"],
      [403, "denied"],
      [404, "not_found"],
      [409, "veto"],
      [500, "internal"],
    ];
    for (const [status, kind] of cases) {
      const { fn } = fakeFetch(() =>
        jsonResponse({ error: { kind, message: `it was ${kind}`, tool: "t" } }, status),
      );
      const err = await createEmbodyClient({ fetch: fn })
        .call("t")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmbodyError);
      expect((err as EmbodyError).kind).toBe(kind);
      expect((err as EmbodyError).status).toBe(status);
      expect((err as EmbodyError).tool).toBe("t");
    }
  });

  it("carries a veto's message and details through untouched", async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse(
        {
          error: {
            kind: "veto",
            message: "Enterprise deals over $50,000 require an approved Security Review.",
            details: { hook: "crm.deal.beforeUpdate", plugin: "b2b-saas" },
          },
        },
        409,
      ),
    );
    const err = (await createEmbodyClient({ fetch: fn })
      .call("crm_update_deal")
      .catch((e: unknown) => e)) as EmbodyError;
    // A UI shows this string to a user verbatim — that is the whole point.
    expect(err.message).toMatch(/Security Review/);
    expect(err.isVeto).toBe(true);
    expect(err.details).toEqual({ hook: "crm.deal.beforeUpdate", plugin: "b2b-saas" });
  });

  it("falls back to the status when the body is not the expected JSON", async () => {
    // A dead proxy answers with HTML; the client must still produce a usable error.
    const { fn } = fakeFetch(() => new Response("<html>502</html>", { status: 403 }));
    const err = (await createEmbodyClient({ fetch: fn })
      .call("t")
      .catch((e: unknown) => e)) as EmbodyError;
    expect(err.kind).toBe("denied");
    expect(err.status).toBe(403);
  });

  it("reports a request that never reached the server as `network`", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    const err = (await createEmbodyClient({ fetch: fn })
      .call("t")
      .catch((e: unknown) => e)) as EmbodyError;
    expect(err.kind).toBe("network");
    expect(err.status).toBe(0);
  });

  it("lets an abort through unchanged, so it is not mistaken for a failure", async () => {
    const fn = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof globalThis.fetch;
    const err = await createEmbodyClient({ fetch: fn })
      .call("t")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
  });
});

describe("identity and catalogue", () => {
  it("reports an anonymous caller as null, not as an error", async () => {
    // Being signed out is an ordinary state — it is what a login screen is for.
    const { fn } = fakeFetch(() => jsonResponse({ error: { kind: "unauthenticated" } }, 401));
    expect(await createEmbodyClient({ fetch: fn }).me()).toBeNull();
  });

  it("returns the identity when signed in", async () => {
    const identity = {
      principal: { orgId: "o", userId: "u", roles: ["viewer"] },
      permissions: [{ action: "read", resource: "*" }],
      source: "session",
    };
    const { fn } = fakeFetch(() => jsonResponse(identity));
    expect(await createEmbodyClient({ fetch: fn }).me()).toEqual(identity);
  });

  it("unwraps the tool catalogue", async () => {
    const { fn } = fakeFetch(() =>
      jsonResponse({ tools: [{ name: "crm_query_deals", description: "", inputSchema: {} }] }),
    );
    const tools = await createEmbodyClient({ fetch: fn }).tools();
    expect(tools.map((t) => t.name)).toEqual(["crm_query_deals"]);
  });

  it("accepts 204 from logout", async () => {
    const { fn } = fakeFetch(() => new Response(null, { status: 204 }));
    await expect(createEmbodyClient({ fetch: fn }).logout()).resolves.toBeUndefined();
  });
});
