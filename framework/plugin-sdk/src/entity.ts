/**
 * `defineEntity` — the write path every plugin should build on.
 *
 * Registering a vetoable hook is only half a contract: something has to *run* the
 * chain around the real write, or the rule is decorative. That "something" is this
 * file. A repository returned by `defineEntity` guarantees, for every create/update/
 * delete:
 *
 *   1. hooks see the **whole row**, not the caller's partial patch — a rule that keys
 *      off a field the caller didn't send still fires;
 *   2. the `before*` chain runs **inside the caller's tenant transaction**, so a
 *      handler that throws rolls the write back. That is what a veto *is*;
 *   3. handlers get the transaction (`ctx.tx`) and may read related rows before
 *      deciding;
 *   4. the registry pointer is written in the same transaction, so search can never
 *      see a row the write rolled back;
 *   5. the domain event publishes only **after commit** (Decision D5).
 *
 * A plugin may only drive hooks for entity types it declared in
 * `capabilities.entities` — the kernel scopes hook *registration*, and this scopes
 * hook *invocation*.
 */
import type { Sql } from "@embody/db";
import type { KernelContext, RequestContext } from "@embody/kernel";
import type { RegistryService } from "@embody/core";

/** A row as it comes back from Postgres: plain columns keyed by column name. */
export type EntityRow = Record<string, unknown>;

export interface EntitySpec<Row extends EntityRow> {
  /** Namespaced entity type, e.g. "crm.deal". Drives hook and event names. */
  type: string;
  /** Postgres schema owning the table, e.g. "crm". */
  schema: string;
  /** Table name, e.g. "deals". */
  table: string;
  /**
   * Columns callers may write, in snake_case. `org_id`, `id` and the timestamp
   * columns are managed here and must not be listed.
   */
  columns: readonly string[];
  /**
   * jsonb columns. On update these are **merged** key-by-key with the stored value
   * rather than replaced, so a caller patching one custom field cannot silently drop
   * the others (the bug that made customer veto rules invisible).
   */
  jsonbColumns?: readonly string[];
  /** Human label for the registry / global search. */
  label: (row: Row) => string;
  /** Register rows in `core.entities` for cross-app search. Default true. */
  register?: boolean;
  /** Publish `<type>.created|updated|deleted` after commit. Default true. */
  event?: boolean;
  /** Column holding the last-modified timestamp, bumped on update. Default "updated_at". */
  updatedAtColumn?: string | null;
}

export interface EntityRepository<Row extends EntityRow> {
  /** The entity type, e.g. "crm.deal". */
  readonly type: string;
  create(req: RequestContext, values: Partial<Row>): Promise<Row>;
  /** Merge `patch` into the stored row, running the veto chain on the merged result. */
  update(req: RequestContext, id: string, patch: Partial<Row>): Promise<Row>;
  remove(req: RequestContext, id: string): Promise<Row>;
  get(req: RequestContext, id: string): Promise<Row | null>;
  /**
   * Link this row to another entity in the cross-app graph (Decision D2/D3). Runs in
   * the caller's transaction so the edge commits with the write that created it.
   */
  link(
    tx: Sql,
    orgId: string,
    fromRow: Row,
    to: { schema: string; table: string; id: string },
    kind: string,
  ): Promise<void>;
}

/** Thrown when an id does not resolve in the caller's org (RLS makes these identical). */
export class EntityNotFoundError extends Error {
  constructor(type: string, id: string) {
    super(`${type} ${id} not found in this org`);
    this.name = "EntityNotFoundError";
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Merge a caller's patch onto the stored row. jsonb columns merge key-by-key so a
 * caller who patches one custom field cannot silently drop the rest — the exact
 * failure that let a customer's veto rule read stale/missing fields and pass.
 * Exported because it is the rule hooks depend on, and worth testing on its own.
 */
export function mergePatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  jsonbColumns: Iterable<string> = [],
): Record<string, unknown> {
  const jsonb = new Set(jsonbColumns);
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const base = current[key];
    merged[key] =
      jsonb.has(key) && isPlainObject(base) && isPlainObject(value)
        ? { ...base, ...value }
        : value;
  }
  return merged;
}

