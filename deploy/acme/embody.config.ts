/**
 * Acme's deployment — YOURS. Upstream never writes to `deploy/`, so `git merge
 * upstream/main` cannot conflict with this file. That is what makes the "customize
 * without forking" promise true rather than aspirational (Decision D8).
 *
 * Note what is NOT here: no server code, no forked app. A deployment is the embody
 * host plus this list. Catalog apps are imported by package name; Acme's own plugin
 * is imported the same way, because it is a workspace package under `custom/` — the
 * SPI does not distinguish them, and neither does the kernel.
 *
 * Run it:      pnpm --filter acme-deployment dev
 * Migrate it:  pnpm --filter acme-deployment migrate
 */
import { defineConfig } from "@embody/host";
import { crmPlugin } from "@embody/crm";
import { b2bSaasPlugin } from "embody-plugin-b2b-saas";
import { ecomFulfillmentPlugin } from "embody-plugin-ecom-fulfillment";
// Acme's own plugin. Owns the custom_acme schema, adds a HIPAA gate on deal closes,
// and ships its own MCP tools + CLI command — without editing framework/ or catalog/.
import { acmeCrmPlugin } from "acme-crm";

export default defineConfig({
  plugins: [crmPlugin, b2bSaasPlugin, ecomFulfillmentPlugin, acmeCrmPlugin],
});
