/**
 * @embody/http — let an automation call an outside API.
 *
 * The symmetry that completes the design: inbound, the world reaches embody by
 * publishing an event (a webhook plugin); outbound, embody reaches the world by
 * calling a tool. The automation engine knows about neither direction. Both are
 * ordinary plugins, and this one required no change to the engine — the same claim
 * `@embody/email` demonstrates from the other side.
 *
 * It is a **separate, opt-in package that is in no default configuration**, and that
 * is a security decision rather than packaging fussiness. A workflow row is data an
 * admin can edit at runtime; a generic HTTP tool turns that data into "make my server
 * issue a request", which is a confused deputy pointed at your own internal network.
 * Keeping it out of the engine means the SSRF surface exists only where someone chose
 * it, in one small auditable package, with an allowlist the database cannot influence.
 *
 * Enable it deliberately:
 *
 *     // embody.config.ts
 *     import { httpPlugin } from "@embody/http";
 *     export default defineConfig({ plugins: [automationPlugin, httpPlugin] });
 *
 *     EMBODY_HTTP_ALLOWED_HOSTS=api.stripe.com,.hooks.slack.com
 *     EMBODY_HTTP_SECRET_SLACK=xoxb-…
 *
 *     embody run automation:create --when crm.deal.created --do http_request \
 *       --map '{"url":"https://hooks.slack.com/services/XXX","method":"POST",
 *               "json":{"text":"New deal: {{payload.title}}"}}'
 */
import { z } from "zod";
import type { EmbodyPlugin } from "@embody/plugin-sdk";
import {
  assertEgressAllowed,
  allowedHostsFromEnv,
  resolveSecrets,
  type EgressPolicy,
} from "./egress.ts";

export interface HttpPluginOptions {
  /** Defaults to `EMBODY_HTTP_ALLOWED_HOSTS` (comma-separated). */
  allowedHosts?: readonly string[];
  /** Permit plain http://. Default false. */
  allowInsecure?: boolean;
  /** Abort a request after this many ms. Default 10_000. */
  timeoutMs?: number;
  /** Truncate the captured response body to this many characters. Default 10_000. */
  maxResponseChars?: number;
}

export function createHttpPlugin(options: HttpPluginOptions = {}): EmbodyPlugin {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxResponseChars = options.maxResponseChars ?? 10_000;

  return {
    id: "http",
    schema: "http",
    dependsOn: ["core"],
    capabilities: {},

    init(ctx) {
      const hosts = options.allowedHosts ?? allowedHostsFromEnv();
      if (hosts.length === 0) {
        // Loud, because the plugin is enabled but inert, and a workflow using it will
        // fail at trigger time with what looks like a bug.
        ctx.logger.warn(
          "http plugin enabled with an EMPTY allowlist — every http_request will be " +
            "denied. Set EMBODY_HTTP_ALLOWED_HOSTS.",
        );
      } else {
        ctx.logger.info("http plugin ready", { allowedHosts: hosts });
      }
    },

    registerMcpTools(mcp, ctx) {
      mcp.tool({
        name: "http_request",
        description:
          "Call an external HTTP API. Only hosts in the deployment's allowlist are " +
          "reachable. Use {{secret:NAME}} in a header value rather than pasting a key.",
        input: z.object({
          url: z.string().min(1),
          method: z
            .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
            .optional()
            .default("POST"),
          headers: z.record(z.string()).optional(),
          /** JSON body. Serialised, with content-type set. */
          json: z.unknown().optional(),
          /** Raw body, when the API does not take JSON. Ignored if `json` is present. */
          body: z.string().optional(),
        }),
        handler: async (input, req) => {
          req.assert("write", "http:request");

          // Policy is read per call so a deployment can change the allowlist by
          // restarting, and so the check always reflects the current environment.
          const policy: EgressPolicy = {
            allowedHosts: options.allowedHosts ?? allowedHostsFromEnv(),
            allowInsecure: options.allowInsecure ?? false,
          };
          // Throws EgressDenied, which the transport surfaces as a 409-style domain
          // error and the automation records as a failed run with the reason.
          const url = assertEgressAllowed(resolveSecrets(input.url), policy);

          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(input.headers ?? {})) {
            headers[key] = resolveSecrets(value);
          }
          let body: string | undefined;
          if (input.json !== undefined) {
            body = JSON.stringify(input.json);
            headers["content-type"] ??= "application/json";
          } else if (input.body !== undefined) {
            body = input.body;
          }

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(url, {
              method: input.method,
              headers,
              body: input.method === "GET" ? undefined : body,
              signal: controller.signal,
              // Follow no redirects: an allowlisted host that 302s to
              // 169.254.169.254 would otherwise walk straight around the policy.
              redirect: "manual",
            });
            const text = (await res.text()).slice(0, maxResponseChars);
            ctx.logger.info("http_request", {
              host: url.hostname,
              method: input.method,
              status: res.status,
            });
            // A non-2xx is returned, not thrown: the automation's run row should record
            // what the API actually said, and a 404 from Slack is not a bug in embody.
            return { status: res.status, ok: res.ok, body: text };
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
              throw new Error(`Request to ${url.hostname} timed out after ${timeoutMs}ms`);
            }
            // Deliberately not including the raw error: DNS and connection messages
            // can echo back internal hostnames.
            throw new Error(`Request to ${url.hostname} failed`);
          } finally {
            clearTimeout(timer);
          }
        },
      });
    },
  };
}

/** The default instance: allowlist from `EMBODY_HTTP_ALLOWED_HOSTS`, HTTPS only. */
export const httpPlugin = createHttpPlugin();
