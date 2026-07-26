/**
 * `POST /hooks/:token` — inbound HTTP from outside systems.
 *
 * Mounted separately from the `/api` tool bridge on purpose. The bridge assumes a
 * *user*: it resolves a principal, refuses without one, and requires
 * `content-type: application/json` as a CSRF defence. None of that applies here. The
 * caller is Stripe, or a mail provider, posting `application/x-www-form-urlencoded`
 * from a machine with no cookie. Reusing the bridge would mean weakening exactly the
 * checks that make the bridge safe for browsers.
 *
 * Tenancy comes from the URL. There is no session to read an org from, and a path like
 * `/hooks/stripe` cannot say *whose* Stripe. The token is a bearer credential that
 * resolves to (org, plugin, hook) — so it is stored hashed, matched by hash, and
 * generated with real entropy.
 *
 * What this route deliberately does NOT do is process the payload. It verifies, hands
 * the raw bytes to the plugin, and publishes whatever events come back — inside one
 * transaction, so a webhook either produces all of its events or is rejected and
 * retried by the sender. Everything after that is the outbox's problem, which means an
 * inbound webhook gets the same durability and retries as any other trigger.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { Logger } from "@embody/kernel";
import type { Sql } from "@embody/db";
import type { Runtime } from "./runtime.ts";

export interface WebhookEndpointRow {
  id: string;
  org_id: string;
  name: string;
  plugin_id: string;
  hook: string;
  secret: string | null;
  enabled: boolean;
}

/** URL-safe token with 256 bits of entropy. Shown once, stored only as a hash. */
export function generateWebhookToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * SHA-256 of the token.
 *
 * Not a password KDF, and deliberately so: this is a 256-bit random value, not a
 * human-chosen secret, so there is nothing for bcrypt's work factor to protect against
 * — brute force is already infeasible. A fast hash also keeps the lookup a single
 * indexed query instead of a scan-and-compare over every endpoint.
 */
export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison, for plugins verifying a provider's signature. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface MountHooksOptions {
  runtime: Runtime;
  logger: Logger;
  /** Route prefix. Default "/hooks". */
  basePath?: string;
  /** Reject bodies larger than this many bytes. Default 1 MiB. */
  maxBodyBytes?: number;
}

export function mountHooks(app: Hono, opts: MountHooksOptions): void {
  const { runtime, logger } = opts;
  const base = opts.basePath ?? "/hooks";
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  // Owner handle: there is no tenant to scope by until the token resolves one.
  const sql: Sql = runtime.ownerDb.sql;

  app.post(`${base}/:token`, async (c) => {
    const token = c.req.param("token");
    const [endpoint] = await sql<WebhookEndpointRow[]>`
      select id, org_id, name, plugin_id, hook, secret, enabled
      from embody.webhook_endpoints
      where token_hash = ${hashWebhookToken(token)}
    `;

    // One response for "no such token" and "disabled": distinguishing them tells an
    // attacker which of their guesses was once real.
    if (!endpoint || !endpoint.enabled) {
      logger.warn("webhook rejected: unknown or disabled token");
      return c.json({ error: "unknown endpoint" }, 404);
    }

    const handler = runtime.booted.webhooks.find(endpoint.plugin_id, endpoint.hook);
    if (!handler) {
      // The endpoint row outlived the plugin that served it — a real misconfiguration,
      // and one the sender should retry rather than give up on.
      logger.error("webhook endpoint names a hook no plugin registered", {
        plugin: endpoint.plugin_id,
        hook: endpoint.hook,
      });
      return c.json({ error: "endpoint not available" }, 503);
    }

    const body = await c.req.text();
    if (Buffer.byteLength(body) > maxBody) {
      return c.json({ error: "payload too large" }, 413);
    }

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    try {
      const result = await handler.handler({
        body,
        headers,
        orgId: endpoint.org_id,
        name: endpoint.name,
        secret: endpoint.secret ?? undefined,
      });

      const events = result.events ?? [];
      if (events.length > 0) {
        // One transaction for the whole batch: a webhook that yields three events
        // publishes all three or none, so a sender retrying after a partial failure
        // cannot produce duplicates of the ones that already landed.
        await sql.begin(async (raw) => {
          const tx = raw as unknown as Sql;
          for (const event of events) {
            await runtime.booted.events.publish(
              { name: event.name, orgId: endpoint.org_id, payload: event.payload },
              tx,
            );
          }
          await tx`
            update embody.webhook_endpoints set last_seen_at = now() where id = ${endpoint.id}
          `;
        });
      }

      logger.info("webhook accepted", {
        endpoint: endpoint.name,
        plugin: endpoint.plugin_id,
        events: events.map((e) => e.name),
      });
      // 202, not 200: the events are durably recorded, not yet acted on.
      return c.json(result.body ?? { ok: true }, (result.status ?? 202) as 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("webhook handler rejected the request", {
        endpoint: endpoint.name,
        error: message,
      });
      // 400, and the handler's message: a rejected signature or an unparseable body is
      // the sender's problem to fix, and retrying will not help.
      return c.json({ error: message }, 400);
    }
  });
}