export function defineEntity<Row extends EntityRow = EntityRow>(
  ctx: KernelContext,
  spec: EntitySpec<Row>,
): EntityRepository<Row> {
  const declared = ctx.capabilities.entities ?? [];
  if (!declared.includes(spec.type)) {
    throw new Error(
      `Plugin "${ctx.pluginId}" defined entity "${spec.type}" without declaring it. ` +
        `Add it to capabilities.entities.`,
    );
  }

  const jsonb = new Set(spec.jsonbColumns ?? []);
  const shouldRegister = spec.register ?? true;
  const shouldEmit = spec.event ?? true;
  const updatedAt = spec.updatedAtColumn === undefined ? "updated_at" : spec.updatedAtColumn;
  // Resolved once at registration time; `undefined` when the plugin didn't declare
  // core.registry as a consumed service, in which case rows simply aren't registered.
  const registry = shouldRegister
    ? ctx.services.get<RegistryService>("core.registry")
    : undefined;

  /** Run a hook chain with the transaction attached, so handlers may query. */
  const runHooks = <T>(phase: string, payload: T, tx: Sql): Promise<T> =>
    ctx.hooks.run(`${spec.type}.${phase}`, payload, { ...ctx, tx });

  const selectOne = async (tx: Sql, id: string): Promise<Row | undefined> => {
    const rows = await tx<Row[]>`
      select * from ${tx(spec.schema)}.${tx(spec.table)} where id = ${id} limit 1
    `;
    return rows[0];
  };

  /** Keep only writable columns, and coerce jsonb values for postgres.js. */
  const writable = (values: Partial<Row>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const col of spec.columns) {
      if (!(col in values)) continue;
      const v = (values as Record<string, unknown>)[col];
      out[col] = jsonb.has(col) ? JSON.stringify(v ?? {}) : v;
    }
    return out;
  };

  const registerRow = async (tx: Sql, orgId: string, row: Row): Promise<void> => {
    if (!registry) return;
    await registry.register(tx, {
      orgId,
      type: spec.type,
      sourceSchema: spec.schema,
      sourceTable: spec.table,
      sourceId: String(row.id),
      displayLabel: spec.label(row),
    });
  };

  const emit = async (verb: string, orgId: string, row: Row): Promise<void> => {
    if (!shouldEmit) return;
    await ctx.events.publish({ name: `${spec.type}.${verb}`, orgId, payload: row });
  };

  return {
    type: spec.type,

    async create(req, values) {
      const row = await req.tx(async (tx) => {
        // Hooks see the full proposed row, org included, before anything is written.
        const proposed = await runHooks("beforeCreate", { ...values, org_id: req.orgId }, tx);
        const cols = { ...writable(proposed as Partial<Row>), org_id: req.orgId };
        const [created] = await tx<Row[]>`
          insert into ${tx(spec.schema)}.${tx(spec.table)} ${tx(cols)} returning *
        `;
        await registerRow(tx, req.orgId, created!);
        await runHooks("afterCreate", created!, tx);
        return created!;
      });
      await emit("created", req.orgId, row);
      return row;
    },

    async update(req, id, patch) {
      const row = await req.tx(async (tx) => {
        const current = await selectOne(tx, id);
        if (!current) throw new EntityNotFoundError(spec.type, id);

        // Merge BEFORE the hooks run: a rule keyed off a field the caller never sent
        // (an industry vertical, a review flag) still sees it. jsonb merges key-wise.
        const merged = mergePatch(current, patch as Record<string, unknown>, jsonb);

        // A throw here aborts the transaction — nothing is written. That is the veto.
        const vetted = (await runHooks("beforeUpdate", merged, tx)) as Row;

        // The merge above carries every writable column through, so `cols` is only
        // empty for an entity with no writable columns at all.
        const cols = writable(vetted as Partial<Row>);
        // Stamped by Postgres, not the client: one clock, consistent with the
        // created_at default. Appended as a fragment because the dynamic-columns
        // helper can only bind values, not expressions.
        const bump = updatedAt ? tx`, ${tx(updatedAt)} = now()` : tx``;
        const [saved] = await tx<Row[]>`
          update ${tx(spec.schema)}.${tx(spec.table)} set ${tx(cols)}${bump}
          where id = ${id} returning *
        `;
        if (!saved) throw new EntityNotFoundError(spec.type, id);
        await registerRow(tx, req.orgId, saved);
        await runHooks("afterUpdate", saved, tx);
        return saved;
      });
      await emit("updated", req.orgId, row);
      return row;
    },

    async remove(req, id) {
      const row = await req.tx(async (tx) => {
        const current = await selectOne(tx, id);
        if (!current) throw new EntityNotFoundError(spec.type, id);
        await runHooks("beforeDelete", current, tx);
        await tx`delete from ${tx(spec.schema)}.${tx(spec.table)} where id = ${id}`;
        await runHooks("afterDelete", current, tx);
        return current;
      });
      await emit("deleted", req.orgId, row);
      return row;
    },

    async get(req, id) {
      return req.tx(async (tx) => (await selectOne(tx, id)) ?? null);
    },

    async link(tx, orgId, fromRow, to, kind) {
      if (!registry) return;
      const fromEntityId = await registry.entityIdForSource(tx, {
        sourceSchema: spec.schema,
        sourceTable: spec.table,
        sourceId: String(fromRow.id),
      });
      const toEntityId = await registry.entityIdForSource(tx, {
        sourceSchema: to.schema,
        sourceTable: to.table,
        sourceId: to.id,
      });
      if (!fromEntityId || !toEntityId) return;
      await registry.relate(tx, { orgId, fromEntityId, toEntityId, kind });
    },
  };
}
