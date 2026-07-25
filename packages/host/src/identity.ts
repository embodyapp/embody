/**
 * Who is calling over HTTP.
 *
 * The kernel never asks how a principal was obtained — it only wants one. That makes
 * identity a seam rather than a fixed policy: this module ships a **dev-grade** provider
 * (opaque session cookie + explicitly gated header impersonation), and a deployment that
 * needs SSO/OIDC passes its own `IdentityProvider` to `startHost` without the bridge
 * changing at all.
 *
 * Deliberately no passwords here — see the note in @embody/auth's session.ts.
 * Authentication belongs to an identity provider; this is the seam it plugs into.
 */
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { Logger, Principal } from "@embody/kernel";
import { InMemorySessionStore, principalFrom, type SessionStore } from "@embody/auth";
import type { Sql } from "@embody/db";
import { UnauthenticatedError, UnavailableError } from "./errors.ts";

/** Name of the session cookie. Opaque token; the store holds the principal. */
export const SESSION_COOKIE = "embody_session";

/** How a principal was established — reported by `GET /api/me`, useful in demos. */
export type IdentitySource = "session" | "header" | "env";

export interface ResolvedIdentity {
  principal: Principal;
  source: IdentitySource;
}

export interface IdentityProvider {
  /** Resolve the caller, or null when anonymous. */
  resolve(c: Context): Promise<ResolvedIdentity | null>;
  /** Establish a session. Omit to run without a login route (it then answers 501). */
  login?(c: Context, body: unknown): Promise<Principal>;
  /** Tear a session down. */
  logout?(c: Context): Promise<void>;
}

const loginBody = z.object({
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
  roles: z.array(z.string().min(1)).nonempty().optional(),
});

export interface DevIdentityOptions {
  /** Owner-role handle, used to verify the membership at login. */
  sql?: Sql;
  logger?: Logger;
  sessions?: SessionStore;
  /** Override the env gate (tests). Defaults to `EMBODY_DEV_IDENTITY === "1"`. */
  allowUnauthenticatedIdentity?: boolean;
}

/**
 * The default provider.
 *
 * Resolution order:
 *   1. session cookie — always honoured, because a session was explicitly minted;
 *   2. `x-embody-org|user|roles` headers — dev gate only;
 *   3. `EMBODY_ORG|USER|ROLES` env — dev gate only, so what `embody seed` prints and
 *      tells you to export just works with no login step.
 *
 * Steps 2–3 are pure impersonation: anyone who can reach the port becomes anyone. They
 * are why the gate exists, why it is off by default, and why enabling it logs a warning.
 */
export function createDevIdentity(opts: DevIdentityOptions = {}): IdentityProvider {
  const sessions = opts.sessions ?? new InMemorySessionStore();
  const devIdentity =
    opts.allowUnauthenticatedIdentity ?? process.env.EMBODY_DEV_IDENTITY === "1";

  if (devIdentity) {
    opts.logger?.warn(
      "dev identity enabled: x-embody-* headers and EMBODY_ORG/USER/ROLES are trusted " +
        "without authentication. Never set EMBODY_DEV_IDENTITY=1 in production.",
    );
  }

  return {
    async resolve(c) {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) {
        const session = sessions.get(token);
        if (session) return { principal: session.principal, source: "session" };
      }

      if (!devIdentity) return null;

      const fromHeaders = principalFrom({
        org: c.req.header("x-embody-org"),
        user: c.req.header("x-embody-user"),
        roles: c.req.header("x-embody-roles"),
      });
      if (fromHeaders) return { principal: fromHeaders, source: "header" };

      const fromEnv = principalFrom({
        org: process.env.EMBODY_ORG,
        user: process.env.EMBODY_USER,
        roles: process.env.EMBODY_ROLES,
      });
      if (fromEnv) return { principal: fromEnv, source: "env" };

      return null;
    },

    async login(c, body) {
      if (!devIdentity) {
        throw new UnavailableError(
          "Password-less dev login is disabled. Set EMBODY_DEV_IDENTITY=1 for local " +
            "development, or configure an identity provider via startHost({ identity }).",
        );
      }
      const { orgId, userId, roles } = loginBody.parse(body);

      // Verify the membership rather than trusting the ids. Four lines, and it turns
      // "type any uuid" into "sign in as a user that actually exists in that org".
      // Read as OWNER: this is control plane, and RLS is not yet scoped to anyone.
      if (opts.sql) {
        const rows = await opts.sql<{ role: string }[]>`
          select role from core.memberships
          where org_id = ${orgId} and user_id = ${userId} limit 1
        `;
        if (!rows.length) {
          throw new UnauthenticatedError(
            "No membership for that user in that org. Run `embody seed` to create one.",
          );
        }
      }

      const principal: Principal = {
        orgId,
        userId,
        // Explicit roles are how you test a viewer's read-only UI without seeding a
        // second user. Dev-only by construction — this whole branch is behind the gate.
        roles: roles ?? ["owner"],
      };
      const session = sessions.create(principal);
      setCookie(c, SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 12,
        // Omitted on plain http, or the browser drops the cookie on localhost.
        secure: new URL(c.req.url).protocol === "https:",
      });
      return principal;
    },

    async logout(c) {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) sessions.revoke(token);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
    },
  };
}
