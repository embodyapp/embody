/**
 * Event bus: asynchronous, post-commit notifications ("something happened"). Other
 * plugins subscribe and react, but cannot block or veto (that's what hooks are for).
 *
 * Two implementations behind one interface (Decision D5):
 *   - `InMemoryEventBus` — delivers inline. Fine for tests and single-process dev.
 *   - `OutboxEventBus` (./outbox-bus.ts) — writes the event into `embody.outbox`
 *     inside the caller's transaction, so the event and the data change commit
 *     together; a worker process dispatches it later, with retries.
 *
 * Plugins never see either one. They get a `ScopedEventBus` (as `ctx.events` and as
 * the argument to `subscribe`) that binds their plugin id and enforces their
 * capability manifest, exactly as `ScopedHookRegistry` does for hooks.
 */
import type { Sql } from "@embody/db";
import type { Logger } from "./logger.ts";

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

/**
 * The runtime-facing bus. `publish` takes an optional transaction: pass the tenant
 * `tx` and a durable implementation enlists the event in it, which is the whole point
 * of the outbox. Implementations that deliver inline ignore it.
 */
export interface EventBus {
  publish<T>(event: DomainEvent<T>, tx?: Sql): Promise<void>;
  subscribe<T>(pluginId: string, pattern: string, handler: EventHandler<T>): void;
  /** Every subscription registered at boot. The worker fans events out across these. */
  readonly subscriptions: SubscriptionRegistry;
}

/** One plugin's registration against an event-name pattern. */
export interface Subscription {
  /**
   * Stable identifier, `<pluginId>:<pattern>`. It is written into
   * `embody.outbox_deliveries.subscriber`, so it must survive a restart: derive it
   * from what the plugin declared, never from registration order.
   */
  readonly id: string;
  readonly pluginId: string;
  readonly pattern: string;
  readonly handler: EventHandler;
}

/**
 * `pattern` matches an event name exactly, or with a trailing `.*` wildcard
 * (e.g. "crm.*" matches "crm.deal.created"), or `*` for everything.
 */
export function matches(pattern: string, name: string): boolean {
  if (pattern === name || pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // keep trailing dot: "crm."
    return name.startsWith(prefix);
  }
  return false;
}

/** The set of subscriptions a booted process holds. Shared by both bus impls. */
export class SubscriptionRegistry {
  #subs: Subscription[] = [];

  add<T>(pluginId: string, pattern: string, handler: EventHandler<T>): Subscription {
    let id = `${pluginId}:${pattern}`;
    // A plugin subscribing twice to the same pattern is degenerate, but the id lands
    // in a unique constraint, so disambiguate rather than silently collapsing them.
    for (let n = 2; this.#subs.some((s) => s.id === id); n++) id = `${pluginId}:${pattern}#${n}`;
    const sub: Subscription = { id, pluginId, pattern, handler: handler as EventHandler };
    this.#subs.push(sub);
    return sub;
  }

  /** Subscriptions whose pattern matches this event name. */
  matching(name: string): Subscription[] {
    return this.#subs.filter((s) => matches(s.pattern, name));
  }

  get(id: string): Subscription | undefined {
    return this.#subs.find((s) => s.id === id);
  }

  get all(): readonly Subscription[] {
    return this.#subs;
  }
}

/**
 * Delivers inline, in the publishing process. Events are lost on a crash and are not
 * atomic with the write that caused them — use `OutboxEventBus` in a real deployment.
 */
export class InMemoryEventBus implements EventBus {
  readonly subscriptions = new SubscriptionRegistry();

  constructor(private readonly logger?: Logger) {}

  subscribe<T>(pluginId: string, pattern: string, handler: EventHandler<T>): void {
    this.subscriptions.add(pluginId, pattern, handler);
  }

  async publish<T>(event: DomainEvent<T>): Promise<void> {
    const enriched = { ...event, at: event.at ?? new Date() };
    // Sequential so test assertions are deterministic. Each handler is isolated: a
    // throwing subscriber must not stop its siblings, and must not fail the caller —
    // by the time an event is published the write it describes has already committed,
    // so turning a subscriber bug into a 500 would report a false failure.
    for (const sub of this.subscriptions.matching(event.name)) {
      try {
        await sub.handler(enriched);
      } catch (err) {
        this.logger?.error("event subscriber failed", {
          event: event.name,
          subscriber: sub.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * A capability-checked, plugin-bound view of the bus. This is what a plugin gets as
 * `ctx.events` and as the argument to `subscribe`.
 */
export class ScopedEventBus {
  constructor(
    private readonly bus: EventBus,
    private readonly pluginId: string,
    private readonly canPublish: readonly string[],
    private readonly canSubscribe: readonly string[],
    /**
     * Entity types from `capabilities.entities`. Owning an entity grants publish on
     * its namespace (`crm.deal` grants `crm.deal.*`), because `defineEntity` derives
     * `.created`/`.updated`/`.deleted` from the type — making an author restate three
     * strings that can only ever be those three strings is ceremony, not sandboxing,
     * and a typo in one would surface as a failed write rather than a boot error.
     * Ad-hoc events a plugin invents still need an explicit `events.publish` entry,
     * which is where the sandbox actually does work.
     */
    private readonly ownedEntities: readonly string[] = [],
  ) {}

  /**
   * Publish an event this plugin declared, or one under an entity namespace it owns.
   *
   * `async` so a capability violation *rejects* rather than throwing synchronously out
   * of a promise-returning method — otherwise `publish(...).catch(...)` would miss it.
   */
  async publish<T>(event: DomainEvent<T>, tx?: Sql): Promise<void> {
    const allowed =
      this.canPublish.some((p) => matches(p, event.name)) ||
      this.ownedEntities.some((e) => event.name.startsWith(`${e}.`));
    if (!allowed) {
      throw new Error(
        `Plugin "${this.pluginId}" tried to publish undeclared event "${event.name}". ` +
          `Add it to capabilities.events.publish.`,
      );
    }
    return this.bus.publish(event, tx);
  }

  /** Subscribe to a pattern this plugin declared under capabilities.events.subscribe. */
  subscribe<T>(pattern: string, handler: EventHandler<T>): void {
    if (!this.canSubscribe.includes(pattern)) {
      throw new Error(
        `Plugin "${this.pluginId}" tried to subscribe to undeclared pattern "${pattern}". ` +
          `Add it to capabilities.events.subscribe.`,
      );
    }
    this.bus.subscribe(this.pluginId, pattern, handler);
  }
}
