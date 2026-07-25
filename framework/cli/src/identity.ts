/**
 * Resolve the acting principal for a CLI/agent invocation from flags or env. Every
 * action runs as this principal, org-scoped by RLS and checked by RBAC — the CLI is
 * never a superuser back door.
 */
import type { Principal } from "@embody/kernel";

export interface IdentityOptions {
  org?: string;
  user?: string;
  roles?: string;
}

export function buildPrincipal(opts: IdentityOptions): Principal {
  const orgId = opts.org ?? process.env.EMBODY_ORG;
  const userId = opts.user ?? process.env.EMBODY_USER ?? "";
  const roles = (opts.roles ?? process.env.EMBODY_ROLES ?? "owner")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (!orgId) {
    throw new Error(
      "No org set. Pass --org <id> or set EMBODY_ORG. Run `embody seed` to create a dev org.",
    );
  }
  return { orgId, userId, roles };
}
