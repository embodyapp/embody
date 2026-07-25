/**
 * Core services published into the DI registry for other plugins to consume.
 *
 * These are pure functions that take a tenant-scoped transaction (`tx`, obtained via
 * withTenant so RLS is active) plus arguments. They never hold a connection of their
 * own — the request-path caller supplies the tx. This keeps tenancy enforced at one
 * place and services composable.
 */
import type { Sql } from "@embody/db";

// ---------- core.registry ----------

export interface RegisterEntityInput {
  orgId: string;
  type: string; // e.g. 'crm.deal'
  sourceSchema: string;
  sourceTable: string;
  sourceId: string;
  displayLabel: string;
}

export interface RelateInput {
  orgId: string;
  fromEntityId: string;
  toEntityId: string;
  kind: string;
}

export interface SearchHit {
  id: string;
  type: string;
  displayLabel: string;
}

export interface RegistryService {
  /** Upsert a registry pointer for a typed row; returns its entity id. */
  register(tx: Sql, input: RegisterEntityInput): Promise<string>;
  /** Look up an entity id by its source row. */
  entityIdForSource(
    tx: Sql,
    source: { sourceSchema: string; sourceTable: string; sourceId: string },
  ): Promise<string | null>;
  /** Create a directed relationship edge between two entities. */
  relate(tx: Sql, input: RelateInput): Promise<void>;
  /** Full-text search across every entity type in the current org. */
  search(tx: Sql, query: string, limit?: number): Promise<SearchHit[]>;
  /** Every entity linked (out-edges) from the given entity — the cross-app graph. */
  linkedFrom(tx: Sql, fromEntityId: string): Promise<SearchHit[]>;
}

export const registryService: RegistryService = {
  async register(tx, input) {
    const [row] = await tx<{ id: string }[]>`
      insert into core.entities
        (org_id, type, source_schema, source_table, source_id, display_label)
      values
        (${input.orgId}, ${input.type}, ${input.sourceSchema}, ${input.sourceTable},
         ${input.sourceId}, ${input.displayLabel})
      on conflict (source_schema, source_table, source_id)
        do update set display_label = excluded.display_label, type = excluded.type
      returning id
    `;
    return row!.id;
  },

  async entityIdForSource(tx, source) {
    const rows = await tx<{ id: string }[]>`
      select id from core.entities
      where source_schema = ${source.sourceSchema}
        and source_table = ${source.sourceTable}
        and source_id = ${source.sourceId}
      limit 1
    `;
    return rows[0]?.id ?? null;
  },

  async relate(tx, input) {
    await tx`
      insert into core.entity_relationships (org_id, from_entity_id, to_entity_id, kind)
      values (${input.orgId}, ${input.fromEntityId}, ${input.toEntityId}, ${input.kind})
      on conflict (org_id, from_entity_id, to_entity_id, kind) do nothing
    `;
  },

  async search(tx, query, limit = 20) {
    return tx<SearchHit[]>`
      select id, type, display_label as "displayLabel"
      from core.entities
      where search_vector @@ plainto_tsquery('simple', ${query})
      limit ${limit}
    `;
  },

  async linkedFrom(tx, fromEntityId) {
    return tx<SearchHit[]>`
      select e2.id, e2.type, e2.display_label as "displayLabel"
      from core.entity_relationships r
      join core.entities e2 on e2.id = r.to_entity_id
      where r.from_entity_id = ${fromEntityId}
    `;
  },
};

// ---------- core.parties ----------

export interface CreatePartyInput {
  orgId: string;
  kind: "person" | "organization";
  displayName: string;
  customFields?: Record<string, unknown>;
}

export interface Party {
  id: string;
  orgId: string;
  kind: string;
  displayName: string;
}

export interface PartyService {
  /** Create a shared party AND register it in the entity registry, atomically. */
  create(tx: Sql, input: CreatePartyInput): Promise<Party>;
}

export const partyService: PartyService = {
  async create(tx, input) {
    const [party] = await tx<Party[]>`
      insert into core.parties (org_id, kind, display_name, custom_fields)
      values (${input.orgId}, ${input.kind}, ${input.displayName},
              ${JSON.stringify(input.customFields ?? {})}::jsonb)
      returning id, org_id as "orgId", kind, display_name as "displayName"
    `;
    await registryService.register(tx, {
      orgId: input.orgId,
      type: "core.party",
      sourceSchema: "core",
      sourceTable: "parties",
      sourceId: party!.id,
      displayLabel: input.displayName,
    });
    return party!;
  },
};
