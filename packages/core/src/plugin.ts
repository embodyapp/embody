/**
 * @embody/core plugin. Owns the `core` Postgres schema (identity, shared entities,
 * registry) and publishes the `core.registry` and `core.parties` services that every
 * app plugin builds on (Decision D3).
 */
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { EmbodyPlugin, ServiceDescriptor } from "@embody/kernel";
import { registryService, partyService } from "./services.ts";

/** Absolute path to this plugin's SQL migration directory. */
export const coreMigrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

export const corePlugin: EmbodyPlugin = {
  id: "core",
  schema: "core",
  capabilities: {
    entities: ["core.party", "core.product", "core.document"],
    services: { provide: ["core.registry", "core.parties"] },
    events: { publish: ["core.party.created"] },
  },
  migrations: { dir: coreMigrationsDir, schema: "core" },

  provides(): ServiceDescriptor[] {
    return [
      { name: "core.registry", version: "1.0.0", impl: registryService },
      { name: "core.parties", version: "1.0.0", impl: partyService },
    ];
  },

  init(ctx) {
    ctx.logger.info("core plugin initialised");
  },

  // Agent-callable actions. Same authz as REST (Decision D4); every read/write runs
  // inside ctx.tx — a tenant-scoped transaction on the app role, so RLS applies.
  registerMcpTools(mcp, kernelCtx) {
    mcp.tool({
      name: "core_create_party",
      description:
        "Create a shared party (a person or organization) in the current org. " +
        "Parties are the accounts/contacts every app builds on.",
      input: z.object({
        kind: z.enum(["person", "organization"]),
        displayName: z.string().min(1),
        customFields: z.record(z.unknown()).optional(),
      }),
      handler: (input, ctx) => {
        ctx.assert("write", "core:party");
        return ctx.tx(async (tx) => {
          const party = await partyService.create(tx, {
            orgId: ctx.orgId,
            kind: input.kind,
            displayName: input.displayName,
            customFields: input.customFields,
          });
          // In the same transaction as the insert, like defineEntity does. The
          // manifest has always declared this event; until now nothing published it,
          // so a subscriber on core.party.created silently never fired.
          await kernelCtx.events.publish(
            { name: "core.party.created", orgId: ctx.orgId, payload: party },
            tx,
          );
          return party;
        });
      },
    });

    mcp.tool({
      name: "core_search",
      description:
        "Full-text search across every entity type (parties, deals, …) in the current org.",
      input: z.object({
        query: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
      }),
      handler: (input, ctx) => {
        ctx.assert("read", "core:entity");
        return ctx.tx((tx) => registryService.search(tx, input.query, input.limit));
      },
    });
  },
};
