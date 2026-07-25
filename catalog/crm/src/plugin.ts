/**
 * @embody/crm plugin. A first-party, *selectable* app in the embody catalog: a
 * deployment enables it via its `embody.config.ts`. Owns the `crm` Postgres schema
 * (deals) and depends on `core` for shared parties + the registry (Decision D3).
 *
 * Deal writes go through `defineEntity` from @embody/plugin-sdk rather than raw SQL.
 * That is deliberate: the SDK runs the `crm.deal.before*` / `after*` hook chains inside
 * the tenant transaction, so a rule registered by ANOTHER plugin — a first-party app
 * like b2b-saas, or a company's own plugin under custom/ — genuinely blocks the write.
 * A hook that throws rolls the transaction back; nothing is persisted.
 */
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { EmbodyPlugin, KernelContext } from "@embody/kernel";
import { defineEntity, type EntityRepository } from "@embody/plugin-sdk";

/** Absolute path to this plugin's SQL migration directory. */
export const crmMigrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Row shape of `crm.deals`, as returned by Postgres (snake_case columns). */
export interface DealRow {
  id: string;
  org_id: string;
  party_id: string | null;
  title: string;
  stage: string;
  amount: string | null;
  custom_fields: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The deal repository, memoised per KernelContext (i.e. per boot) so several kernels
 * in one process — as tests do — never share or clobber one another's instance.
 */
const repos = new WeakMap<KernelContext, EntityRepository<DealRow>>();

function dealsFor(ctx: KernelContext): EntityRepository<DealRow> {
  let repo = repos.get(ctx);
  if (!repo) {
    repo = defineEntity<DealRow>(ctx, {
      type: "crm.deal",
      schema: "crm",
      table: "deals",
      columns: ["party_id", "title", "stage", "amount", "custom_fields"],
      // Merged key-by-key on update, so patching one custom field never drops the
      // rest — the fields another plugin's veto rule reads stay intact.
      jsonbColumns: ["custom_fields"],
      label: (row) => row.title,
    });
    repos.set(ctx, repo);
  }
  return repo;
}

export const crmPlugin: EmbodyPlugin = {
  id: "crm",
  schema: "crm",
  dependsOn: ["core"],
  capabilities: {
    entities: ["crm.deal"],
    // Own the post-create step that links a deal to its party in the cross-app graph.
    hooks: ["crm.deal.afterCreate"],
    // Consume the core registry so a new deal is registered (searchable) and linked
    // to its party (the cross-app graph, Decision D2/D3).
    services: { consume: ["core.registry"] },
    events: { publish: ["crm.deal.created", "crm.deal.updated", "crm.deal.deleted"] },
  },
  migrations: { dir: crmMigrationsDir, schema: "crm" },

  init(ctx) {
    dealsFor(ctx);
    ctx.logger.info("crm plugin initialised");
  },

  registerHooks(hooks, ctx) {
    const deals = dealsFor(ctx);
    // Link the new deal to its party. Runs inside the same transaction as the insert
    // (the SDK passes the tx on the hook's ctx), so edge and row commit together.
    hooks.register("crm.deal.afterCreate", async (row: DealRow, hookCtx) => {
      if (!row.party_id || !hookCtx.tx) return;
      await deals.link(
        hookCtx.tx,
        row.org_id,
        row,
        { schema: "core", table: "parties", id: row.party_id },
        "deal_for_party",
      );
    });
  },

  registerRoutes(router) {
    // Minimal liveness/info route. Data access is via MCP tools through the executor,
    // which is the only path with tenancy (RLS) and authorization applied.
    router.get("/crm", (c) => c.json({ app: "crm", entities: ["crm.deal"] }));
  },

  // Agent-callable actions. Each runs through the executor: RBAC-checked, then inside
  // a tenant-scoped transaction with RLS active.
  registerMcpTools(mcp, ctx) {
    const deals = dealsFor(ctx);

    mcp.tool({
      name: "crm_create_deal",
      description:
        "Create a deal in the current org. Registers it for global search and, if a " +
        "partyId is given, links the deal to that account/contact.",
      input: z.object({
        title: z.string().min(1),
        stage: z.string().optional(),
        amount: z.number().nonnegative().optional(),
        partyId: z.string().uuid().optional(),
        customFields: z.record(z.unknown()).optional(),
      }),
      handler: (input, req) => {
        req.assert("write", "crm:deal");
        return deals.create(req, {
          title: input.title,
          stage: input.stage ?? "lead",
          amount: input.amount?.toString() ?? null,
          party_id: input.partyId ?? null,
          custom_fields: input.customFields ?? {},
        });
      },
    });

    mcp.tool({
      name: "crm_update_deal",
      description:
        "Update a deal in the current org. Only the fields you supply change; custom " +
        "fields are merged, not replaced. Domain rules registered by other enabled " +
        "plugins run first and may reject the update.",
      input: z.object({
        id: z.string().uuid(),
        title: z.string().min(1).optional(),
        stage: z.string().optional(),
        amount: z.number().nonnegative().optional(),
        partyId: z.string().uuid().optional(),
        customFields: z.record(z.unknown()).optional(),
      }),
      handler: (input, req) => {
        req.assert("write", "crm:deal");
        const patch: Partial<DealRow> = {};
        if (input.title !== undefined) patch.title = input.title;
        if (input.stage !== undefined) patch.stage = input.stage;
        if (input.amount !== undefined) patch.amount = input.amount.toString();
        if (input.partyId !== undefined) patch.party_id = input.partyId;
        if (input.customFields !== undefined) patch.custom_fields = input.customFields;
        return deals.update(req, input.id, patch);
      },
    });

    mcp.tool({
      name: "crm_get_deal",
      description: "Fetch a single deal by id from the current org.",
      input: z.object({ id: z.string().uuid() }),
      handler: (input, req) => {
        req.assert("read", "crm:deal");
        return deals.get(req, input.id);
      },
    });

    mcp.tool({
      name: "crm_query_deals",
      description: "List deals in the current org, optionally filtered by stage.",
      input: z.object({
        stage: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
      }),
      handler: (input, req) => {
        req.assert("read", "crm:deal");
        const limit = input.limit ?? 50;
        return req.tx(async (tx) => {
          const rows = input.stage
            ? await tx<DealRow[]>`
                select id, org_id, party_id, title, stage, amount, custom_fields
                from crm.deals where stage = ${input.stage}
                order by created_at desc limit ${limit}`
            : await tx<DealRow[]>`
                select id, org_id, party_id, title, stage, amount, custom_fields
                from crm.deals order by created_at desc limit ${limit}`;
          return rows;
        });
      },
    });
  },
};
