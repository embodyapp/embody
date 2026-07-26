/**
 * @embody/email — inbound email as an automation trigger.
 *
 * This plugin is the test of a claim. The automation engine says every trigger is an
 * event, so a genuinely new kind of trigger should need no change to the engine, no
 * change to the framework, and no new concept anywhere. Email is about as different
 * from `crm.deal.created` as a trigger gets — it arrives from outside, from a third
 * party, over HTTP, in a shape nobody in this repository chose.
 *
 * What it takes: receive the POST, verify it, publish `email.message.received`. That
 * is the whole plugin. Everything else — matching, conditions, running an action as a
 * chosen principal, durability, retries, run history — already exists and does not
 * know email is involved.
 *
 *     embody run automation:endpoint --name inbox --plugin email --hook inbound
 *     embody run automation:create --when email.message.received \
 *       --if 'payload.to contains support@' --do acme_triage_email
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { EmbodyPlugin } from "@embody/plugin-sdk";
import { parseInbound, type ProviderName } from "./providers.ts";

export interface EmailPluginOptions {
  /**
   * Which provider's payload shape to expect. Defaults to "generic", which reads the
   * field names most services already use.
   */
  provider?: ProviderName;
  /**
   * Header carrying the provider's HMAC-SHA256 signature of the raw body. When set
   * AND the endpoint has a secret, a request without a matching signature is rejected.
   */
  signatureHeader?: string;
}

/** Constant-time compare, so a wrong signature leaks nothing through timing. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Verify an HMAC-SHA256 signature over the exact bytes received.
 *
 * Signing the re-serialised JSON instead of the raw body is the classic way to break
 * this: key order and whitespace differ, and every request fails. The webhook surface
 * hands over the raw string precisely so this can be done correctly.
 */
export function verifySignature(rawBody: string, secret: string, provided: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const hex = createHmac("sha256", secret).update(rawBody).digest("hex");
  const candidate = provided.replace(/^sha256=/, "");
  return safeEqual(expected, candidate) || safeEqual(hex, candidate);
}

export function createEmailPlugin(options: EmailPluginOptions = {}): EmbodyPlugin {
  const provider = options.provider ?? "generic";
  const signatureHeader = options.signatureHeader?.toLowerCase();

  return {
    id: "email",
    schema: "email",
    dependsOn: ["core"],
    capabilities: {
      // The plugin's entire authority: publish one event. Nothing else.
      events: { publish: ["email.message.received"] },
    },

    init(ctx) {
      ctx.logger.info("email plugin ready", {
        provider,
        signatureHeader: signatureHeader ?? "none (unsigned)",
      });
    },

    registerWebhooks(hooks, ctx) {
      hooks.webhook({
        name: "inbound",
        description: "Receive an inbound email and publish email.message.received",
        handler: (req) => {
          // Signature first: never parse an unverified body any further than needed.
          if (signatureHeader && req.secret) {
            const provided = req.headers[signatureHeader];
            if (!provided || !verifySignature(req.body, req.secret, provided)) {
              // Thrown, so the route answers 400 and nothing is published.
              throw new Error("Invalid webhook signature");
            }
          }

          const message = parseInbound(provider, req.body);
          ctx.logger.info("inbound email accepted", {
            from: message.from,
            to: message.to,
            subject: message.subject,
          });

          // The one line that matters. From here it is an ordinary domain event, and
          // the automation engine does not know or care where it came from.
          return {
            events: [{ name: "email.message.received", payload: message }],
            body: { received: true, messageId: message.messageId },
          };
        },
      });
    },

    /**
     * A convenience for testing a rule without sending real mail: publish the same
     * event by hand. It goes through the identical path a real message takes.
     */
    registerMcpTools(mcp, ctx) {
      mcp.tool({
        name: "email_simulate_inbound",
        description:
          "Publish an email.message.received event as if a message had arrived. For " +
          "testing automations without sending real mail.",
        input: z.object({
          from: z.string().min(1),
          to: z.array(z.string()).min(1),
          subject: z.string().default(""),
          text: z.string().default(""),
        }),
        handler: async (input, req) => {
          req.assert("write", "email:message");
          await req.tx((tx) =>
            ctx.events.publish(
              {
                name: "email.message.received",
                orgId: req.orgId,
                payload: {
                  from: input.from.toLowerCase(),
                  to: input.to.map((t) => t.toLowerCase()),
                  subject: input.subject,
                  text: input.text,
                  attachments: [],
                },
              },
              tx,
            ),
          );
          return { published: "email.message.received" };
        },
      });
    },
  };
}

/** The default instance: generic payload shape, no signature checking. */
export const emailPlugin = createEmailPlugin();
