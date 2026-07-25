/**
 * Who the user is, and what the UI should let them try.
 *
 * Identity rides the same cache as tool reads (under the reserved `@me` key), so it
 * gets dedupe and invalidation for free: signing in or out invalidates one key and
 * every consumer re-renders.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { EmbodyError, Identity, Principal, QueryStatus, Result } from "./types.ts";
import { EmbodyError as EmbodyErrorClass } from "./types.ts";
import { IDENTITY_KEY } from "./key.ts";
import { useEmbodyContext } from "./context.ts";
import { matchesPermission } from "./can.ts";

export interface UseIdentityResult {
  identity: Identity | null | undefined;
  principal: Principal | null;
  status: QueryStatus;
  error: EmbodyError | undefined;
  /** Signed in and known. */
  isAuthenticated: boolean;
  refresh: () => Promise<void>;
  login: (body: { orgId: string; userId: string; roles?: string[] }) => Promise<Result<Identity>>;
  logout: () => Promise<void>;
}

/**
 * The caller's identity and effective grants.
 *
 * `identity` is `undefined` while loading and `null` when anonymous — the distinction
 * matters, because rendering a login form during the first fetch makes a signed-in user
 * see a flash of the login screen on every page load.
 */
export function useIdentity(): UseIdentityResult {
  const { client, cache, loadIdentity } = useEmbodyContext();

  const run = useCallback(
    (force: boolean) => {
      const fetcher = (signal: AbortSignal) => client.me({ signal });
      // Every useCan() is another subscriber to this one key; only the first fetches.
      return force
        ? cache.fetch(IDENTITY_KEY, fetcher, { force: true })
        : cache.ensure(IDENTITY_KEY, fetcher);
    },
    [cache, client],
  );

  useEffect(() => {
    cache.registerRefetch(IDENTITY_KEY, () => run(true));
  }, [cache, run]);

  useEffect(() => {
    if (!loadIdentity) return;
    cache.retain(IDENTITY_KEY);
    void run(false).catch(() => undefined);
    return () => cache.release(IDENTITY_KEY);
  }, [cache, loadIdentity, run]);

  const snapshot = useSyncExternalStore(
    useCallback((listener) => cache.subscribe(IDENTITY_KEY, listener), [cache]),
    () => cache.getSnapshot<Identity | null>(IDENTITY_KEY),
    () => cache.getSnapshot<Identity | null>(IDENTITY_KEY),
  );

  const login = useCallback(
    async (body: { orgId: string; userId: string; roles?: string[] }): Promise<Result<Identity>> => {
      try {
        const identity = await client.login(body);
        cache.set(IDENTITY_KEY, identity);
        return { ok: true, data: identity };
      } catch (err) {
        const error =
          err instanceof EmbodyErrorClass
            ? err
            : new EmbodyErrorClass({
                kind: "internal",
                message: err instanceof Error ? err.message : String(err),
              });
        return { ok: false, error };
      }
    },
    [cache, client],
  );

  const logout = useCallback(async () => {
    await client.logout().catch(() => undefined);
    // Everything in the cache was read as the previous principal.
    cache.clear();
    cache.set(IDENTITY_KEY, null);
  }, [cache, client]);

  const identity = snapshot.data;
  return {
    identity,
    principal: identity ? identity.principal : null,
    status: snapshot.status,
    error: snapshot.error,
    isAuthenticated: Boolean(identity),
    refresh: useCallback(async () => {
      await run(true).catch(() => undefined);
    }, [run]),
    login,
    logout,
  };
}

/** Just the principal, for the common case. */
export function usePrincipal(): Principal | null {
  return useIdentity().principal;
}

/**
 * Whether the UI should offer this action.
 *
 * An affordance, not a decision: the server re-checks every call, so a wrong `true`
 * only means the user meets a 403 instead of a disabled button. Returns false while
 * identity is still loading — better a control that enables a moment late than one that
 * flickers from enabled to disabled.
 */
export function useCan(action: string, resource: string): boolean {
  const { identity } = useIdentity();
  return identity ? matchesPermission(identity.permissions, action, resource) : false;
}
