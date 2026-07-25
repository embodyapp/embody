/**
 * A small query cache built on `useSyncExternalStore`'s contract.
 *
 * Deliberately not react-query: the framework should not push a state library onto
 * every consumer, and what a tool bridge needs is narrow — dedupe, invalidate, and
 * optimistic writes that roll back when a domain rule refuses. That fits in one file.
 *
 * Two rules carry the whole design:
 *
 *   1. **Snapshots are frozen and only ever rebuilt in `commit`.** `getSnapshot` must
 *      return a referentially stable value or React re-renders forever. Every read
 *      hands back the same object until something actually changes.
 *   2. **Nothing is aborted on unmount.** React 18/19 StrictMode mounts, unmounts and
 *      remounts every effect in development; aborting on unmount would cancel the very
 *      request the remount needs. Correctness comes instead from key-addressed writes
 *      (a response can only land in its own entry) plus a per-entry generation counter
 *      that drops superseded responses.
 *
 * Data changes when you invalidate it. No staleTime, no refetch-on-focus, no polling —
 * one rule, and when durable events (M3) arrive, an SSE feed calling `invalidate(tool)`
 * gives live updates with no change to any hook signature.
 */
import { EmbodyError } from "./types.ts";
import type { QueryStatus } from "./types.ts";
import { toolOfKey } from "./key.ts";

export interface Snapshot<T = unknown> {
  readonly data: T | undefined;
  readonly error: EmbodyError | undefined;
  readonly status: QueryStatus;
  /** A request is in flight. Can be true while `data` from a previous fetch shows. */
  readonly isFetching: boolean;
}

export const IDLE: Snapshot = Object.freeze({
  data: undefined,
  error: undefined,
  status: "idle" as const,
  isFetching: false,
});

interface Entry {
  key: string;
  data: unknown;
  error: EmbodyError | undefined;
  status: QueryStatus;
  isFetching: boolean;
  /** Generation counter: a response whose id is stale is discarded. */
  seq: number;
  /** The in-flight promise. Its presence IS the dedupe. */
  promise: Promise<unknown> | undefined;
  controller: AbortController | undefined;
  subscribers: number;
  updatedAt: number;
}

export type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

/** What `invalidate` accepts: a tool name, an exact key, or a predicate. */
export type InvalidateTarget = string | { key: string } | ((key: string) => boolean);

export interface QueryCache {
  getSnapshot<T>(key: string): Snapshot<T>;
  subscribe(key: string, listener: () => void): () => void;
  /** Fetch unless an identical request is already in flight. */
  fetch<T>(key: string, fetcher: Fetcher<T>, opts?: { force?: boolean }): Promise<T>;
  /**
   * Fetch only if this key has no data yet. What a mounting component wants: a second
   * component reading the same query, or a route the user navigates back to, shows what
   * is already there instead of issuing another request.
   */
  ensure<T>(key: string, fetcher: Fetcher<T>): Promise<T>;
  /** Replace an entry's data directly (optimistic writes, or a known-fresh result). */
  set(key: string, data: unknown): void;
  /** Read an entry's data without subscribing. */
  peek<T>(key: string): T | undefined;
  /** Which live keys a target selects. */
  keysFor(target: InvalidateTarget): string[];
  /**
   * Mark entries stale. Watched entries refetch in place, keeping their current data
   * visible; unwatched ones are dropped so the next mount starts clean.
   */
  invalidate(target: InvalidateTarget, refetch?: (key: string) => Promise<unknown>): void;
  /** Register a way to refetch a key, so `invalidate` can revalidate it later. */
  registerRefetch(key: string, refetch: () => Promise<unknown>): void;
  retain(key: string): void;
  release(key: string): void;
  /** Drop everything and abort in-flight work (sign-out). */
  clear(): void;
}

const isAbort = (err: unknown): boolean =>
  err instanceof DOMException ? err.name === "AbortError" : (err as { name?: string })?.name === "AbortError";

