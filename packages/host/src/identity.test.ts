/**
 * Identity resolution, exercised through a real Hono app (no server, no socket) so the
 * cookie helpers and header reads are the real ones.
 *
 * The load-bearing property: header/env impersonation is INERT unless the dev gate is
 * on. A regression here silently turns any deployment into "whoever asks is whoever
 * they say they are".
 *
 * Run: `pnpm --filter @embody/host exec vitest run`
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { InMemorySessionStore } from "@embody/auth";
import { createDevIdentity, SESSION_COOKIE, type IdentityProvider } from "./identity.ts";

/** Expose a provider over HTTP so requests, not mocks, drive it. */
function appFor(identity: IdentityProvider): Hono {
  const app = new Hono();
  app.get("/who", async (c) => {
    const resolved = await identity.resolve(c);
    return resolved ? c.json(resolved) : c.json({ anonymous: true }, 401);
  });
  app.post("/login", async (c) => {
    try {
      const principal = await identity.login!(c, await c.req.json());
      return c.json({ principal });
    } catch (err) {
      // The real bridge maps these through toHttpError; here we only need the reason.
      return c.json({ failed: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
  app.post("/logout", async (c) => {
    await identity.logout!(c);
    return c.body(null, 204);
  });
  return app;
}

const get = (app: Hono, headers: Record<string, string> = {}) =>
  app.request("/who", { headers });

describe("createDevIdentity", () => {
  it("returns null when nothing identifies the caller", async () => {
    const app = appFor(createDevIdentity({ allowUnauthenticatedIdentity: false }));
    expect((await get(app)).status).toBe(401);
  });

  it("ignores x-embody-* headers unless the dev gate is on", async () => {
    const app = appFor(createDevIdentity({ allowUnauthenticatedIdentity: false }));
    const res = await get(app, { "x-embody-org": "org-1", "x-embody-user": "user-1" });
    expect(res.status).toBe(401);
  });

  it("honours x-embody-* headers when the dev gate is on", async () => {
    const app = appFor(createDevIdentity({ allowUnauthenticatedIdentity: true }));
    const res = await get(app, {
      "x-embody-org": "org-1",
      "x-embody-user": "user-1",
      "x-embody-roles": "viewer, member",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      principal: { orgId: "org-1", userId: "user-1", roles: ["viewer", "member"] },
      source: "header",
    });
  });

  it("parses roles exactly as the CLI does, defaulting to owner", async () => {
    const app = appFor(createDevIdentity({ allowUnauthenticatedIdentity: true }));
    const res = await get(app, { "x-embody-org": "org-1" });
    const body = (await res.json()) as { principal: { roles: string[]; userId: string } };
    expect(body.principal.roles).toEqual(["owner"]);
    expect(body.principal.userId).toBe("");
  });

  it("falls back to EMBODY_ORG/USER/ROLES so `embody seed`'s exports just work", async () => {
    const app = appFor(createDevIdentity({ allowUnauthenticatedIdentity: true }));
    process.env.EMBODY_ORG = "org-env";
    process.env.EMBODY_USER = "user-env";
    process.env.EMBODY_ROLES = "member";
    try {
      const res = await get(app);
      expect(await res.json()).toEqual({
        principal: { orgId: "org-env", userId: "user-env", roles: ["member"] },
        source: "env",
      });
    } finally {
      delete process.env.EMBODY_ORG;
      delete process.env.EMBODY_USER;
      delete process.env.EMBODY_ROLES;
    }
  });

  it("prefers a session cookie over the dev fallbacks", async () => {
    const sessions = new InMemorySessionStore();
    const session = sessions.create({ orgId: "org-session", userId: "u", roles: ["viewer"] });
    const app = appFor(createDevIdentity({ allowUnauthenticatedIdentity: true, sessions }));
    const res = await get(app, {
      cookie: `${SESSION_COOKIE}=${session.token}`,
      "x-embody-org": "org-header",
    });
    const body = (await res.json()) as { principal: { orgId: string }; source: string };
    expect(body.principal.orgId).toBe("org-session");
    expect(body.source).toBe("session");
  });

  it("honours a session cookie even with the dev gate off", async () => {
    const sessions = new InMemorySessionStore();
    const session = sessions.create({ orgId: "org-1", userId: "u", roles: ["owner"] });
    const app = appFor(createDevIdentity({ allowUnauthenticatedIdentity: false, sessions }));
    const res = await get(app, { cookie: `${SESSION_COOKIE}=${session.token}` });
    expect(res.status).toBe(200);
  });

  it("ignores an unknown or revoked session token", async () => {
    const sessions = new InMemorySessionStore();
    const session = sessions.create({ orgId: "org-1", userId: "u", roles: ["owner"] });
    const app = appFor(createDevIdentity({ allowUnauthenticatedIdentity: false, sessions }));
    sessions.revoke(session.token);
    const res = await get(app, { cookie: `${SESSION_COOKIE}=${session.token}` });
    expect(res.status).toBe(401);
  });
});

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

describe("dev login", () => {
  const login = (app: Hono, body: unknown) =>
    app.request("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("mints an httpOnly, SameSite=Lax session cookie", async () => {
    const app = appFor(createDevIdentity({ allowUnauthenticatedIdentity: true }));
    const res = await login(app, { orgId: ORG, userId: USER, roles: ["viewer"] });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // No Secure on plain http, or the browser drops it on localhost.
    expect(cookie).not.toMatch(/Secure/i);
  });

  it("issues a cookie the same provider then accepts", async () => {
    const identity = createDevIdentity({ allowUnauthenticatedIdentity: true });
    const app = appFor(identity);
    const res = await login(app, { orgId: ORG, userId: USER, roles: ["viewer"] });
    const token = /embody_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    const who = await get(app, { cookie: `${SESSION_COOKIE}=${token}` });
    const body = (await who.json()) as { principal: { roles: string[] }; source: string };
    expect(body.source).toBe("session");
    expect(body.principal.roles).toEqual(["viewer"]);
  });

  it("revokes the session on logout", async () => {
    const identity = createDevIdentity({ allowUnauthenticatedIdentity: true });
    const app = appFor(identity);
    const res = await login(app, { orgId: ORG, userId: USER });
    const token = /embody_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    await app.request("/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    const who = await get(app, { cookie: `${SESSION_COOKIE}=${token}` });
    expect(who.status).toBe(401);
  });

  it("refuses a password-less login when the dev gate is off", async () => {
    const app = appFor(createDevIdentity({ allowUnauthenticatedIdentity: false }));
    const res = await login(app, { orgId: ORG, userId: USER });
    expect(res.status).toBe(400);
    // The refusal names the switch, so a developer isn't left guessing.
    expect((await res.json()) as { failed: string }).toMatchObject({
      failed: expect.stringMatching(/EMBODY_DEV_IDENTITY/),
    });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a malformed login body", async () => {
    const app = appFor(createDevIdentity({ allowUnauthenticatedIdentity: true }));
    const res = await login(app, { orgId: "not-a-uuid", userId: USER });
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
