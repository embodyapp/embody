# Middleware, Hooks, and Events Guide

Embody provides three distinct extension mechanisms for intercepting requests, modifying data in transit, and reacting to business changes:

| Surface | Timing | Execution Context | Can Veto / Block? |
| :--- | :--- | :--- | :--- |
| **HTTP Middleware** | Before any HTTP handler | Web Server Request Pipeline | Yes (return HTTP response early) |
| **Domain Hooks** | In-Transaction (Before DB write) | Inside Postgres DB Transaction | Yes (throw error to abort transaction) |
| **Domain Events** | Post-Commit (After DB write) | Asynchronous Background Worker | No (side-effects only) |

> [!IMPORTANT]
> **A veto message is user-facing copy.** The kernel wraps every throw from a hook handler
> in a `HookVetoError` (carrying your original error as `cause`), and the HTTP bridge turns
> that into a **`409` with `kind: "veto"` and your message verbatim** — which a UI shows in
> a toast, and an AI agent reads to decide what to do next. Write the sentence for the
> person who will read it: say what is required and what to do about it, not `"invalid
> state"`. The structured `{hook, plugin}` travels separately in `details`, so you do not
> need to name yourself in the text. See [React Hooks & the HTTP Bridge](./react-hooks.md#3-errors-the-taxonomy).
>
> You never need to `throw new HookVetoError(...)` yourself — a plain `throw new Error("…")`
> is typed for you, including from a plugin you wrote yourself.

---

## 1. HTTP Request Middleware (`registerMiddleware`)

Request middleware runs on every incoming HTTP request — plugin routes and `/api` tool calls alike — before the handler. Use it for logging, rate-limiting, custom header checks, or request transformation.

### Registering Middleware

In your plugin object, implement `registerMiddleware`:

```typescript
registerMiddleware(pipeline, ctx) {
  pipeline.use("inventory", async (c, next) => {
    ctx.logger.info(`[${c.req.method}] ${c.req.url}`);
    
    // Add custom header
    c.res.headers.set("X-Embody-Plugin", "inventory");

    // Pass control to the next handler
    await next();
  });
}
```

> [!NOTE]
> The kernel preserves insertion order across plugins based on topological load order (`dependsOn`).

---

## 2. Synchronous Vetoable Domain Hooks (`registerHooks`)

Domain hooks run **inside the database transaction right before a record is created, updated, or deleted**.

### Why Domain Hooks Matter
Hooks allow one plugin to modify or block an operation in another plugin *without editing that plugin's code*!

- **Synchronous**: Runs in-line before the database operation completes.
- **In-Transaction**: Executes inside `ctx.tx`.
- **Vetoable**: If a hook throws an error, the database transaction automatically rolls back!

### Registering Domain Hooks

```typescript
registerHooks(hooks, ctx) {
  // Intercept right before a deal is created in CRM
  hooks.register("crm.deal.beforeCreate", async (payload, tx) => {
    ctx.logger.info(`Validating deal title: ${payload.title}`);

    // Veto check: Reject deal if amount is negative
    if (payload.amount && payload.amount < 0) {
      throw new Error("Deal amount cannot be negative!");
    }

    // Mutate payload: Set default stage if missing
    if (!payload.stage) {
      payload.stage = "lead";
    }
  });
}
```

---

## 3. Asynchronous Durable Events (`subscribe` & `EventBus`)

Domain events (like `crm.deal.created` or `invoice.paid`) are fired **after** a database transaction has successfully committed.

### Outbox Pattern Durability
Embody uses a transactional outbox pattern. Publishing an event appends a row to
`embody.outbox` **inside the transaction that made the change**, so the event and the
data commit together: a hook that vetoes the write takes the event with it, and a crash
after the commit cannot lose the event. Delivery happens later, in a worker process.

Two consequences worth knowing before you rely on this:

> [!IMPORTANT]
> **Nothing is delivered unless a worker is running.** Publishing writes to the outbox;
> the drain is a separate process. Run `embody-host ./embody.config.ts --mode worker`
> alongside your web tier, or pass `--worker` in development to co-locate it in the
> serve process.

> [!IMPORTANT]
> **Delivery is at-least-once, so subscribers must be idempotent.** A handler that
> succeeds and then loses the process before being marked done will run again. Key your
> side effects on something stable from the payload rather than assuming one call.

Each event is expanded into one delivery row per matching subscriber, so subscribers
retry independently with exponential backoff: a broken one cannot block its siblings,
and after `maxAttempts` it is parked as `dead` with the last error rather than
retrying forever.

### Publishing Domain Events
Inside your plugin tool or handler:

```typescript
await ctx.events.publish({
  name: "inventory.item.created",
  orgId: req.orgId,
  payload: { itemId: item.id, sku: item.sku },
});
```

### Subscribing to Domain Events

```typescript
subscribe(bus, ctx) {
  // Listen for deal.won events from the CRM plugin
  bus.subscribe("crm.deal.won", async (event) => {
    ctx.logger.info(`Deal won! Automatically allocating stock...`, event.payload);
    
    // Perform background side-effects (e.g. reserve inventory, send notification email)
  });
}
```

---

## 🧠 When to Use Which Surface?

- Need to check IP addresses, custom auth tokens, or CORS? ➔ **Use Middleware**
- Need to enforce validation rules, auto-fill fields, or block a DB save? ➔ **Use Domain Hooks**
- Need to send an email, update external webhooks, or sync data to another service? ➔ **Use Domain Events**
