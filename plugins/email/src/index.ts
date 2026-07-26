/**
 * @embody/email — inbound email as an automation trigger.
 *
 * Add `emailPlugin` (or `createEmailPlugin({ provider: "postmark", ... })`) to the
 * `plugins` array in your `embody.config.ts`, then create an endpoint:
 *
 *     embody run automation:endpoint --name inbox --plugin email --hook inbound
 *
 * Point your mail provider at the returned `POST /hooks/<token>` URL, and trigger on
 * `email.message.received` like any other event.
 */
export { emailPlugin, createEmailPlugin, verifySignature } from "./plugin.ts";
export type { EmailPluginOptions } from "./plugin.ts";
export { parseInbound } from "./providers.ts";
export type { InboundMessage, ProviderName } from "./providers.ts";
