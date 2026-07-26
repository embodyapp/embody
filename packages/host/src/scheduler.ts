/**
 * The scheduler: cron triggers, expressed as events.
 *
 * A schedule row does not "run a job". It publishes a named event when it comes due,
 * and whatever cares about that event reacts — an automation workflow, a plugin
 * subscription, both. That keeps the number of trigger primitives at one: the
 * automation engine matches events and knows nothing about cron, and adding schedules
 * required no change to it.
 *
 * Publishing goes through the outbox like any other event, so a schedule that fires
 * while every subscriber is down is delivered when one comes back, and the worker's
 * retry and dead-lettering apply unchanged.
 */
import { CronExpressionParser } from "cron-parser";
import type { Sql } from "@embody/db";
import type { EventBus, Logger } from "@embody/kernel";

export interface ScheduleRow {
  id: string;
  org_id: string;
  name: string;
  cron: string;
  event_name: string;
  payload: unknown;
  timezone: string;
  next_run_at: Date | string;
}

/** Next occurrence strictly after `from`, or undefined if the expression is invalid. */
export function nextRun(cron: string, timezone: string, from: Date): Date | undefined {
  try {
    return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone })
      .next()
      .toDate();
  } catch {
    return undefined;
  }
}

export interface SchedulerOptions {
  sql: Sql;
  events: EventBus;
  logger: Logger;
  /** Schedules advanced per tick. Default 50. */
  batchSize?: number;
}

/**
 * Publish every due schedule and advance it. Returns how many fired.
 *
 * The claim and the advance share one transaction with `FOR UPDATE SKIP LOCKED`, so
 * two workers cannot both fire the same schedule, and a crash mid-tick re-fires at
 * most the batch it was holding rather than skipping it.
 */
export async function runDueSchedules(opts: SchedulerOptions): Promise<number> {
  const { sql, events, logger } = opts;
  const batchSize = opts.batchSize ?? 50;

  return sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    const due = await tx<ScheduleRow[]>`
      select id, org_id, name, cron, event_name, payload, timezone, next_run_at
      from embody.schedules
      where enabled and next_run_at <= now()
      order by next_run_at
      limit ${batchSize}
      for update skip locked
    `;
    if (due.length === 0) return 0;

    const now = new Date();
    let fired = 0;

    for (const schedule of due) {
      const upcoming = nextRun(schedule.cron, schedule.timezone, now);
      if (!upcoming) {
        // A malformed expression would otherwise be retried every tick forever. Park
        // it and say so, rather than filling the log with the same parse failure.
        logger.error("disabling schedule with an invalid cron expression", {
          schedule: schedule.name,
          cron: schedule.cron,
        });
        await tx`update embody.schedules set enabled = false where id = ${schedule.id}`;
        continue;
      }

      // Enlisted in this transaction, so the event and the advanced cursor commit
      // together: no firing twice, and no silently skipping an occurrence.
      await events.publish(
        {
          name: schedule.event_name,
          orgId: schedule.org_id,
          payload: { schedule: schedule.name, ...(schedule.payload as object) },
          at: now,
        },
        tx,
      );
      await tx`
        update embody.schedules
        set last_run_at = ${now.toISOString()}::timestamptz,
            next_run_at = ${upcoming.toISOString()}::timestamptz
        where id = ${schedule.id}
      `;
      fired++;
      logger.info("schedule fired", { schedule: schedule.name, event: schedule.event_name });
    }
    return fired;
  });
}
