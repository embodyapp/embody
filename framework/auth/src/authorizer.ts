/**
 * Role-based authorization. Implements the kernel's `Authorizer` interface so it can
 * be plugged into the request context. Every REST route and every MCP tool calls
 * `ctx.can(action, resource)`, which lands here (Decision D4).
 *
 * Permissions are namespaced `resource` strings (e.g. "crm:deal") + an `action`
 * ("read" | "write" | "delete" | ...). Patterns support a trailing ":*" wildcard and
 * a bare "*".
 */
import type { Authorizer, Principal } from "@embody/kernel";

export interface Permission {
  action: string;
  resource: string;
}

export type RolePolicy = Record<string, Permission[]>;

/** Default policy. Deployments can supply their own. */
export const defaultPolicy: RolePolicy = {
  owner: [{ action: "*", resource: "*" }],
  admin: [{ action: "*", resource: "*" }],
  member: [
    { action: "read", resource: "*" },
    { action: "write", resource: "*" },
  ],
  viewer: [{ action: "read", resource: "*" }],
};

function patternMatches(pattern: string, value: string): boolean {
  if (pattern === "*" || pattern === value) return true;
  if (pattern.endsWith(":*")) return value.startsWith(pattern.slice(0, -1));
  return false;
}

export class RbacAuthorizer implements Authorizer {
  constructor(private readonly policy: RolePolicy = defaultPolicy) {}

  can(principal: Principal, action: string, resource: string): boolean {
    for (const role of principal.roles) {
      const grants = this.policy[role];
      if (!grants) continue;
      for (const g of grants) {
        if (patternMatches(g.action, action) && patternMatches(g.resource, resource)) {
          return true;
        }
      }
    }
    return false;
  }
}
