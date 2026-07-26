/**
 * @embody/http — outbound HTTP for automations. NOT enabled by default.
 *
 * Add `httpPlugin` to `embody.config.ts` and set `EMBODY_HTTP_ALLOWED_HOSTS`. Read the
 * comment at the top of `egress.ts` before you do: a generic HTTP tool driven by
 * database rows is an SSRF surface, and the allowlist is what contains it.
 */
export { httpPlugin, createHttpPlugin } from "./plugin.ts";
export type { HttpPluginOptions } from "./plugin.ts";
export {
  assertEgressAllowed,
  allowedHostsFromEnv,
  resolveSecrets,
  EgressDenied,
} from "./egress.ts";
export type { EgressPolicy } from "./egress.ts";
