/**
 * The outbox worker — the half of Decision D5 that turns a durable log into delivery.
 *
 * `OutboxEventBus.publish` only appends to `embody.outbox`, inside the transaction
 * that made the change. This process is what drains it, in two phases per tick:
 *
 *   1. FAN OUT  — claim un-expanded outbox rows and write one `outbox_deliveries` row
 *                 per matching subscription. Fan-out cannot happen at publish time
 *                 because subscribers are only known to a booted process, and the
 *                 publisher may be a web process with a different plugin set.
 *   2. DISPATCH — claim due deliveries and run the subscriber, retrying each one
 *                 independently so a broken subscriber cannot starve its siblings.
 *
 * Claiming is a short transaction that stamps the row, NOT a lock held across the
 * handler. Subscribers do their own database work through `ctx.tx`, which takes
 * another connection from the pool; holding the claim transaction open around that
 * invites pool exhaustion and deadlock. The cost of the short claim is that a process
 * killed mid-handler leaves a row in `claimed`, so every tick also resets claims older
 * than `claimTimeoutMs`. Because `attempts` is incremented at claim time rather than
 * on failure, even a handler that crashes the process every time still converges to
 * `dead` instead of looping forever.
 *
 * Delivery is therefore at-least-once: a handler that succeeds and then loses the
 * process before being marked `done` runs again. Subscribers must be idempotent.
 */
import type { Sql } from "@embody/db";
import type { DomainEvent, Logger, Subscription } from "@embody/kernel";
import type { Runtime } from "./runtime.ts";
import { runDueSchedules } from "./scheduler.ts";

export interface WorkerOptions {
  runtime: Runtime;
  /** Deliveries claimed per tick. Default 20. */
  batchSize?: number;
  /** Idle poll interval in ms. Default 1000. */
  pollIntervalMs?: number;
  /** Attempts before a delivery is parked as `dead`. Default 5. */
  maxAttempts?: number;
  /** A `claimed` row older than this is assumed orphaned and retried. Default 60_000. */
  claimTimeoutMs?: number;
  /**
   * Start the poll loop immediately. Default true. Tests set it false and drive
   * `tick()` by hand — otherwise the loop races their assertions.
   */
  autoStart?: boolean;
  /** Also fire due cron schedules. Default true. */
  schedules?: boolean;
  logger?: Logger;
}

export interface RunningWorker {
  /** Stop after the in-flight tick finishes. */
  stop(): Promise<void>;
  /**
   * Run exactly one fan-out + dispatch pass and return how many deliveries were
   * attempted. Exposed so tests can drive the worker deterministically instead of
   * sleeping on the poll loop.
   */
  tick(): Promise<number>;
}

interface OutboxRow {
  id: string;
  org_id: string;
  name: string;
  payload: unknown;
  /** Whatever the driver hands back for timestamptz — a Date here, a string there. */
  at: Date | string;
}

interface DeliveryRow extends OutboxRow {
  delivery_id: string;
  subscriber: string;
  attempts: number;
}

/** Sorts before every generated uuid, so a fresh cursor scans from its timestamp on. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Exponential backoff, capped at 5 minutes. */
function backoffSeconds(attempts: number): number {
  return Math.min(2 ** attempts, 300);
}

