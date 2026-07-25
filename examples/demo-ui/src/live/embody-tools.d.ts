/**
 * Typed tool calls, with no codegen step.
 *
 * `@embody/react` ships an empty `ToolMap`; augmenting it here gives every
 * `useToolQuery` / `useToolMutation` in this app autocomplete on tool names, checked
 * inputs, and a typed `data`. The shapes come from `@embody/crm/schemas` — the same
 * module the server validates against — so they cannot drift from the plugin.
 */
import type {
  CrmCreateDealInput,
  CrmGetDealInput,
  CrmQueryDealsInput,
  CrmUpdateDealInput,
  DealRow,
} from '@embody/crm/schemas';

declare module '@embody/react' {
  interface ToolMap {
    crm_query_deals: { input: CrmQueryDealsInput; output: DealRow[] };
    crm_get_deal: { input: CrmGetDealInput; output: DealRow | null };
    crm_create_deal: { input: CrmCreateDealInput; output: DealRow };
    crm_update_deal: { input: CrmUpdateDealInput; output: DealRow };
    /**
     * From `custom/acme-crm` — a customer's own plugin. It appears here exactly like a
     * first-party tool, which is the point: nothing in the framework or the catalog
     * knows this deployment has it.
     */
    acme_flag_hipaa: {
      input: { dealId: string; reviewer?: string };
      output: { id: string; dealId: string; reviewer: string };
    };
  }
}
