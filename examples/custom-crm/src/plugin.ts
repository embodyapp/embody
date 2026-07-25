/**
 * An application's own plugin — the code a developer writes to bend embody to their
 * business, living in their own repository rather than in any dependency.
 *
 * This is the Decision D8 proof: the CRM is bent to a specific compliance process
 * *without editing or forking* anything that ships from npm. It is enabled by one line
 * in this app's own `embody.config.ts`, and it rides exactly the same plugin SPI a
 * published plugin uses — the kernel cannot tell the difference.
 *
 * It exercises five extension surfaces:
 *   1. migrations      — owns its own `custom_acme` schema (HIPAA review audit trail + RLS).
 *   2. vetoable hook   — `crm.deal.beforeUpdate` blocks closing a healthcare deal that has
 *                        not passed HIPAA review. Layers *on top of* the b2b-saas InfoSec
 *                        veto; neither plugin knows about the other.
 *   3. service consume — uses the first-party `core.registry` to put its reviews in the
 *                        cross-app entity graph.
 *   4. MCP tools       — `acme_flag_hipaa` / `acme_list_hipaa_reviews`, immediately callable
 *                        by AI agents, REST, and the CLI under the *same* authz.
 *   5. CLI command     — `embody run acme:hipaa <dealId>`, governed by the same principal.
 */
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { EmbodyPlugin, KernelContext } from "@embody/kernel";
import type { RegistryService } from "@embody/core";

/** Absolute path to this plugin's SQL migration directory. */
export const acmeCrmMigrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** The vertical that triggers Acme's extra compliance gate. */
export const REGULATED_VERTICAL = "healthcare";

/** Shape of the `crm.deal.beforeUpdate` payload this hook cares about. */
interface DealUpdatePayload {
  id?: string;
  title?: string;
  stage?: string;
  amount?: number | string;
  custom_fields?: Record<string, unknown>;
}

interface HipaaReviewRow {
  id: string;
  dealId: string;
  reviewer: string;
  note: string | null;
  reviewedAt: string;
}

/**
 * The rule, as a pure function so it can be unit-tested without a kernel or a database.
 * Returns a veto reason, or null when the update is allowed.
 */
export function hipaaVetoReason(deal: DealUpdatePayload): string | null {
  if (deal.stage !== "closed_won") return null;
  const cf = deal.custom_fields ?? {};
  const vertical = String(cf.industry_vertical ?? "").toLowerCase();
  if (vertical !== REGULATED_VERTICAL) return null;
  if (cf.hipaa_review_passed === true) return null;
  return (
    `Acme policy: ${REGULATED_VERTICAL} deals require a completed HIPAA review before ` +
    `they can move to 'closed_won'. Run the acme_flag_hipaa tool (or 'embody run acme:hipaa ` +
    `<dealId>') to record the review.`
  );
}

