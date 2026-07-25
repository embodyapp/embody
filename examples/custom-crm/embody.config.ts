/**
 * A worked example of the thing embody exists to make easy: your own CRM, built by
 * adding plugins rather than editing anything upstream.
 *
 * This file is the selection mechanism — it declares which plugins the app runs.
 * `core` is always registered by the host, so only the optional ones are listed.
 * Nothing environment-specific belongs here: DATABASE_URL and PORT come from the
 * environment, so this same file runs unchanged locally and in the cloud.
 *
 * Note what is NOT here: no server code, no forked framework. An embody app is the
 * host plus this list. Published plugins are imported by package name and your own
 * by relative path — the SPI does not distinguish them, and neither does the kernel.
 *
 * This is the shape `create-embody-app` generates. If the two ever drift, this
 * example is what is wrong.
 *
 * Run it:      pnpm --filter custom-crm dev
 * Migrate it:  pnpm --filter custom-crm migrate
 */
import { defineConfig } from "@embody/host";
import { crmPlugin } from "@embody/crm";
import { b2bSaasPlugin } from "embody-plugin-b2b-saas";
import { ecomFulfillmentPlugin } from "embody-plugin-ecom-fulfillment";
// This app's own plugin. Owns the custom_acme schema, adds a HIPAA gate on deal
// closes, and ships its own MCP tools + CLI command — without editing any dependency.
import { acmeCrmPlugin } from "./src/plugin.ts";

export default defineConfig({
  plugins: [crmPlugin, b2bSaasPlugin, ecomFulfillmentPlugin, acmeCrmPlugin],
});
