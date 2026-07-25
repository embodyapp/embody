/**
 * Client-side permission matching.
 *
 * A deliberate four-line duplicate of `patternMatches` in
 * `framework/auth/src/authorizer.ts` — importing @embody/auth would drag @embody/kernel,
 * hono and postgres into the browser bundle to answer a string-prefix question. The
 * cost of the copy is one test that mirrors the server's cases exactly
 * (`can.test.ts` ↔ `framework/auth/src/authorizer.test.ts`); if the server's matching
 * ever grows real syntax, that pair fails together.
 *
 * This is an AFFORDANCE, never a decision. It exists so a button can be disabled before
 * the user clicks it. The server re-checks every call, and a client that lies to itself
 * only reaches its 403 a moment later.
 */
import type { Permission } from "./types.ts";

function patternMatches(pattern: string, value: string): boolean {
  if (pattern === "*" || pattern === value) return true;
  if (pattern.endsWith(":*")) return value.startsWith(pattern.slice(0, -1));
  return false;
}

/** True when any granted permission covers `action` on `resource`. */
export function matchesPermission(
  permissions: readonly Permission[],
  action: string,
  resource: string,
): boolean {
  for (const g of permissions) {
    if (patternMatches(g.action, action) && patternMatches(g.resource, resource)) return true;
  }
  return false;
}
