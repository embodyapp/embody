/**
 * The two hooks a page actually uses: read a tool, and call a tool.
 *
 * Both go through the host's `/api/tools/:name` bridge, which runs the same executor as
 * MCP and the CLI — so a rule registered by another plugin (including a company's own,
 * under `custom/`) refuses a write from this UI without the UI knowing that rule exists.
 * That arrives here as `error.kind === "veto"`, with the rule's own message.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EmbodyError } from "./types.ts";
import type { InputOf, OutputOf, QueryStatus, Result, ToolName } from "./types.ts";
import { toolKey } from "./key.ts";
import { useEmbodyContext } from "./context.ts";
import { IDENTITY_KEY } from "./key.ts";
import type { InvalidateTarget } from "./cache.ts";

export interface UseToolQueryOptions {
  /** Skip the request (e.g. an id isn't known yet). Default true. */
  enabled?: boolean;
}

export interface UseToolQueryResult<T> {
  data: T | undefined;
  error: EmbodyError | undefined;
  status: QueryStatus;
  /** A request is in flight. True during a background revalidate, when data still shows. */
  isFetching: boolean;
  refetch: () => Promise<void>;
}

/**
 * Read a tool's result, cached by (tool, input).
 *
 * Named `useToolQuery` rather than `useQuery` so it reads unambiguously in a codebase
 * that also uses react-query.
 */
export function useToolQuery<N extends ToolName>(
  name: N,
  input?: InputOf<N>,
  opts: UseToolQueryOptions = {},
): UseToolQueryResult<OutputOf<N>> {
  const { client, cache } = useEmbodyContext();
  const enabled = opts.enabled ?? true;
  const key = toolKey(name, input);

  // The input is captured per key, so a fetch triggered by an invalidate always sends
  // the arguments that key stands for.
  const run = useCallback(
    (force: boolean) => {
      const fetcher = (signal: AbortSignal) => client.call(name, input as never, { signal });
      // Mounting reuses what is already cached; only an explicit refetch or an
      // invalidation goes back to the server.
      return force ? cache.fetch(key, fetcher, { force: true }) : cache.ensure(key, fetcher);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` encodes `input`.
    [cache, client, key, name],
  );

  useEffect(() => {
    cache.registerRefetch(key, () => run(true));
  }, [cache, key, run]);

  useEffect(() => {
    if (!enabled) return;
    cache.retain(key);
    void run(false).catch(() => {
      // Failure lives on the cache entry; a rejection here would be unhandled.
    });
    return () => cache.release(key);
  }, [cache, enabled, key, run]);

  const snapshot = useSyncExternalStore(
    useCallback((listener) => cache.subscribe(key, listener), [cache, key]),
    () => cache.getSnapshot<OutputOf<N>>(key),
    // Server render: idle. This package never fetches during SSR.
    () => cache.getSnapshot<OutputOf<N>>(key),
  );

  const refetch = useCallback(async () => {
    await run(true).catch(() => undefined);
  }, [run]);

  return {
    data: snapshot.data,
    error: snapshot.error,
    status: enabled ? snapshot.status : "idle",
    isFetching: snapshot.isFetching,
    refetch,
  };
}

export interface OptimisticTx {
  /**
   * Patch a cached read before the server answers. Every patch is recorded and undone
   * automatically if the call fails.
   */
  patch<T = unknown>(target: InvalidateTarget, updater: (previous: T | undefined) => T): void;
}

export interface UseToolMutationOptions<N extends ToolName> {
  /** Queries to revalidate once the write lands. Usually the list this row is in. */
  invalidates?: readonly InvalidateTarget[];
  /** Apply an optimistic patch. Rolled back automatically on failure. */
  optimistic?: (input: InputOf<N>, tx: OptimisticTx) => void;
  onSuccess?: (data: OutputOf<N>, input: InputOf<N>) => void;
  onError?: (error: EmbodyError, input: InputOf<N>) => void;
}

export interface UseToolMutationResult<N extends ToolName> {
  /** Run the mutation. Resolves with a Result — it never rejects. */
  mutate: (input: InputOf<N>) => Promise<Result<OutputOf<N>>>;
  status: QueryStatus;
  error: EmbodyError | undefined;
  data: OutputOf<N> | undefined;
  reset: () => void;
}

/** Call a tool that changes something, with optional optimistic UI. */
export function useToolMutation<N extends ToolName>(
  name: N,
  opts: UseToolMutationOptions<N> = {},
): UseToolMutationResult<N> {
  const { client, cache } = useEmbodyContext();
  const [state, setState] = useState<{
    status: QueryStatus;
    error: EmbodyError | undefined;
    data: OutputOf<N> | undefined;
  }>({ status: "idle", error: undefined, data: undefined });

  // Callbacks change every render in normal usage; reading them through a ref keeps
  // `mutate` stable so it can sit in a dependency array.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // A mutation started before unmount must still invalidate and roll back; only the
  // setState is skipped.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const mutate = useCallback(
    async (input: InputOf<N>): Promise<Result<OutputOf<N>>> => {
      const { invalidates, optimistic, onSuccess, onError } = optsRef.current;
      const undo: Array<() => void> = [];

      if (optimistic) {
        optimistic(input, {
          patch(target, updater) {
            for (const key of cache.keysFor(target)) {
              const previous = cache.peek(key);
              cache.set(key, updater(previous as never));
              undo.push(() => cache.set(key, previous));
            }
          },
        });
      }

      if (mounted.current) setState({ status: "loading", error: undefined, data: undefined });

      try {
        const data = (await client.call(name, input as never)) as OutputOf<N>;
        // Server truth replaces the guess.
        for (const target of invalidates ?? []) cache.invalidate(target);
        if (mounted.current) setState({ status: "success", error: undefined, data });
        onSuccess?.(data, input);
        return { ok: true, data };
      } catch (err) {
        // Reverse order, so overlapping patches unwind the way they were applied.
        for (const revert of undo.reverse()) revert();
        const error =
          err instanceof EmbodyError
            ? err
            : new EmbodyError({
                kind: "internal",
                message: err instanceof Error ? err.message : String(err),
                tool: name,
              });
        // A rejected write because the session died should send the UI back to a login
        // state without every caller remembering to check for it.
        if (error.kind === "unauthenticated") cache.invalidate({ key: IDENTITY_KEY });
        if (mounted.current) setState({ status: "error", error, data: undefined });
        onError?.(error, input);
        return { ok: false, error };
      }
    },
    [cache, client, name],
  );

  const reset = useCallback(
    () => setState({ status: "idle", error: undefined, data: undefined }),
    [],
  );

  return { mutate, status: state.status, error: state.error, data: state.data, reset };
}

/**
 * The imperative escape hatch: call a tool with no caching and no state.
 *
 * For one-offs — a CSV export, a dropdown's lookup inside an existing handler — where a
 * cache entry would be noise. Rejects with an EmbodyError.
 */
export function useTool<N extends ToolName>(
  name: N,
): (input?: InputOf<N>, opts?: { signal?: AbortSignal }) => Promise<OutputOf<N>> {
  const { client } = useEmbodyContext();
  return useCallback(
    (input, callOpts) => client.call(name, input as never, callOpts) as Promise<OutputOf<N>>,
    [client, name],
  );
}
