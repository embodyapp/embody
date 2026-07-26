/**
 * Webhook registrar — the extension surface for turning an inbound HTTP request from
 * an outside system into a domain event.
 *
 * This is the second half of "every trigger is an event". A plugin does not get to
 * define a new kind of trigger; it gets to receive a request and publish. Everything
 * downstream — automations, other plugins' subscriptions, the outbox's durability and
 * retries — then works exactly as it does for `crm.deal.created`, with no knowledge
 * that an outside system was involved.
 *
 * Note what a handler is NOT given: a `RequestContext`. There is no principal, because
 * nobody is logged in — the caller is Stripe. It gets the raw body (unparsed, so a
 * signature can be verified over the exact bytes the provider signed), the headers, the
 * resolved org, and the endpoint's secret.
 */

export interface WebhookRequest {
  /** The raw body, exactly as received. Verify signatures against this, not a re-encode. */
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The tenant the endpoint token resolved to. */
  readonly orgId: string;
  /** Endpoint name, so one plugin can host several. */
  readonly name: string;
  /** The endpoint's shared secret, when one was configured. */
  readonly secret?: string;
}

/**
 * What a handler returns. Publishing is declarative rather than a bus call so the
 * route can enlist every event in one transaction and reject the whole request
 * atomically if anything fails.
 */
export interface WebhookResult {
  /** Events to publish. Usually one; a batch payload may yield several. */
  events?: { name: string; payload: unknown }[];
  /** Response body. Defaults to `{ ok: true }`. */
  body?: unknown;
  /** Response status. Defaults to 202 — accepted for processing, not processed. */
  status?: number;
}

export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookResult> | WebhookResult;

export interface WebhookDefinition {
  /**
   * Hook name, namespaced by convention like everything else, e.g. "email.inbound".
   * An endpoint row names the plugin and this hook, so one plugin can serve several.
   */
  name: string;
  description: string;
  handler: WebhookHandler;
}

export interface WebhookRegistrar {
  webhook(def: WebhookDefinition): void;
}

/** Collecting registrar the kernel uses to gather plugin webhooks during boot. */
export class CollectingWebhookRegistrar {
  readonly webhooks: { pluginId: string; def: WebhookDefinition }[] = [];

  /**
   * A registrar bound to one plugin. Returns a fresh object rather than tracking a
   * "current plugin" on `this`: the id has to be captured at the point of use, or a
   * handler registered asynchronously would be filed under whichever plugin happened
   * to be registering when it ran.
   */
  forPlugin(pluginId: string): WebhookRegistrar {
    return {
      webhook: (def: WebhookDefinition) => {
        const clash = this.find(pluginId, def.name);
        if (clash) {
          throw new Error(
            `Plugin "${pluginId}" registered two webhooks named "${def.name}".`,
          );
        }
        this.webhooks.push({ pluginId, def });
      },
    };
  }

  find(pluginId: string, name: string): WebhookDefinition | undefined {
    return this.webhooks.find((w) => w.pluginId === pluginId && w.def.name === name)?.def;
  }
}
