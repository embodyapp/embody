---
name: embody
description: Build, extend, test, and operate agent-native TypeScript applications with Embody. Use when scaffolding an app; defining plugins, Zod entities, typed actions, services, events, durable workflows, or mechanical safety hooks; testing principals and transactions; or connecting through the CLI, MCP, a managed Embody Gateway, or a self-hosted gateway.
license: Elastic-2.0
compatibility: Requires Node.js 22 or 24. Embody applications use TypeScript and ESM; pnpm is recommended.
metadata:
  author: nimrod4278
  repository: https://github.com/embodyapp/embody
---

# Embody

Build deterministic backends and operational applications for autonomous agents. Prefer typed schemas and runtime-enforced policy over prompt-only instructions.

## Start here

1. Inspect `embody.config.ts`, `package.json`, existing plugins and tests, and installed `@embody/*` versions.
2. Preserve the package manager, versions, ESM conventions, and plugin boundaries. Do not upgrade dependencies unless required.
3. Read the matching bundled reference before implementing:

| Task | Reference |
| --- | --- |
| Entities, actions, services, CRUD signatures | [entities-actions-and-services.md](references/entities-actions-and-services.md) |
| Hooks, principals, scopes, errors | [safety-auth-and-errors.md](references/safety-auth-and-errors.md) |
| Events, outbox, durable workflows | [events-and-workflows.md](references/events-and-workflows.md) |
| Harness tests and observations | [testing.md](references/testing.md) |
| CLI, MCP, managed or self-hosted gateway | [gateway-cli-and-mcp.md](references/gateway-cli-and-mcp.md) |

If the installed package differs from these instructions, treat its declarations, package README, tests, and source as authoritative. Never invent framework methods.

## New applications

Prefer the scaffold:

```bash
npx -y create-embody-app@latest my-agent-app
cd my-agent-app
npm install
```

With pnpm, use `pnpm create embody-app my-agent-app` and `pnpm install`.

Model each cohesive business domain as a plugin. Use entities for persisted business objects, custom actions for workflows and multi-record operations, services for external adapters, hooks for state invariants, events for durable downstream work, and durable workflows for retryable multi-step processes.

## Core implementation pattern

Use the two-argument `definePlugin` form for typed actions and typed update hooks:

```typescript
import { definePlugin, HookVetoError, z } from "@embody/core";
import { defineApp } from "@embody/host";

const TaskSchema = z.object({
  title: z.string().min(1),
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  prUrl: z.string().url().optional(),
});

export const tasksPlugin = definePlugin(
  {
    id: "tasks",
    version: "1.0.0",
    entities: {
      task: {
        description: "Work assigned to humans and autonomous agents",
        schema: TaskSchema,
        indexes: ["status"],
      },
    },
  },
  (define) => ({
    actions: {
      completeMany: define.action({
        description: "Complete several tasks atomically",
        input: z.object({ taskIds: z.array(z.uuid()).min(1) }),
        output: z.object({ count: z.number().int().nonnegative() }),
        handler: async ({ taskIds }, context) => {
          const tasks = await context.entities.task.updateMany(
            taskIds.map((id) => ({ id, data: { status: "done" as const } })),
          );
          return { count: tasks.length };
        },
      }),
    },
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
      define.afterUpdate("task", async ({ current, updated }, context) => {
        if (current.data.status !== "done" && updated.data.status === "done") {
          await context.events.publish("tasks.task.completed", { taskId: updated.id });
        }
      }),
    ],
  }),
);

export default defineApp({
  appId: "ops",
  version: "1.0.0",
  plugins: [tasksPlugin],
});
```

Descriptions become guidance for agents, so make them explicit. Add indexes only for fields the application queries. Use `context.entities` instead of direct database writes inside actions.

## Know which API surface you are using

Handler accessors and generated action inputs intentionally differ:

```typescript
// Inside an action or event handler:
await context.entities.task.update(taskId, { status: "done" });

// Through the generated action boundary or typed test client:
await harness.client.tasks.task.update({
  id: taskId,
  data: { status: "done" },
});
```

Names also differ by transport:

