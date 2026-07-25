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
}

/**
 * Runs `fn` inside a tenant-scoped transaction on the app role (RLS active). Supplied
 * by whoever builds the RequestContext (the host/executor), so the kernel never holds
 * a connection. Mirrors how routes receive a concrete `Hono` — handlers get a concrete
 * tenant `Sql` here.
 */
export type TenantRunner = <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;

/** Pluggable authorization strategy. M2 provides an RBAC implementation. */
export interface Authorizer {
  /** e.g. can("read", "crm:deal") -> boolean. */
  can(principal: Principal, action: string, resource: string): boolean;
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
   * Run `fn` in a tenant-scoped transaction on the app role (RLS enforces the org).
   * This is how REST routes and MCP tools read/write data — never a raw connection.
   */
  tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
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
