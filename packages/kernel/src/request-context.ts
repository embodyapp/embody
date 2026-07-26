/**
 * Per-request context: who is calling, for which tenant, and what they may do.
 *
 * This is distinct from KernelContext (which is per-plugin, at registration time).
 * A RequestContext is created by the api-server for each HTTP request and each MCP
 * tool call, and threaded into route/tool handlers. Both REST and MCP use the same
 * `can()` check — the single choke point for authorization (Decision D4).
 *
 * M1 ships the interface + a permissive stub. M2 wires real identity + RLS-backed
 * authorization behind the same `Authorizer` interface.
 */
import type { Sql } from "@embody/db";
import type { Logger } from "./logger.ts";

export interface Principal {
  readonly userId: string;
  readonly orgId: string;
  readonly roles: readonly string[];
  /**
   * True when the actor is the platform itself rather than a person — an outbox
   * worker dispatching a subscriber, a scheduled automation. Such an actor has no
   * `userId` (nothing to attribute to) and gets its roles from whatever configured it,
   * never from a login.
   *
   * This is a *label*, not a grant: nothing is permitted because `system` is set.
   * It exists so handlers and audit records can tell an unattributed automated write
   * from an anonymous human one, which the empty `userId` alone cannot express.
   */
  readonly system?: boolean;
}

/**
 * Runs `fn` inside a tenant-scoped transaction on the app role (RLS active). Supplied
 * by whoever builds the RequestContext (the host/executor), so the kernel never holds
 * a connection. Mirrors how routes receive a concrete `Hono` — handlers get a concrete
 * tenant `Sql` here.
 */
export type TenantRunner = <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;

/** A single `action` on a `resource`, both of which may be patterns. */
export interface Grant {
  action: string;
  resource: string;
}

/** Pluggable authorization strategy. M2 provides an RBAC implementation. */
export interface Authorizer {
  /** e.g. can("read", "crm:deal") -> boolean. */
  can(principal: Principal, action: string, resource: string): boolean;
  /**
   * What a principal holding exactly `roles` would be permitted.
   *
   * This is the question any *delegation* has to ask: an automation that runs as
   * `["member"]`, a scheduled job, an API token with a role attached. Checking that
   * the requested role *names* are a subset of the creator's is the obvious thing and
   * it is wrong in both directions — it forbids an owner from creating a narrower
   * `member` workflow (de-escalation, the safe direction) while telling you nothing
   * about what those roles actually permit. Comparing grants answers the real
   * question: can the delegate do anything its creator cannot?
   *
   * Optional: an authorizer that cannot enumerate its policy returns undefined, and
   * callers must then fall back to a conservative check.
   */
  grantsForRoles?(roles: readonly string[]): Grant[] | undefined;
}

export interface RequestContext {
  readonly principal: Principal;
  readonly orgId: string;
  readonly logger: Logger;
  /** Authorization check used by every REST route and MCP tool. */
  can(action: string, resource: string): boolean;
  /** Throwing variant: raises AuthorizationError when not permitted. */
  assert(action: string, resource: string): void;
  /**
   * Throw unless everything `roles` would permit is also permitted to this caller.
   *
   * The delegation guard: use it wherever a caller names a role for something else to
   * run as later (an automation, a scheduled job, a token), so nobody can mint
   * authority they do not hold. De-escalation stays legal — an owner may create a
   * viewer-scoped automation.
   */
  assertMayDelegate(roles: readonly string[]): void;
  /**
   * Run `fn` in a tenant-scoped transaction on the app role (RLS enforces the org).
   * This is how REST routes and MCP tools read/write data — never a raw connection.
   */
  tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

/** Raised when a caller tries to delegate authority it does not hold. */
export class DelegationError extends Error {
  constructor(public readonly excess: readonly Grant[], held: readonly string[]) {
    super(
      `Cannot delegate permissions you do not hold: ` +
        excess.map((g) => `${g.action} ${g.resource}`).join(", ") +
        `. Your roles are [${held.join(", ")}].`,
    );
    this.name = "DelegationError";
  }
}

export class AuthorizationError extends Error {
  constructor(action: string, resource: string) {
    super(`Not authorized to ${action} ${resource}`);
    this.name = "AuthorizationError";
  }
}

/**
 * Build a RequestContext from a principal + an authorizer + a tenant runner. The
 * runner (from the host/executor) binds `tx` to a `withTenant` transaction for this
 * principal's org, so handlers get RLS-enforced data access with no connection of
 * their own.
 */
export function createRequestContext(
  principal: Principal,
  authorizer: Authorizer,
  logger: Logger,
  runTenant: TenantRunner,
): RequestContext {
  const can = (action: string, resource: string) =>
    authorizer.can(principal, action, resource);
  return {
    principal,
    orgId: principal.orgId,
    logger: logger.child({ orgId: principal.orgId, userId: principal.userId }),
    can,
    assert(action, resource) {
      if (!can(action, resource)) throw new AuthorizationError(action, resource);
    },
    assertMayDelegate(roles) {
      const grants = authorizer.grantsForRoles?.(roles);
      if (!grants) {
        // The authorizer cannot enumerate its policy, so fall back to the only check
        // that is safe without knowing what a role means: the names must be ones the
        // caller already holds. Stricter than necessary, never wrong.
        const held = new Set(principal.roles);
        const unknown = roles.filter((r) => !held.has(r));
        if (unknown.length > 0) {
          throw new DelegationError(
            unknown.map((r) => ({ action: "*", resource: `role:${r}` })),
            principal.roles,
          );
        }
        return;
      }
      const excess = grants.filter((g) => !can(g.action, g.resource));
      if (excess.length > 0) throw new DelegationError(excess, principal.roles);
    },
    tx: runTenant,
  };
}

/**
 * A permissive authorizer for M1 / local dev only. Grants everything. Replaced by a
 * real RBAC authorizer in M2. Never ship this to production.
 */
export class AllowAllAuthorizer implements Authorizer {
  can(): boolean {
    return true;
  }
}
