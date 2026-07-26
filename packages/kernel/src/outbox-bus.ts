/**
 * The durable event bus (Decision D5).
 *
 * `publish` does not deliver. It appends the event to `embody.outbox` — and when the
 * caller passes its tenant transaction, it appends *inside that transaction*, so the
 * event and the data change it describes commit together or not at all. There is no
 * window in which a deal exists but `crm.deal.created` was lost, and none in which the
 * event fires for a write that was rolled back by a veto.
 *
 * Delivery is the worker's job (@embody/host `worker.ts`): it expands each outbox row
 * into one row per matching subscriber and retries them independently.
 */
import type { Sql } from "@embody/db";
import type { DomainEvent, EventBus, EventHandler } from "./events.ts";
import { SubscriptionRegistry } from "./events.ts";

export interface OutboxEventBusOptions {
  /**
   * OWNER-role handle, used only when `publish` is called without a transaction —
   * an out-of-band publish (the scheduler, a backfill) has no tenant transaction and
   * therefore no `app.current_org` for the RLS policy to read.
   */
  sql: Sql;
  /** Recorded on each row for debugging; typically the process/service name. */
  publishedBy?: string;
}

export class OutboxEventBus implements EventBus {
  readonly subscriptions = new SubscriptionRegistry();

  constructor(private readonly opts: OutboxEventBusOptions) {}

  subscribe<T>(pluginId: string, pattern: string, handler: EventHandler<T>): void {
    this.subscriptions.add(pluginId, pattern, handler);
  }

  async publish<T>(event: DomainEvent<T>, tx?: Sql): Promise<void> {
    // With a tx: enlisted in the tenant transaction, written by the app role under the
    // RLS policy (org_id must equal app.current_org, which withTenant already set).
    // Without: the owner handle, which bypasses RLS.
    const sql = tx ?? this.opts.sql;
    await sql`
      insert into embody.outbox (org_id, name, payload, at, published_by)
      values (
        ${event.orgId},
        ${event.name},
        ${JSON.stringify(event.payload ?? null)}::jsonb,
        -- ISO string + explicit cast, not a Date: postgres.js cannot infer a bind type
        -- for a Date here and fails at Bind with "must be of type string or Buffer".
        ${(event.at ?? new Date()).toISOString()}::timestamptz,
        ${this.opts.publishedBy ?? null}
      )
    `;
  }
}
