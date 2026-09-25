# Mechanical Safety Guardrails & Policy Shield

> Enforce deterministic state invariants for autonomous agents inside the transaction boundary.

---

## Why prompt-only guardrails fail

Instructions such as “never close a task without a PR” are useful guidance but are not an authorization or data-integrity boundary. Prompt injection, context loss, and model error can all produce prohibited calls.

Embody validates requests, checks scopes, and runs entity lifecycle hooks before committing mutations. A `HookVetoError` aborts the transaction and returns an actionable policy failure.

---

## Typed update hooks

The two-argument `definePlugin` builder provides typed update hooks:

```typescript
import { definePlugin, HookVetoError, z } from "@embody/core";

export const tasks = definePlugin(
  {
    id: "tasks",
    version: "1.0.0",
    entities: {
      task: {
        schema: z.object({
          title: z.string().min(1),
          status: z.enum(["todo", "in_progress", "done"]),
          prUrl: z.url().optional(),
        }),
      },
    },
  },
  (define) => ({
    hooks: [
      define.beforeUpdate("task", ({ current, patch }, context) => {
        if (
          context.principal.actorType === "agent" &&
          patch.status === "done" &&
          !current.data.prUrl &&
          !patch.prUrl
        ) {
          throw new HookVetoError("Agents cannot complete tasks without a linked PR URL");
        }
      }),
    ],
  }),
);
```

`beforeUpdate` receives `{ current, patch }`. `afterUpdate` receives `{ current, updated }` and can publish a durable event after detecting a transition. Avoid direct network effects in either hook.

---

## Create and delete lifecycle hooks

The runtime also supports fully qualified raw lifecycle hook keys. They are less strongly typed, so verify payloads against the installed package:

```typescript
export const projects = definePlugin({
  id: "projects",
  version: "1.0.0",
  entities: { project: projectDefinition },
  hooks: {
    "projects.project.beforeCreate": ({ data }, context) => {
      if (!data.ownerId) throw new HookVetoError("Projects require an owner");
    },
    "projects.project.beforeDelete": ({ current }, context) => {
      if (current.data.protected) {
        throw new HookVetoError("Protected projects cannot be deleted");
      }
    },
  },
});
```

Lifecycle payloads are:

| Phase | Payload |
| --- | --- |
| `beforeCreate` | `{ data }` |
| `afterCreate` | `{ record }` |
| `beforeUpdate` | `{ current, patch }` |
| `afterUpdate` | `{ current, updated }` |
| `beforeDelete` | `{ current }` |
| `afterDelete` | `{ deleted }` |

The current typed builder does not expose `define.beforeCreate`, `define.beforeDelete`, or `define.beforeAction`. Do not use helpers absent from the installed declarations.

---

## Custom action policy

Scope authorization runs before custom actions. Enforce action-specific business rules in the handler before mutation, and load approval state from trusted storage:

```typescript
executeTrade: define.action({
  input: z.object({
    amountUsd: z.number().positive(),
    approvalId: z.uuid().optional(),
  }),
  handler: async (input, context) => {
    if (context.principal.actorType === "agent" && input.amountUsd > 1_000) {
      if (!input.approvalId) {
        throw new HookVetoError("Trades over $1,000 require an approval record");
      }
      const approval = await context.entities.approval.get(input.approvalId);
      if (approval.data.status !== "approved") {
        throw new HookVetoError("Approval record is not approved");
      }
    }

    return context.entities.trade.create({ amountUsd: input.amountUsd });
  },
}),
```

Do not trust a caller-supplied `approved: true` flag. Entity hooks still execute for every entity mutation made by the action.

---

## State-machine invariants

Check both current and proposed state:

```typescript
const transitions = {
  todo: ["in_progress"],
  in_progress: ["todo", "done"],
  done: [],
} as const;

define.beforeUpdate("task", ({ current, patch }) => {
  if (!patch.status || patch.status === current.data.status) return;
  const allowed: readonly string[] = transitions[current.data.status];
  if (!allowed.includes(patch.status)) {
    throw new HookVetoError(
      `Invalid transition from ${current.data.status} to ${patch.status}`,
    );
  }
});
```

---

## Validation, authorization, and veto ordering

The execution pipeline validates input and checks principal scopes before running the action transaction. A caller with no matching scope receives `ForbiddenError`; the policy hook does not run. Tests must assert the expected veto rather than treating any rejection as success.

Use:

- Zod for structural validation
- scopes for invocation permission
- lifecycle hooks for persisted entity invariants
- handler checks for custom action business rules
- `HookVetoError` only for clear mechanical policy rejection

---

## Testing requirements

For every guardrail:

1. test a caller with sufficient scope
2. assert the exact veto reason
3. confirm rejected state was not persisted
4. test at least one allowed path
5. test relevant agent, human, and system behavior
6. verify a failed batch rolls back every item
7. verify rejected mutations do not leave outbox events

Use `harness.asAgent()`, `harness.asHuman()`, and `harness.veto()` as shown in the [testing guide](../developer-tools/03-testing-guide.md).

Next: **[Events & Outbox →](./05-events-and-outbox.md)**
