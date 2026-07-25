/**
 * The cache, without React.
 *
 * Most of what the hooks promise is really the cache's behaviour, and it is all
 * testable as plain TypeScript — including the two properties that break silently in a
 * browser: snapshot referential stability (violate it and React re-renders forever) and
 * request dedupe (violate it and StrictMode doubles every request).
 *
 * Run: `pnpm --filter @embody/react exec vitest run`
 */
import { describe, it, expect, vi } from "vitest";
import { createQueryCache, IDLE } from "./cache.ts";
import { EmbodyError } from "./types.ts";
import { toolKey } from "./key.ts";

/** A fetcher whose resolution is controlled by the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const KEY = toolKey("crm_query_deals", { stage: "lead" });

describe("snapshots", () => {
  it("starts idle", () => {
    expect(createQueryCache().getSnapshot(KEY)).toBe(IDLE);
  });

  it("returns a stable reference until something changes", async () => {
    // The useSyncExternalStore contract. A fresh object per read is an infinite loop.
    const cache = createQueryCache();
    await cache.fetch(KEY, async () => [1]);
    const first = cache.getSnapshot(KEY);
    expect(cache.getSnapshot(KEY)).toBe(first);
    cache.set(KEY, [2]);
    expect(cache.getSnapshot(KEY)).not.toBe(first);
  });

  it("moves loading -> success and notifies subscribers", async () => {
    const cache = createQueryCache();
    const seen: string[] = [];
    cache.subscribe(KEY, () => seen.push(cache.getSnapshot(KEY).status));
    await cache.fetch(KEY, async () => "ok");
    expect(seen).toContain("loading");
    expect(cache.getSnapshot(KEY).status).toBe("success");
    expect(cache.getSnapshot(KEY).data).toBe("ok");
    expect(cache.getSnapshot(KEY).isFetching).toBe(false);
  });

  it("records a failure as an error snapshot", async () => {
    const cache = createQueryCache();
    const boom = new EmbodyError({ kind: "denied", message: "nope", status: 403 });
    await cache.fetch(KEY, async () => Promise.reject(boom)).catch(() => undefined);
    expect(cache.getSnapshot(KEY).status).toBe("error");
    expect(cache.getSnapshot(KEY).error).toBe(boom);
  });

  it("stops subscribing after unsubscribe", async () => {
    const cache = createQueryCache();
    const listener = vi.fn();
    cache.subscribe(KEY, listener)();
    await cache.fetch(KEY, async () => 1);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("dedupe", () => {
  it("runs one fetcher for concurrent requests on the same key", async () => {
    // This single behaviour is what makes StrictMode's mount/unmount/remount, and two
    // components rendering the same list, issue exactly one request.
    const cache = createQueryCache();
    const fetcher = vi.fn(async () => "one");
    const [a, b] = await Promise.all([
      cache.fetch(KEY, fetcher),
      cache.fetch(KEY, fetcher),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toBe("one");
    expect(b).toBe("one");
  });

  it("ensure() serves cached data instead of refetching", async () => {
    // What a mounting component uses. Without this, a second component reading the same
    // query — or navigating back to a route — issues another request, and "data changes
    // when you invalidate it" stops being true.
    const cache = createQueryCache();
    const fetcher = vi.fn(async () => "rows");
    await cache.ensure(KEY, fetcher);
    await cache.ensure(KEY, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("ensure() does fetch when the entry errored, so a remount retries", async () => {
    const cache = createQueryCache();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new EmbodyError({ kind: "network", message: "offline" }))
      .mockResolvedValueOnce("rows");
    await cache.ensure(KEY, fetcher as never).catch(() => undefined);
    expect(await cache.ensure(KEY, fetcher as never)).toBe("rows");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps different inputs of the same tool separate", async () => {
    const cache = createQueryCache();
    const fetcher = vi.fn(async () => "x");
    await cache.fetch(toolKey("crm_query_deals", { stage: "lead" }), fetcher);
    await cache.fetch(toolKey("crm_query_deals", { stage: "won" }), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("force bypasses the in-flight request", async () => {
    const cache = createQueryCache();
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    void cache.fetch(KEY, fetcher as never);
    const forced = cache.fetch(KEY, fetcher as never, { force: true });
    second.resolve("second");
    expect(await forced).toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("discards a superseded response", async () => {
    // The slow first request must not overwrite the fresh second one.
    const cache = createQueryCache();
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    void cache.fetch(KEY, fetcher as never);
    void cache.fetch(KEY, fetcher as never, { force: true });
    second.resolve("fresh");
    await Promise.resolve();
    first.resolve("stale");
    await new Promise((r) => setTimeout(r, 0));

    expect(cache.getSnapshot(KEY).data).toBe("fresh");
  });

  it("keeps previous data visible while revalidating", async () => {
    const cache = createQueryCache();
    await cache.fetch(KEY, async () => "first");
    const pending = deferred<string>();
    void cache.fetch(KEY, () => pending.promise, { force: true });

    const during = cache.getSnapshot(KEY);
    // No skeleton flash on refresh: status stays success, isFetching carries the spinner.
    expect(during.status).toBe("success");
    expect(during.data).toBe("first");
    expect(during.isFetching).toBe(true);

    pending.resolve("second");
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.getSnapshot(KEY).data).toBe("second");
  });

  it("does not treat an abort as an error", async () => {
    const cache = createQueryCache();
    await cache
      .fetch(KEY, async () => {
        throw new DOMException("aborted", "AbortError");
      })
      .catch(() => undefined);
    expect(cache.getSnapshot(KEY).status).not.toBe("error");
    expect(cache.getSnapshot(KEY).isFetching).toBe(false);
  });
});

describe("invalidate", () => {
  it("selects every input variant of a tool by name", async () => {
    const cache = createQueryCache();
    await cache.fetch(toolKey("crm_query_deals", { stage: "lead" }), async () => 1);
    await cache.fetch(toolKey("crm_query_deals", { stage: "won" }), async () => 2);
    await cache.fetch(toolKey("crm_get_deal", { id: "a" }), async () => 3);

    expect(cache.keysFor("crm_query_deals")).toHaveLength(2);
    expect(cache.keysFor({ key: toolKey("crm_get_deal", { id: "a" }) })).toHaveLength(1);
    expect(cache.keysFor((k) => k.startsWith("crm_"))).toHaveLength(3);
  });

  it("refetches an entry that is on screen, in place", async () => {
    const cache = createQueryCache();
    let value = "before";
    await cache.fetch(KEY, async () => value);
    cache.registerRefetch(KEY, () => cache.fetch(KEY, async () => value, { force: true }));
    cache.retain(KEY);

    value = "after";
    cache.invalidate("crm_query_deals");
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.getSnapshot(KEY).data).toBe("after");
  });

  it("drops an entry nothing is watching, so the next mount starts clean", async () => {
    const cache = createQueryCache();
    await cache.fetch(KEY, async () => "stale");
    cache.registerRefetch(KEY, async () => "never called");

    cache.invalidate("crm_query_deals");
    expect(cache.getSnapshot(KEY)).toBe(IDLE);
  });

  it("keeps data when the last subscriber leaves", async () => {
    // A remounted route should show its rows immediately, then revalidate.
    const cache = createQueryCache();
    cache.retain(KEY);
    await cache.fetch(KEY, async () => "rows");
    cache.release(KEY);
    expect(cache.getSnapshot(KEY).data).toBe("rows");
  });
});

describe("optimistic writes", () => {
  it("applies and reverts patches in reverse order", async () => {
    const cache = createQueryCache();
    const a = toolKey("crm_query_deals", {});
    const b = toolKey("crm_get_deal", { id: "1" });
    await cache.fetch(a, async () => ["original"]);
    await cache.fetch(b, async () => "original");

    const undo: Array<() => void> = [];
    for (const key of [a, b]) {
      const previous = cache.peek(key);
      cache.set(key, "optimistic");
      undo.push(() => cache.set(key, previous));
    }
    expect(cache.peek(a)).toBe("optimistic");

    for (const revert of undo.reverse()) revert();
    expect(cache.peek(a)).toEqual(["original"]);
    expect(cache.peek(b)).toBe("original");
  });
});

describe("clear", () => {
  it("drops everything and wakes subscribers", async () => {
    const cache = createQueryCache();
    await cache.fetch(KEY, async () => "rows");
    const listener = vi.fn();
    cache.subscribe(KEY, listener);

    cache.clear();

    expect(cache.getSnapshot(KEY)).toBe(IDLE);
    expect(listener).toHaveBeenCalled();
  });
});
