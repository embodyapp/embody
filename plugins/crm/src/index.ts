/**
 * @embody/crm — the CRM app plugin (deals on shared parties).
 *
 * A browser must import `@embody/crm/schemas` instead: this entry pulls in the kernel
 * and the plugin SDK, and with them hono and postgres.
 */
export { crmPlugin, crmMigrationsDir } from "./plugin.ts";
export type { DealRow } from "./schemas.ts";