export const acmeCrmPlugin: EmbodyPlugin = {
  id: "custom-acme-crm",
  schema: "custom_acme",
  // Needs core (orgs/registry) and crm (deals) to exist first — the kernel topo-sorts on this.
  dependsOn: ["core", "crm"],
  capabilities: {
    entities: ["acme.hipaa_review"],
    hooks: ["crm.deal.beforeUpdate"],
    services: { consume: ["core.registry"] },
    events: { publish: ["acme.hipaa.reviewed"] },
  },
  migrations: { dir: acmeCrmMigrationsDir, schema: "custom_acme" },

  init(ctx: KernelContext) {
    ctx.logger.info("custom-crm loaded — HIPAA review gate active", {
      vertical: REGULATED_VERTICAL,
    });
  },

  // ---------------------------------------------------------------------------
  // 2. Vetoable domain hook — extends another plugin's behaviour without touching it.
  // ---------------------------------------------------------------------------
  registerHooks(hooks, ctx) {
    hooks.register("crm.deal.beforeUpdate", (payload: unknown) => {
      const deal = payload as DealUpdatePayload;
      const reason = hipaaVetoReason(deal);
      if (reason) {
        ctx.logger.warn("VETO: HIPAA review missing", { title: deal.title, stage: deal.stage });
        throw new Error(reason);
      }
    });
  },

  // ---------------------------------------------------------------------------
  // 4. MCP tools — the customization is instantly available to AI agents and scripts.
  // ---------------------------------------------------------------------------
  registerMcpTools(mcp, ctx) {
    const registry = ctx.services.get<RegistryService>("core.registry");

    mcp.tool({
      name: "acme_flag_hipaa",
      description:
        "Record that a deal has passed Acme's HIPAA compliance review. Writes an audit row " +
        "and clears the deal to be closed, satisfying the healthcare-vertical gate.",
      input: z.object({
        dealId: z.string().uuid(),
        reviewer: z.string().min(1).optional(),
        note: z.string().optional(),
      }),
      handler: async (input, req) => {
        // Same authz choke point as REST and the CLI — the agent is not a back door.
        req.assert("write", "crm:deal");

        const result = await req.tx(async (tx) => {
          // The audit trail lives in this plugin's own schema (RLS-scoped to the org).
          const [review] = await tx<HipaaReviewRow[]>`
            insert into custom_acme.hipaa_reviews (org_id, deal_id, reviewer, note)
            values (${req.orgId}, ${input.dealId}, ${input.reviewer ?? "system"},
                    ${input.note ?? null})
            on conflict (org_id, deal_id) do update
              set reviewed_at = now(),
                  reviewer    = excluded.reviewer,
                  note        = excluded.note
            returning id, deal_id as "dealId", reviewer, note, reviewed_at as "reviewedAt"
          `;

          // Denormalise the flag onto the deal so the in-transaction veto hook — which only
          // sees the payload, never a connection — can read it.
          const [deal] = await tx<{ id: string; title: string }[]>`
            update crm.deals
               set custom_fields = custom_fields || '{"hipaa_review_passed": true}'::jsonb,
                   updated_at = now()
             where id = ${input.dealId}
            returning id, title
          `;
          if (!deal) throw new Error(`Deal ${input.dealId} not found in this org`);

          // 3. Consume the first-party registry so the review joins the cross-app graph.
          const reviewEntityId = await registry.register(tx, {
            orgId: req.orgId,
            type: "acme.hipaa_review",
            sourceSchema: "custom_acme",
            sourceTable: "hipaa_reviews",
            sourceId: review!.id,
            displayLabel: `HIPAA review — ${deal.title}`,
          });
          const dealEntityId = await registry.entityIdForSource(tx, {
            sourceSchema: "crm",
            sourceTable: "deals",
            sourceId: input.dealId,
          });
          if (dealEntityId) {
            await registry.relate(tx, {
              orgId: req.orgId,
              fromEntityId: reviewEntityId,
              toEntityId: dealEntityId,
              kind: "hipaa_review_for_deal",
            });
          }
          return { review: review!, deal };
        });

        await ctx.events.publish({
          name: "acme.hipaa.reviewed",
          orgId: req.orgId,
          payload: { dealId: input.dealId, reviewId: result.review.id },
        });

        return {
          ok: true,
          dealId: input.dealId,
          reviewId: result.review.id,
          reviewer: result.review.reviewer,
          message: `HIPAA review recorded for "${result.deal.title}" — deal is clear to close.`,
        };
      },
    });

    mcp.tool({
      name: "acme_list_hipaa_reviews",
      description: "List HIPAA compliance reviews recorded in the current org.",
      input: z.object({ limit: z.number().int().positive().max(100).optional() }),
      handler: (input, req) => {
        req.assert("read", "crm:deal");
        const limit = input.limit ?? 50;
        return req.tx(
          async (tx) => await tx<HipaaReviewRow[]>`
            select r.id, r.deal_id as "dealId", r.reviewer, r.note,
                   r.reviewed_at as "reviewedAt"
              from custom_acme.hipaa_reviews r
             order by r.reviewed_at desc
             limit ${limit}
          `,
        );
      },
    });
  },

  // ---------------------------------------------------------------------------
  // 5. CLI command — same principal, same authz as MCP/REST.
  // ---------------------------------------------------------------------------
  registerCliCommands(cli, ctx) {
    cli.command({
      name: "acme:hipaa",
      description: "Record an Acme HIPAA compliance review for a deal.",
      args: ["<dealId>"],
      options: [{ flags: "--reviewer <name>", description: "Who performed the review" }],
      handler: async (cmdCtx) => {
        const dealId = cmdCtx.args[0];
        if (!dealId) throw new Error("Usage: embody run acme:hipaa <dealId>");
        const req = cmdCtx.request;
        req.assert("write", "crm:deal");
        ctx.logger.info("CLI: acme:hipaa", { dealId });
        return req.tx(async (tx) => {
          const [review] = await tx<HipaaReviewRow[]>`
            insert into custom_acme.hipaa_reviews (org_id, deal_id, reviewer)
            values (${req.orgId}, ${dealId}, ${String(cmdCtx.options.reviewer ?? "cli")})
            on conflict (org_id, deal_id) do update
              set reviewed_at = now(), reviewer = excluded.reviewer
            returning id, deal_id as "dealId", reviewer, note, reviewed_at as "reviewedAt"
          `;
          await tx`
            update crm.deals
               set custom_fields = custom_fields || '{"hipaa_review_passed": true}'::jsonb
             where id = ${dealId}
          `;
          return { command: "acme:hipaa", ...review };
        });
      },
    });
  },
};