```text
Kernel/test target: tasks.task.update
Deployed target:    ops.tasks.task.update
MCP tool:           ops_tasks_task_update
CLI:                embody ops task update <id>
```

## Mechanical safety

- Put structural constraints and defaults in Zod.
- Put persisted state-transition invariants in entity lifecycle hooks.
- Throw `HookVetoError` with a specific, actionable reason for a policy veto.
- Inspect `principal.actorType`, roles, and scopes when policy differs by caller.
- Use normal authorization scopes to restrict which actions a principal may invoke.
- Keep checks and mutations in the Embody execution path so failures roll back transactionally.
- Use `updateMany` for all-or-nothing batches.
- Never substitute prompt instructions, UI validation, or client-side checks for server-side invariants.
- Treat external effects as retryable and idempotent; publish durable events rather than making an untracked dual write.

Do not use undocumented helpers such as `define.beforeAction`. Read [safety-auth-and-errors.md](references/safety-auth-and-errors.md) for the currently supported typed hooks and raw lifecycle hook keys.

## Testing pattern

Test through `@embody/testing`, not by calling handlers directly. Always close the harness:

```typescript
import { createTestHarness } from "@embody/testing";
import { expect, it } from "vitest";
import config from "../embody.config.js";

it("enforces the agent completion rule", async () => {
  const harness = await createTestHarness({ plugins: config.plugins });

  try {
    const task = await harness.client.tasks.task.create({
      data: { title: "Ship the change", status: "todo" },
    });
    const agent = harness.asAgent("coding-agent");

    const veto = await agent.veto(() =>
      agent.client.tasks.task.update({
        id: task.id,
        data: { status: "done" },
      }),
    );
    expect(veto.message).toContain("linked PR URL");

    const completed = await agent.client.tasks.task.update({
      id: task.id,
      data: {
        status: "done",
        prUrl: "https://github.com/example/repository/pull/123",
      },
    });
    expect(completed.data.status).toBe("done");
  } finally {
    await harness.close();
  }
});
```

Do not give the test actor empty scopes unless testing authorization denial: scope checks run before action handlers and hooks. Test rejection, allowed behavior, persisted state, batch rollback, events, progress, cancellation, and actor/tenant boundaries as applicable.

## Run and inspect

Use scripts already declared by the project. A scaffold normally supports:

```bash
npm test
npm run typecheck
npm run build
npm run dev
```

The local host exposes loopback-only development endpoints such as:

- `http://127.0.0.1:8080/health`
- `http://127.0.0.1:8080/__inspector`
- `http://127.0.0.1:8080/__inspector/manifest`

The inspector is not a production authentication boundary and must not be exposed publicly.

## Gateway and MCP

The production gateway is a deployment role, not necessarily a hosted dependency. Choose either:

- **Managed Embody Gateway:** the paid hosted control plane operated by Embody.
- **Self-hosted gateway:** a gateway the operator builds with `@embody/gateway`, using the repository application as a reference.

Application business logic and agent integrations should move between compatible gateways by changing configuration and credentials, not code. Both models provide catalog, execution, registration, CLI, and MCP surfaces. See [gateway-cli-and-mcp.md](references/gateway-cli-and-mcp.md) before configuring either model.

For clients, set `EMBODY_GATEWAY_URL` and `EMBODY_TOKEN`, inspect before mutating, and prefer JSON output:

```bash
npx -y @embody/cli apps list
npx -y @embody/cli apps inspect ops
```

Connect MCP clients to `/mcp` or the least-privilege app-scoped `/mcp/<appId>`. Prefer environment variables or a client secret facility over literal tokens. Never print, commit, or embed bearer tokens.

## Verify before finishing

1. Run the relevant tests, typecheck, and build.
2. Confirm every framework method exists in the installed version.
3. Confirm denied operations fail for the intended reason—not an earlier scope or validation error.
4. Confirm external effects are idempotent under retries.
5. Confirm secrets and development-only endpoints are not exposed.

## Upstream references

Use these when working in the Embody repository or when internet access is available:

- Documentation: https://github.com/embodyapp/embody/tree/main/docs
- Package READMEs: https://github.com/embodyapp/embody/tree/main/packages
- Complete examples: https://github.com/embodyapp/embody/tree/main/examples
