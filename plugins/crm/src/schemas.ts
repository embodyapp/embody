/**
 * The CRM's wire contract: tool input schemas and the row shape, and nothing else.
 *
 * This module imports **only zod**, on purpose. `plugin.ts` reaches for `node:url`,
 * @embody/kernel (hono) and @embody/plugin-sdk (postgres) — none of which can be
 * bundled into a browser. Keeping the schemas in a leaf module lets a UI import
 * `@embody/crm/schemas` and get the same types the server validates against, instead of
 * hand-copying shapes that then drift.
 *
 * Every catalog app should follow this pattern.
 */
import { z } from "zod";

/** Row shape of `crm.deals`, as returned by Postgres (snake_case columns). */
export interface DealRow {
  id: string;
  org_id: string;
  party_id: string | null;
  title: string;
  stage: string;
  /** Postgres numeric arrives as a string; parse before doing arithmetic. */
  amount: string | null;
  custom_fields: Record<string, unknown>;
  [key: string]: unknown;
}

export const crmCreateDealInput = z.object({
  title: z.string().min(1),
  stage: z.string().optional(),
  amount: z.number().nonnegative().optional(),
  partyId: z.string().uuid().optional(),
  customFields: z.record(z.unknown()).optional(),
});

export const crmUpdateDealInput = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).optional(),
  stage: z.string().optional(),
  amount: z.number().nonnegative().optional(),
  partyId: z.string().uuid().optional(),
  customFields: z.record(z.unknown()).optional(),
});

export const crmGetDealInput = z.object({ id: z.string().uuid() });

export const crmQueryDealsInput = z.object({
  stage: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export type CrmCreateDealInput = z.infer<typeof crmCreateDealInput>;
export type CrmUpdateDealInput = z.infer<typeof crmUpdateDealInput>;
export type CrmGetDealInput = z.infer<typeof crmGetDealInput>;
export type CrmQueryDealsInput = z.infer<typeof crmQueryDealsInput>;
