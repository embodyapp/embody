/**
 * What this deployment can do.
 *
 * The tool list is not decoration: apps are selected per deployment, and a company's
 * own plugin under `custom/` contributes tools exactly like a first-party one. A UI
 * that reads this renders new capabilities — including ones it was never written
 * against — without a redeploy of the UI.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { EmbodyError, QueryStatus, ToolDescriptor } from "./types.ts";
import { CATALOGUE_KEY } from "./key.ts";
import { useEmbodyContext } from "./context.ts";

export interface UseToolsResult {
  tools: ToolDescriptor[] | undefined;
  status: QueryStatus;
  error: EmbodyError | undefined;
  refetch: () => Promise<void>;
}

export function useTools(): UseToolsResult {
  const { client, cache } = useEmbodyContext();

  const run = useCallback(
    (force: boolean) => {
      const fetcher = (signal: AbortSignal) => client.tools({ signal });
      return force
        ? cache.fetch(CATALOGUE_KEY, fetcher, { force: true })
        : cache.ensure(CATALOGUE_KEY, fetcher);
    },
    [cache, client],
  );

  useEffect(() => {
    cache.registerRefetch(CATALOGUE_KEY, () => run(true));
  }, [cache, run]);

  useEffect(() => {
    cache.retain(CATALOGUE_KEY);
    void run(false).catch(() => undefined);
    return () => cache.release(CATALOGUE_KEY);
  }, [cache, run]);

  const snapshot = useSyncExternalStore(
    useCallback((listener) => cache.subscribe(CATALOGUE_KEY, listener), [cache]),
    () => cache.getSnapshot<ToolDescriptor[]>(CATALOGUE_KEY),
    () => cache.getSnapshot<ToolDescriptor[]>(CATALOGUE_KEY),
  );

  return {
    tools: snapshot.data,
    status: snapshot.status,
    error: snapshot.error,
    refetch: useCallback(async () => {
      await run(true).catch(() => undefined);
    }, [run]),
  };
}
