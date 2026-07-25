/**
 * Resolve the acting principal for a CLI/agent invocation from flags or env. Every
 * action runs as this principal, org-scoped by RLS and checked by RBAC — the CLI is
 * never a superuser back door.
 */
import type { Principal } from "@embody/kernel";
import { principalFrom } from "@embody/auth";

export interface IdentityOptions {
  org?: string;
  user?: string;
  roles?: string;
}

export function buildPrincipal(opts: IdentityOptions): Principal {
  // Parsing lives in @embody/auth so the CLI's `--roles a,b` and the HTTP bridge's
  // `x-embody-roles: a,b` can never drift. Only the missing-org message is ours.
  const principal = principalFrom({
    org: opts.org ?? process.env.EMBODY_ORG,
    user: opts.user ?? process.env.EMBODY_USER,
    roles: opts.roles ?? process.env.EMBODY_ROLES,
  });
  if (!principal) {
    throw new Error(
      "No org set. Pass --org <id> or set EMBODY_ORG. Run `embody seed` to create a dev org.",
    );
  }
  return principal;
}
