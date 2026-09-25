# Testing Embody applications

Use `@embody/testing` to exercise the production kernel, transaction path, SQLite adapter, outbox worker, and workflow worker. Do not call action or hook handlers directly.

## Setup and cleanup

Pass a literal plugin tuple to preserve typed clients:

```ts
const harness = await createTestHarness({ plugins: [tasksPlugin] as const });
try {
  // assertions
} finally {
  await harness.close();
}
```

A test runner may close the harness in `afterEach`, but avoid closing the same root while another actor view is in use.

## Invocation

Typed client:

```ts
const task = await harness.client.tasks.task.create({ data: { title: "Typed" } });
await harness.client.tasks.completeMany({ taskIds: [task.id] });
```

Dynamic target:

```ts
await harness.call("tasks.task.update", {
  id: task.id,
  data: { status: "done" },
});
```

Harness targets omit the application ID because the harness boots a plugin kernel directly.

## Principals

```ts
const agent = harness.asAgent("coding-agent");
const human = harness.asHuman("alice", { roles: ["admin"], scopes: ["tasks:*"] });
const system = harness.as({
  orgId: "test",
  actorId: "worker",
  actorType: "system",
  roles: [],
  scopes: ["tasks:*"],
});
```

Actor views are immutable and share the root kernel and captured observations. `asAgent` and `asHuman` inherit omitted `orgId`, roles, scopes, and metadata from the current view.

Do not pass `scopes: []` to a guardrail test unless authorization denial is the behavior under test.

## Vetoes and state

```ts
const veto = await agent.veto(() =>
  agent.client.tasks.task.update({ id: task.id, data: { status: "done" } }),
);
expect(veto.message).toContain("linked PR URL");

const unchanged = await harness.client.tasks.task.get({ id: task.id });
expect(unchanged.data.status).toBe("todo");
```

Also test an allowed path. For `updateMany`, assert every record remains unchanged if any update fails.

## Outbox, workflows, progress, and audit

```ts
const events = await harness.events("tasks.task.completed");
await harness.tickOutbox();

await harness.tickWorkflows();
const workflow = await harness.workflow(workflowId);

const progress = harness.progress();
const audit = harness.audit();
```

- `events(name?)` reads persisted outbox records and can filter by canonical event name.
- `tickOutbox()` claims and runs currently eligible events without sleeping.
- `tickWorkflows()` claims and runs currently eligible workflow steps without sleeping.
- `workflow(id)` returns the durable snapshot.
- `progress(requestId?)` returns captured updates.
- `audit()` returns execution audit entries.

Inject `now` and `eventId` for deterministic clock and event tests. Use service overrides for external adapters. Calls accept `{ signal }` as their final options argument for cancellation tests.

## Required cases

For each guardrail or workflow, cover the applicable cases:

1. allowed human or agent path
2. rejected path with the expected error—not merely any rejection
3. persisted state after success and failure
4. tenant separation
5. service override rather than a live network call
6. emitted event and outbox processing
7. batch rollback
8. progress and cancellation
9. workflow retry, delay, cancellation, and compensation
10. audit outcome