export function createQueryCache(): QueryCache {
  const entries = new Map<string, Entry>();
  const snapshots = new Map<string, Snapshot>();
  const listeners = new Map<string, Set<() => void>>();
  const refetchers = new Map<string, () => Promise<unknown>>();

  const entryFor = (key: string): Entry => {
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key,
        data: undefined,
        error: undefined,
        status: "idle",
        isFetching: false,
        seq: 0,
        promise: undefined,
        controller: undefined,
        subscribers: 0,
        updatedAt: 0,
      };
      entries.set(key, entry);
    }
    return entry;
  };

  /** The ONLY place a snapshot identity changes. */
  const commit = (key: string, patch: Partial<Entry>): void => {
    const entry = Object.assign(entryFor(key), patch);
    snapshots.set(
      key,
      Object.freeze({
        data: entry.data,
        error: entry.error,
        status: entry.status,
        isFetching: entry.isFetching,
      }),
    );
    const set = listeners.get(key);
    if (set) for (const listener of set) listener();
  };

  const drop = (key: string): void => {
    entries.get(key)?.controller?.abort();
    entries.delete(key);
    snapshots.delete(key);
    refetchers.delete(key);
  };

  return {
    getSnapshot<T>(key: string): Snapshot<T> {
      return (snapshots.get(key) ?? IDLE) as Snapshot<T>;
    },

    subscribe(key, listener) {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },

    async fetch<T>(key: string, fetcher: Fetcher<T>, opts?: { force?: boolean }): Promise<T> {
      const entry = entryFor(key);
      // One request per key in flight. This is what makes StrictMode's double mount —
      // and two components rendering the same list — issue a single fetch.
      if (entry.promise && !opts?.force) return entry.promise as Promise<T>;

      // A forced fetch supersedes whatever is running; the loser is dropped by seq.
      const id = ++entry.seq;
      const controller = new AbortController();
      const hasData = entry.status === "success";
      commit(key, {
        isFetching: true,
        // Keep showing what we have: a refresh should not flash a skeleton.
        status: hasData ? "success" : "loading",
        controller,
        error: hasData ? entry.error : undefined,
      });

      const promise = (async () => {
        try {
          const data = await fetcher(controller.signal);
          if (entries.get(key)?.seq === id) {
            commit(key, {
              data,
              error: undefined,
              status: "success",
              isFetching: false,
              promise: undefined,
              controller: undefined,
              updatedAt: Date.now(),
            });
          }
          return data;
        } catch (err) {
          if (entries.get(key)?.seq === id) {
            if (isAbort(err)) {
              // Aborting is a caller's decision, not a failure state.
              commit(key, { isFetching: false, promise: undefined, controller: undefined });
            } else {
              commit(key, {
                error:
                  err instanceof EmbodyError
                    ? err
                    : new EmbodyError({
                        kind: "internal",
                        message: err instanceof Error ? err.message : String(err),
                      }),
                status: "error",
                isFetching: false,
                promise: undefined,
                controller: undefined,
              });
            }
          }
          throw err;
        }
      })();

      commit(key, { promise });
      return promise;
    },

    async ensure<T>(key: string, fetcher: Fetcher<T>): Promise<T> {
      const entry = entries.get(key);
      if (entry?.status === "success" && !entry.promise) return entry.data as T;
      return this.fetch(key, fetcher);
    },

    set(key, data) {
      commit(key, { data, error: undefined, status: "success", updatedAt: Date.now() });
    },

    peek<T>(key: string): T | undefined {
      return entries.get(key)?.data as T | undefined;
    },

    keysFor(target) {
      if (typeof target === "function") return [...entries.keys()].filter(target);
      if (typeof target === "object") return entries.has(target.key) ? [target.key] : [];
      // A bare string is a tool name: invalidate every input variant of that query.
      return [...entries.keys()].filter((key) => toolOfKey(key) === target || key === target);
    },

    invalidate(target) {
      for (const key of this.keysFor(target)) {
        const entry = entries.get(key);
        if (!entry) continue;
        const refetch = refetchers.get(key);
        if (entry.subscribers > 0 && refetch) {
          // Something is on screen: revalidate underneath it. `data` stays visible and
          // `isFetching` carries the spinner, so a list does not blink on every write.
          void refetch().catch(() => {
            // The error is already on the entry; nothing to do with the rejection.
          });
        } else {
          drop(key);
        }
      }
    },

    registerRefetch(key, refetch) {
      refetchers.set(key, refetch);
    },

    retain(key) {
      entryFor(key).subscribers += 1;
    },

    release(key) {
      const entry = entries.get(key);
      if (!entry) return;
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      // Data is kept when the last subscriber leaves: remounting a route should show
      // its previous rows immediately, then revalidate.
    },

    clear() {
      for (const key of [...entries.keys()]) {
        drop(key);
        // Wake anything still mounted so it re-renders as idle.
        const set = listeners.get(key);
        if (set) for (const listener of set) listener();
      }
    },
  };
}
