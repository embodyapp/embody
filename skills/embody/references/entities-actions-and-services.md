# Entities, actions, and services

Read this when changing a plugin's data model, business actions, or external adapters.

## Plugin forms

Use one argument for declarations that do not need a typed extension builder:

```ts
export const plugin = definePlugin({
  id: "tracker",
  version: "1.0.0",
  entities: { /* ... */ },
  services: () => ({ /* ... */ }),
  events: { /* ... */ },
  workflows: { /* ... */ },
});
```

Use two arguments when actions need typed entity access or when using typed update hooks:

```ts
export const plugin = definePlugin(base, (define) => ({
  actions: { run: define.action({ /* ... */ }) },
  hooks: [define.beforeUpdate("item", handler)],
}));
```

## Entities

```ts
const IssueSchema = z.object({
  title: z.string().min(1),
  status: z.enum(["open", "closed"]).default("open"),
  assigneeId: z.string().optional(),
});

entities: {
  issue: {
    description: "A tracked engineering issue",
    schema: IssueSchema,
    indexes: ["status", "assigneeId"],
    defaultSort: { field: "status", direction: "asc" },
  },
}
```

An `EntityRecord<T>` wraps data with `id`, `orgId`, `entityType`, `createdAt`, and `updatedAt`.

Inside handlers, typed accessors use direct arguments:

```ts
const created = await context.entities.issue.create({ title: "Fix parser", status: "open" });
const issue = await context.entities.issue.get(created.id);
const ordered = await context.entities.issue.getMany([created.id]);
const open = await context.entities.issue.list({
  filter: { status: "open" },
  sort: { field: "title", direction: "asc" },
  limit: 25,
  offset: 0,
});
const updated = await context.entities.issue.update(created.id, { status: "closed" });
const batch = await context.entities.issue.updateMany([
  { id: firstId, data: { status: "closed" } },
  { id: secondId, data: { status: "closed" } },
]);
const deleted = await context.entities.issue.delete(created.id);
```

`getMany` rejects if an ID is missing. `updateMany` requires at least one unique ID, preserves input order, runs normal hooks/events, and rolls the whole transaction back on failure.

Generated action and MCP inputs wrap entity data:

```ts
await harness.client.tracker.issue.create({ data: { title: "Fix parser" } });
await harness.client.tracker.issue.get({ id });
await harness.client.tracker.issue.update({ id, data: { status: "closed" } });
await harness.client.tracker.issue.delete({ id });
```

Only index fields used for filtering or sorting. Do not write directly to storage from business handlers.

## Actions

Use custom actions for orchestration or multi-entity business operations:

```ts
approve: define.action({
  description: "Approve an issue after required checks",
  input: z.object({ issueId: z.uuid() }),
  output: z.object({ approved: z.boolean() }),
  handler: async ({ issueId }, context) => {
    const issue = await context.entities.issue.get(issueId);
    await context.entities.issue.update(issue.id, { status: "closed" });
    context.progress({ percent: 100, message: "Approved" });
    return { approved: true };
  },
}),
```

Define an output schema for a stable agent-facing contract. Check `context.signal?.aborted` in long loops. Use `context.can(target)` when business behavior needs a permission query; normal action scope checks still happen before the handler.

Use framework errors from `@embody/core` where appropriate: `BadRequestError`, `UnauthenticatedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `HookVetoError`, `RateLimitedError`, and `InternalError`.

## Services

Services hold replaceable adapters or process-level collaborators:

```ts
interface Mailer {
  send(to: string, body: string, idempotencyKey: string): Promise<void>;
}

export const notifications = definePlugin({
  id: "notifications",
  version: "1.0.0",
  services: () => ({ mailer: new ProductionMailer() }),
  actions: {
    send: {
      input: z.object({ to: z.email(), body: z.string(), requestId: z.string() }),
      handler: async (input, context) => {
        const mailer = context.services.get<Mailer>("notifications.mailer");
        await mailer.send(input.to, input.body, input.requestId);
        return { sent: true };
      },
    },
  },
});
```

Service keys are `<pluginId>.<serviceName>`. In tests, override only services declared by a plugin:

```ts
const harness = await createTestHarness({
  plugins: [notifications] as const,
  services: { "notifications.mailer": fakeMailer },
});
```

Keep external calls retry-safe. Prefer publishing an outbox event and performing the external effect in an idempotent subscriber when the effect follows a state mutation.
