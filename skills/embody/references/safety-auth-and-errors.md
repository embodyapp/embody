# Safety, authentication, and errors

Read this before adding policy, actor-specific behavior, or authorization.

## Validation, authorization, and policy are different

1. Zod validates input shape before execution.
2. Scope authorization checks whether the principal may invoke the target.
3. Hooks enforce persisted state invariants inside the transaction.
4. Handlers implement custom action business behavior.

A principal with no matching scope receives `ForbiddenError` before hooks or handlers run. Do not mistake that for a successful guardrail test.

## Principals and scopes

Every request has:

```ts
interface Principal {
  orgId: string;
  actorId: string;
  actorType: "agent" | "human" | "system";
  roles: readonly string[];
  scopes: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}
```

Storage operations are tenant-scoped by `orgId`. Use `actorType`, roles, scopes, and metadata only for policies with clearly defined semantics. Use least-privilege gateway credentials and app-scoped MCP endpoints.

## Typed hooks

The two-argument `definePlugin` builder currently provides typed `beforeUpdate` and `afterUpdate` helpers:

```ts
define.beforeUpdate("invoice", ({ current, patch }, context) => {
  if (
    context.principal.actorType === "agent" &&
    patch.status === "paid" &&
    !current.data.approvalId &&
    !patch.approvalId
  ) {
    throw new HookVetoError("Agent payment requires an approval record");
  }
});
```

`afterUpdate` receives `{ current, updated }` and is suitable for publishing a durable event after detecting a transition. It still runs in the mutation transaction; avoid direct network side effects.

## Other entity lifecycle hooks

The runtime supports raw lifecycle hook keys for create/delete and after phases. These are less strongly typed, so verify payloads against the installed version:

```ts
export const plugin = definePlugin({
  id: "projects",
  version: "1.0.0",
  entities: { project: projectDefinition },
  hooks: {
    "projects.project.beforeCreate": ({ data }, context) => {
      // Validate creation policy.
    },
    "projects.project.beforeDelete": ({ current }, context) => {
      if (current.data.protected) throw new HookVetoError("Protected projects cannot be deleted");
    },
  },
});
```

Current lifecycle payloads are:

- `beforeCreate`: `{ data }`
- `afterCreate`: `{ record }`
- `beforeUpdate`: `{ current, patch }`
- `afterUpdate`: `{ current, updated }`
- `beforeDelete`: `{ current }`
- `afterDelete`: `{ deleted }`

Use fully qualified hook keys. Do not use undocumented helpers such as `define.beforeCreate`, `define.beforeDelete`, or `define.beforeAction` unless the installed declarations actually provide them.

For a custom action, use scopes for invocation authorization and enforce action-specific business invariants in the handler before mutation. Entity mutations made by the action still run entity hooks.

## Error choice

- `BadRequestError`: semantically invalid request not captured by schema
- `UnauthenticatedError`: absent or invalid identity
- `ForbiddenError`: identity lacks permission
- `NotFoundError`: requested business resource does not exist
- `ConflictError`: concurrency or current-state conflict
- `HookVetoError`: persisted mutation violates a mechanical policy
- `RateLimitedError`: caller must reduce request rate
- `InternalError`: controlled internal failure

Make veto messages actionable without revealing secrets. Do not convert all failures into `HookVetoError`.

## Guardrail checklist

- Encode field constraints in Zod.
- Reject invalid state transitions based on both current and proposed state.
- Apply stricter limits to agents only when policy requires it.
- Verify approvals from trusted persisted state, not an unverified boolean supplied by the caller.
- Run mutations through entity accessors so hooks execute.
- Test both denial and allowed paths.
- Assert that rejected calls did not modify state or publish events.
- Test the expected failure class/message so an earlier scope failure cannot create a false positive.
