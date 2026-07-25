/**
 * embody-plugin-ecom-fulfillment plugin.
 * 
 * Reference E-Commerce Retailer extension plugin demonstrating how an e-commerce company
 * customizes the CRM without editing or forking core code:
 * 1. Declares capability permissions for e-commerce hooks, events, tools, and CLI subcommands.
 * 2. Registers synchronous domain hooks (`crm.deal.beforeCreate`) to auto-apply 15% VIP shopper discounts.
 * 3. Subscribes to post-commit domain events (`crm.deal.created`) to dispatch orders to warehouse fulfillment APIs.
 * 4. Exposes `ecom_track_shipment` MCP AI tool so customer support AI agents can track packages.
 * 5. Registers `ecom:track` CLI subcommand for support agents executing terminal package lookups.
 */
import { z } from "zod";
import type { EmbodyPlugin } from "@embody/kernel";

export const ecomFulfillmentPlugin: EmbodyPlugin = {
  id: "ecom-fulfillment",
  schema: "ecom_fulfillment",
  dependsOn: ["core", "crm"],
  capabilities: {
    entities: ["ecom.order", "ecom.shipment"],
    hooks: ["crm.deal.beforeCreate"],
    services: {
      consume: ["core.registry"],
    },
    events: {
      subscribe: ["crm.deal.created"],
      publish: ["ecom.shipment.dispatched"],
    },
  },

  init(ctx) {
    ctx.logger.info("E-Commerce Fulfillment custom plugin initialised!");
  },

  registerRoutes(router) {
    // Liveness/info only. The VIP-discount hook below now runs on the real
    // `crm_create_deal` write path via the plugin-sdk, so it applies to every caller
    // — agent, CLI, REST — instead of only to the old /api/ecom/place-order demo
    // route, which bypassed tenancy and authorization entirely.
    router.get("/ecom-fulfillment", (c) => c.json({ app: "ecom-fulfillment", plugin: "ecomFulfillmentPlugin" }));
  },

  registerHooks(hooks, ctx) {
    // Vetoable Domain Hook: Auto-apply 15% discount for Gold and Platinum VIP shoppers
    hooks.register("crm.deal.beforeCreate", async (payload: unknown) => {
      const deal = payload as {
        amount?: number | string;
        title?: string;
        custom_fields?: Record<string, unknown>;
      };
      const customFields = deal.custom_fields ?? {};
      const vipTier = customFields.vip_tier as string | undefined;

      if (vipTier === "Gold" || vipTier === "Platinum") {
        const originalAmount = Number(deal.amount ?? 0);
        if (originalAmount > 0) {
          const discountedAmount = (originalAmount * 0.85).toFixed(2);
          deal.amount = discountedAmount;
          ctx.logger.info(
            `Applied 15% ${vipTier} VIP discount to order '${deal.title}': $${originalAmount} -> $${discountedAmount}`
          );
        }
      }
    });
  },

  subscribe(bus, ctx) {
    // Durable Event Subscriber: Automatically dispatch order to warehouse on post-commit deal.created
    bus.subscribe("crm.deal.created", async (event) => {
      const { id, title, customFields } = event.payload as {
        id: string;
        title: string;
        customFields?: Record<string, unknown>;
      };

      const shippingMethod = (customFields?.shipping_method as string) ?? "Standard Ground";
      const trackingNumber = `TRK-${Math.floor(100000 + Math.random() * 900000)}`;

      ctx.logger.info(
        `[Warehouse Dispatch] Order '${title}' (ID: ${id}) dispatched via ${shippingMethod}. Tracking #: ${trackingNumber}`
      );

      // Publish durable ecom.shipment.dispatched event
      await ctx.events.publish({
        name: "ecom.shipment.dispatched",
        orgId: event.orgId,
        payload: {
          orderId: id,
          trackingNumber,
          shippingMethod,
          dispatchedAt: new Date().toISOString(),
        },
      });
    });
  },

  registerMcpTools(mcp) {
    mcp.tool({
      name: "ecom_track_shipment",
      description: "Lookup package shipping status and tracking number for an e-commerce order.",
      input: z.object({
        orderId: z.string().uuid(),
      }),
      handler: (input, req) => {
        req.assert("read", "crm:deal");

        return {
          orderId: input.orderId,
          status: "In Transit",
          carrier: "FedEx Express",
          estimatedDelivery: "Tomorrow by 5:00 PM",
          trackingNumber: `TRK-892341`,
        };
      },
    });
  },

  registerCliCommands(cli, ctx) {
    cli.command({
      name: "ecom:track",
      description: "Track shipment delivery status for an e-commerce order ID.",
      args: ["<orderId>"],
      handler: (cmdCtx) => {
        const orderId = cmdCtx.args[0] ?? "unknown-order-id";
        ctx.logger.info(`CLI Command: ecom:track OrderId=${orderId}`);

        return {
          command: "ecom:track",
          orderId,
          status: "In Transit",
          carrier: "FedEx Express",
          estimatedDelivery: "Tomorrow by 5:00 PM",
          trackingNumber: "TRK-892341",
        };
      },
    });
  },
};
