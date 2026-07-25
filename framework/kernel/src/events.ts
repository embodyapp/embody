/**
 * Event bus interface + an in-memory implementation.
 *
 * Events are asynchronous, post-commit notifications ("something happened"). Other
 * plugins subscribe and react, but cannot block or veto (that's what hooks are for).
 *
 * The in-memory impl is fine for tests and single-process dev. M3 replaces it with a
 * durable, Postgres-backed (outbox / pg-boss) implementation behind this SAME
 * interface, so plugins never change (Decision D5).
 */

export interface DomainEvent<T = unknown> {
  /** Namespaced event name, e.g. "crm.deal.created". */
  name: string;
  /** Owning tenant. */
  orgId: string;
  /** Event payload. */
  payload: T;
  /** When it occurred (defaults to now). */
  at?: Date;
}

export type EventHandler<T = unknown> = (
  event: DomainEvent<T>,
) => void | Promise<void>;

export interface EventBus {
  /** Publish an event to all matching subscribers. */
  publish<T>(event: DomainEvent<T>): Promise<void>;
  /**
   * Subscribe to events. `pattern` matches an event name exactly, or with a trailing
   * `.*` wildcard (e.g. "crm.*" matches "crm.deal.created").
   */
  subscribe<T>(pattern: string, handler: EventHandler<T>): void;
}

function matches(pattern: string, name: string): boolean {
  if (pattern === name || pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // keep trailing dot: "crm."
    return name.startsWith(prefix);
  }
  return false;
}

export class InMemoryEventBus implements EventBus {
  #subs: { pattern: string; handler: EventHandler }[] = [];

  subscribe<T>(pattern: string, handler: EventHandler<T>): void {
    this.#subs.push({ pattern, handler: handler as EventHandler });
  }

  async publish<T>(event: DomainEvent<T>): Promise<void> {
    const at = event.at ?? new Date();
    const enriched = { ...event, at };
    const targets = this.#subs.filter((s) => matches(s.pattern, event.name));
    // Deliver sequentially so test assertions are deterministic; a durable bus can
    // parallelise. Handler errors are isolated so one bad subscriber can't stop others.
    for (const { handler } of targets) {
      await handler(enriched);
    }
  }
}