export function startWorker(opts: WorkerOptions): RunningWorker {
  const { runtime } = opts;
  const sql = runtime.ownerDb.sql; // owner: the worker must see every tenant
  const batchSize = opts.batchSize ?? 20;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const maxAttempts = opts.maxAttempts ?? 5;
  const claimTimeoutMs = opts.claimTimeoutMs ?? 60_000;
  const schedules = opts.schedules ?? true;
  const logger = opts.logger ?? runtime.logger;
  const subscriptions = runtime.booted.events.subscriptions;

  let stopped = false;
  let loop: Promise<void> | undefined;

  /**
   * A new subscriber's starting point.
   *
   * Captured when the worker is constructed rather than read as `now()` when the
   * cursor row is finally written: the first tick happens after the process has been
   * up for a while, and anchoring to tick time would skip every event published in
   * between. An existing cursor is never touched (`on conflict do nothing`), so a
   * worker restarting after downtime still picks up everything it missed.
   */
  const startedAt = new Date().toISOString();

  /**
   * Make sure every subscription this process holds has a cursor.
   *
   * A brand-new subscriber starts at *now*, not at the beginning of time. Enabling a
   * plugin should not replay every event the system has ever recorded through its
   * brand-new handler.
   */
  async function ensureCursors(): Promise<void> {
    if (subscriptions.all.length === 0) return;

    // Where a subscriber that has never run should begin.
    //
    // "Now" is wrong: the first time a worker is ever started, every event published
    // before it would be silently dropped — you deploy, events accumulate, you add the
    // worker, and the backlog vanishes without a trace.
    //
    // "The beginning" is also wrong: outbox rows are retained after delivery, so
    // enabling one new plugin would replay the entire history through its brand-new
    // handler.
    //
    // The distinguishing fact is whether anything has consumed an event at all. Rows
    // with no delivery whatsoever are a genuine backlog nobody has processed; rows
    // some other subscriber already took are history this one missed by not existing.
    // So a new cursor starts at the oldest *unconsumed* event, and otherwise at now.
    const [backlog] = await sql<{ at: Date | string | null }[]>`
      select min(o.at) as at from embody.outbox o
      where not exists (
        select 1 from embody.outbox_deliveries d where d.outbox_id = o.id
      )
    `;
    const start = backlog?.at
      ? new Date(backlog.at instanceof Date ? backlog.at : String(backlog.at)).toISOString()
      : startedAt;

    for (const sub of subscriptions.all) {
      await sql`
        insert into embody.outbox_cursors (subscriber, last_at, last_id)
        values (${sub.id}, ${start}::timestamptz, ${NIL_UUID})
        on conflict (subscriber) do nothing
      `;
    }
  }

  /**
   * Phase 1: expand outbox rows into one delivery per matching subscriber.
   *
   * Scans from the *oldest* cursor this process holds, then decides per subscriber
   * whether each event is actually after that subscriber's own cursor. Advancing every
   * cursor to the end of the scanned batch keeps them moving together while remaining
   * correct for subscribers that were already further ahead.
   */
  async function fanOut(): Promise<number> {
    const subs = subscriptions.all;
    if (subs.length === 0) return 0;

    // postgres.js types the callback's handle as TransactionSql; the codebase's
    // convention (see withTenant in @embody/db) is to narrow it to Sql here.
    return sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      const cursors = await tx<{ subscriber: string; last_at: Date | string; last_id: string | null }[]>`
        select subscriber, last_at, last_id from embody.outbox_cursors
        where subscriber in ${tx(subs.map((s) => s.id))}
        for update
      `;
      if (cursors.length === 0) return 0;

      const at = (v: Date | string) => (v instanceof Date ? v : new Date(v)).getTime();
      const oldest = cursors.reduce((min, c) => (at(c.last_at) < at(min.last_at) ? c : min));

      // Row comparison on (at, id) gives a total order and a stable resumption point
      // for events sharing a timestamp. `last_id` is never NULL — a fresh cursor uses
      // the nil UUID — because a NULL inside a row comparison makes it NULL, not true,
      // and the scan would silently return nothing.
      const events = await tx<OutboxRow[]>`
        select id, org_id, name, payload, at
        from embody.outbox
        where (at, id) > (${new Date(at(oldest.last_at)).toISOString()}::timestamptz,
                          ${oldest.last_id ?? NIL_UUID}::uuid)
        order by at, id
        limit ${batchSize}
      `;
      if (events.length === 0) return 0;

      const byId = new Map(cursors.map((c) => [c.subscriber, c]));
      for (const event of events) {
        for (const sub of subscriptions.matching(event.name)) {
          const cursor = byId.get(sub.id);
          // Skip what this particular subscriber has already passed: the scan started
          // at the oldest cursor, which may be behind this one.
          if (cursor && at(event.at) < at(cursor.last_at)) continue;
          // Idempotent on (outbox_id, subscriber), so a crash mid-batch is harmless.
          await tx`
            insert into embody.outbox_deliveries (outbox_id, subscriber)
            values (${event.id}, ${sub.id})
            on conflict (outbox_id, subscriber) do nothing
          `;
        }
      }

      const last = events[events.length - 1]!;
      await tx`
        update embody.outbox_cursors
        set last_at = ${new Date(at(last.at)).toISOString()}::timestamptz,
            last_id = ${last.id}, updated_at = now()
        where subscriber in ${tx(subs.map((s) => s.id))}
      `;
      return events.length;
    });
  }

  /** Return orphaned claims (process died mid-handler) to the queue. */
  async function reapStaleClaims(): Promise<void> {
    await sql`
      update embody.outbox_deliveries
      set status = 'pending'
      where status = 'claimed'
        and claimed_at < now() - ${`${Math.ceil(claimTimeoutMs / 1000)} seconds`}::interval
    `;
  }

  /**
   * Phase 2: claim due deliveries in one short transaction.
   *
   * Restricted to subscribers this process actually holds. Without that filter a
   * worker claims another deployment's deliveries, finds no handler, and has to put
   * them back — burning a claim and delaying them every time it polls. Two deployables
   * sharing a database would spend their time bouncing each other's work.
   */
  async function claim(): Promise<DeliveryRow[]> {
    const mine = subscriptions.all.map((s) => s.id);
    if (mine.length === 0) return [];

    const rows = await sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      const due = await tx<{ id: string }[]>`
        select id from embody.outbox_deliveries
        where status = 'pending' and next_run_at <= now()
          and subscriber in ${tx(mine)}
        order by next_run_at
        limit ${batchSize}
        for update skip locked
      `;
      if (due.length === 0) return [];
      return tx<DeliveryRow[]>`
        update embody.outbox_deliveries d
        set status = 'claimed', claimed_at = now(), attempts = d.attempts + 1
        from embody.outbox o
        where d.id in ${tx(due.map((r) => r.id))} and o.id = d.outbox_id
        returning d.id as delivery_id, d.subscriber, d.attempts,
                  o.id, o.org_id, o.name, o.payload, o.at
      `;
    });
    return rows as unknown as DeliveryRow[];
  }

  async function runOne(row: DeliveryRow, sub: Subscription): Promise<void> {
    const event: DomainEvent = {
      name: row.name,
      orgId: row.org_id,
      payload: row.payload,
      // `DomainEvent.at` is typed `Date` and subscribers rely on that, but this
      // driver returns timestamptz as a string. Passing the raw column through made
      // every subscriber that touched `at` fail with "toISOString is not a function".
      at: row.at instanceof Date ? row.at : new Date(row.at),
    };
    try {
      await sub.handler(event);
      await sql`
        update embody.outbox_deliveries
        set status = 'done', last_error = null where id = ${row.delivery_id}
      `;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const dead = row.attempts >= maxAttempts;
      await sql`
        update embody.outbox_deliveries
        set status = ${dead ? "dead" : "pending"},
            last_error = ${message},
            next_run_at = now() + ${`${backoffSeconds(row.attempts)} seconds`}::interval
        where id = ${row.delivery_id}
      `;
      logger[dead ? "error" : "warn"](
        dead ? "event delivery dead-lettered" : "event delivery failed, will retry",
        { event: row.name, subscriber: row.subscriber, attempts: row.attempts, error: message },
      );
    }
  }

  async function tick(): Promise<number> {
    await ensureCursors();
    // Schedules first: a schedule that comes due publishes an event, and fanning out
    // in the same tick means it is delivered now rather than one poll interval later.
    if (schedules) {
      await runDueSchedules({ sql, events: runtime.booted.events, logger });
    }
    await fanOut();
    await reapStaleClaims();
    const claimed = await claim();
    for (const row of claimed) {
      // `claim` filters to this process's subscribers, so a miss here is impossible
      // rather than merely unlikely — but a delivery silently vanishing is bad enough
      // to be worth a loud line if it ever happens.
      const sub = subscriptions.get(row.subscriber);
      if (!sub) {
        logger.error("claimed a delivery with no matching subscription", {
          subscriber: row.subscriber,
        });
        continue;
      }
      await runOne(row, sub);
    }
    return claimed.length;
  }

  async function run(): Promise<void> {
    logger.info("outbox worker started", {
      subscriptions: subscriptions.all.map((s) => s.id),
      batchSize,
      pollIntervalMs,
    });
    while (!stopped) {
      try {
        const handled = await tick();
        // Only idle when there was nothing to do, so a backlog drains at full speed.
        if (handled === 0 && !stopped) await sleep(pollIntervalMs);
      } catch (err) {
        logger.error("outbox worker tick failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(pollIntervalMs);
      }
    }
    logger.info("outbox worker stopped");
  }

  if (opts.autoStart ?? true) loop = run();

  return {
    tick,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
