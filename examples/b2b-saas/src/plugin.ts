/**
 * embody-plugin-b2b-saas plugin.
 * 
 * Reference B2B Enterprise SaaS extension plugin demonstrating how a B2B company
 * customizes the CRM without editing or forking core code:
 * 1. Declares capability permissions for B2B entities, hooks, services, and CLI commands.
 * 2. Provides a B2B Pricing & ARR Calculation DI Service (`b2b.pricing`).
 * 3. Registers synchronous, vetoable domain hooks (`crm.deal.beforeUpdate`) to block closing >$50k deals if security review is missing.
 * 4. Exposes `b2b_calculate_arr_discount` MCP AI tool for automated enterprise pricing quotes.
 * 5. Registers `b2b:quote` CLI subcommand for terminal pricing calculations.
 */
import { z } from "zod";
import type { EmbodyPlugin } from "@embody/kernel";

export const b2bSaasPlugin: EmbodyPlugin = {
  id: "b2b-saas",
  schema: "b2b_saas",
  dependsOn: ["core", "crm"],
  capabilities: {
    entities: ["b2b.account", "b2b.contract"],
    hooks: ["crm.deal.beforeUpdate"],
    services: {
      provide: ["b2b.pricing"],
      consume: ["core.registry"],
    },
    events: {
      publish: ["b2b.contract.signed"],
    },
  },

  provides(ctx) {
    return [
      {
        name: "b2b.pricing",
        version: "1.0.0",
        impl: {
          calculateArrDiscount: (baseArr: number, contractMonths: number): number => {
            ctx.logger.info(`Calculating B2B discount for ARR $${baseArr} over ${contractMonths} months`);
            if (contractMonths >= 24) {
              return baseArr * 0.85;
            }
            return baseArr;
          },
        },
      },
    ];
  },

  init(ctx) {
    ctx.logger.info("B2B SaaS custom plugin initialised!");
  },

  registerRoutes(router) {
    // Liveness/info only. Deal writes belong to @embody/crm, which runs them through
    // the plugin-sdk so this plugin's veto below actually gates them. (The old
    // /api/b2b/quote and /api/b2b/update-stage demo routes are gone: they bypassed
    // tenancy and authorization, and update-stage rebuilt the hook payload from a
    // handful of body fields, silently dropping the rest — so rules that keyed off
    // any other field never fired and the call wrongly reported success.)
    router.get("/b2b-saas", (c) => c.json({ app: "b2b-saas", plugin: "b2bSaasPlugin" }));
  },

  registerHooks(hooks, ctx) {
    // Vetoable Domain Hook: Prevent closing deals over $50k unless security_review_passed is true
    hooks.register("crm.deal.beforeUpdate", async (payload: unknown) => {
      const deal = payload as {
        stage?: string;
        amount?: number | string;
        title?: string;
        custom_fields?: Record<string, unknown>;
      };
      const dealAmount = Number(deal.amount ?? 0);
      const stage = deal.stage;

      if (stage === "closed_won" && dealAmount >= 50000) {
        const customFields = deal.custom_fields ?? {};
        const securityReviewPassed = customFields.security_review_passed === true;

        if (!securityReviewPassed) {
          ctx.logger.warn(`VETO: Deal '${deal.title}' ($${dealAmount}) blocked from closing without Security Review.`);
          throw new Error(
            `Veto: Enterprise deals over $50,000 require an approved Security Review before moving to 'closed_won'.`
          );
        }
      }
    });
  },

  registerMcpTools(mcp) {
    mcp.tool({
      name: "b2b_calculate_arr_discount",
      description:
        "Calculate annual recurring revenue (ARR) pricing discount for B2B enterprise software contracts.",
      input: z.object({
        baseArr: z.number().positive(),
        contractMonths: z.number().int().positive(),
      }),
      handler: (input, req) => {
        req.assert("read", "crm:deal");
        const discountedArr = input.contractMonths >= 24 ? input.baseArr * 0.85 : input.baseArr;
        const totalContractValue = (discountedArr / 12) * input.contractMonths;

        return {
          baseArr: input.baseArr,
          contractMonths: input.contractMonths,
          discountedArr,
          totalContractValue,
          discountApplied: input.contractMonths >= 24 ? "15% Multi-Year Discount" : "None",
        };
      },
    });
  },

  registerCliCommands(cli, ctx) {
    cli.command({
      name: "b2b:quote",
      description: "Generate an enterprise B2B pricing quote for a contract term.",
      options: [
        { flags: "--arr <amount>", description: "Base annual recurring revenue ($)" },
        { flags: "--months <months>", description: "Contract length in months", defaultValue: "12" },
      ],
      handler: (cmdCtx) => {
        const baseArr = Number(cmdCtx.options.arr ?? 100000);
        const contractMonths = Number(cmdCtx.options.months ?? 12);

        ctx.logger.info(`CLI Command: b2b:quote ARR=$${baseArr}, Months=${contractMonths}`);
        const discountedArr = contractMonths >= 24 ? baseArr * 0.85 : baseArr;

        return {
          command: "b2b:quote",
          baseArr,
          contractMonths,
          discountedArr,
          totalContractValue: (discountedArr / 12) * contractMonths,
          discountApplied: contractMonths >= 24 ? "15% Multi-Year Commitment Discount" : "None",
        };
      },
    });
  },
};
