/**
 * Building a Principal from loose string inputs — CLI flags, env vars, HTTP headers.
 *
 * Every transport that lets a human or a script *say* who they are converges here, so
 * `--roles owner,viewer` on the CLI and `x-embody-roles: owner,viewer` over HTTP cannot
 * drift apart. Callers keep their own error messages; this only parses.
 *
 * Note what this is NOT: authentication. It trusts its input completely, which is why
 * the HTTP path gates it behind `EMBODY_DEV_IDENTITY=1`.
 */
import type { Principal } from "@embody/kernel";

export interface PrincipalSource {
  /** Org id. Required — without a tenant there is nothing to scope to. */
  org?: string | undefined;
  /** User id. Optional: an unattributed action still runs, it just has no actor. */
  user?: string | undefined;
  /** Comma-separated role list. Defaults to "owner". */
  roles?: string | undefined;
}

/** Parse a role list: "owner, viewer" -> ["owner", "viewer"]. Empty -> ["owner"]. */
export function parseRoles(roles?: string | undefined): string[] {
  const parsed = (roles ?? "owner")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return parsed.length ? parsed : ["owner"];
}

/**
 * Build a Principal, or `null` when no org was supplied. Returning null rather than
 * throwing lets an HTTP caller answer 401 while the CLI raises its own "run `embody
 * seed`" error — same parsing, different affordance.
 */
export function principalFrom(src: PrincipalSource): Principal | null {
  const orgId = src.org?.trim();
  if (!orgId) return null;
  return {
    orgId,
    userId: src.user?.trim() ?? "",
    roles: parseRoles(src.roles),
  };
}
