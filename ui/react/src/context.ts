/**
 * The provider.
 *
 * No JSX anywhere in this package — `createElement` costs one call and removes any
 * dependence on the consumer's bundler picking up our `jsx` setting. Nothing here
 * touches `window` or `document` either, so a server render produces a loading state
 * rather than a crash.
 */
import { createContext, createElement, useContext, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { createEmbodyClient, type EmbodyClient } from "./client.ts";
import { createQueryCache, type QueryCache } from "./cache.ts";

export interface EmbodyContextValue {
  client: EmbodyClient;
  cache: QueryCache;
  /** True when the provider should fetch `/api/me` on mount. */
  loadIdentity: boolean;
}

const EmbodyContext = createContext<EmbodyContextValue | null>(null);

export interface EmbodyProviderProps {
  children?: ReactNode;
  /** Supply a client to control transport, headers, or to inject a fake in tests. */
  client?: EmbodyClient;
  /** Convenience when no client is given. Defaults to "/api". */
  baseUrl?: string;
  /** Fetch the caller's identity on mount. Default true. */
  loadIdentity?: boolean;
}

export function EmbodyProvider(props: EmbodyProviderProps): ReactElement {
  // A lazy useState initializer, NOT useMemo: React is allowed to throw memo results
  // away, and re-creating the cache would silently orphan every live subscription.
  const [value] = useState<EmbodyContextValue>(() => ({
    client: props.client ?? createEmbodyClient({ ...(props.baseUrl ? { baseUrl: props.baseUrl } : {}) }),
    cache: createQueryCache(),
    loadIdentity: props.loadIdentity ?? true,
  }));

  return createElement(EmbodyContext.Provider, { value }, props.children);
}

export function useEmbodyContext(): EmbodyContextValue {
  const value = useContext(EmbodyContext);
  if (!value) {
    throw new Error(
      "No EmbodyProvider found. Wrap your app in <EmbodyProvider> from @embody/react.",
    );
  }
  return value;
}

export interface UseEmbody {
  client: EmbodyClient;
  cache: QueryCache;
}

/** The client and cache, for imperative work outside the hooks. */
export function useEmbody(): UseEmbody {
  const { client, cache } = useEmbodyContext();
  return { client, cache };
}
