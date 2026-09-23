# @embody/core

Framework-agnostic Embody plugin contracts, protocol validators, errors, target naming, and manifest compilation.

```sh
npm install @embody/core
```

Requires Node.js 22 or 24 and uses ESM. Zod is re-exported as `z`, so applications do not need a second schema dependency.

## Typed plugin definitions

The two-argument `definePlugin` form derives action input, contextual entity stores, and lifecycle payloads from entity schemas:

```ts
const plugin = definePlugin(
  {
    id: "notes",
    version: "1.0.0",
    entities: { note: { schema: z.object({ body: z.string(), archived: z.boolean() }) } },
  },
  (define) => ({
    actions: {
      archive: define.action({
        input: z.object({ id: z.uuid() }),
        handler: ({ id }, ctx) => ctx.entities.note.update(id, { archived: true }),
      }),
    },
    hooks: [
      define.beforeUpdate("note", ({ current, patch }) => {
        // current.data and patch are inferred from the note schema.
      }),
    ],
  }),
);
```

The one-argument form remains available for simple plugins and compatibility.

## Transactional bulk entities

Contextual stores provide ordered bulk operations without exposing adapter transactions:

```ts
const cards = await ctx.entities.card.getMany(cardIds);
const moved = await ctx.entities.card.updateMany(
  cards.map(({ id }) => ({ id, data: { status: "in_review" } })),
);
```

`getMany([])` returns an empty list. `updateMany` requires at least one unique ID. Both preserve input order and reject if any ID is missing or belongs to another tenant. Bulk updates validate every merged record before mutation, then run each record's normal update hooks and events. Because contextual stores execute inside the current action transaction, any validation error, conflict, hook veto, or outbox failure rolls back the whole batch.

See the [plugin guide](https://github.com/embodyapp/embody/blob/main/docs/guides/01-defining-plugins.md).

Licensed under the [Elastic License 2.0](./LICENSE).
