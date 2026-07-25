/**
 * Reference deployment — UPSTREAM-OWNED. Copy this directory to `deploy/<yours>` (or
 * run `embody new deployment <yours>`) and edit that copy. Anything you change here
 * conflicts the next time you merge upstream; see OWNERSHIP.md.
 *
 * This file is the *selection mechanism*: it declares which plugins the deployable
 * runs. `core` is always registered by the host, so only the optional ones are listed.
 * This example enables catalog apps only — a company's own plugins from `custom/`
 * belong in that company's own deployment (see deploy/acme for a worked example).
 *
 * Install an app:  `pnpm add @embody/erp`      (adds the dependency)
 * Enable it:       add its plugin to `plugins`  (e.g. `plugins: [crmPlugin, erpPlugin]`)
 *
 * Nothing environment-specific belongs here — DATABASE_URL / PORT come from env, so
 * this same file runs unchanged locally and in the cloud.
 */
import { defineConfig } from "@embody/host";
import { crmPlugin } from "@embody/crm";
import { b2bSaasPlugin } from "@embody/b2b-saas";
import { ecomFulfillmentPlugin } from "@embody/ecom-fulfillment";

export default defineConfig({
  plugins: [crmPlugin, b2bSaasPlugin, ecomFulfillmentPlugin],
});
