---
name: embody
description: Build, extend, test, and operate agent-native TypeScript applications with the Embody framework. Use when scaffolding an Embody app; defining plugins, Zod entities, typed actions, services, events, durable workflows, or mechanical safety hooks; testing human and agent principals; or exposing an app through the Embody CLI, gateway, and MCP.
license: Elastic-2.0
compatibility: Requires Node.js 22 or 24. Embody applications use TypeScript and ESM; pnpm is recommended.
metadata:
  author: nimrod4278
  repository: https://github.com/embodyapp/embody
---

# Embody

Build deterministic backends and operational applications for autonomous agents. Prefer typed schemas and runtime-enforced policy over prompt-only instructions.

## Workflow

1. Inspect the repository before changing it. Look for `embody.config.ts`, `package.json`, existing plugins, tests, and the installed `@embody/*` versions.
2. If starting a new project, scaffold it instead of recreating the setup manually:

   ```bash
   npx -y create-embody-app@latest my-agent-app
   cd my-agent-app
   npm install
   ```

   With pnpm, use `pnpm create embody-app my-agent-app` and `pnpm install`.

3. Model each cohesive business domain as a plugin.
4. Define persisted business objects as Zod-backed entities.
5. Use custom actions for workflows and multi-record operations.
6. Enforce invariants in hooks, especially for callers whose `principal.actorType` is `"agent"`.
7. Publish events through `context.events` when state changes must trigger durable downstream work.
8. Test successful behavior and denied behavior with `@embody/testing`.
9. Run the project's test, typecheck, and build scripts before finishing.

When working in an existing application, preserve its package manager, package versions, module conventions, and plugin boundaries. Do not upgrade dependencies unless the task requires it.

## Core implementation pattern

Use the two-argument `definePlugin` form when entities need typed actions or hooks:

```typescript
import { definePlugin, HookVetoError, z } from "@embody/core";
import { defineApp } from "@embody/host";

const TaskSchema = z.object({
  title: z.string().min(1),
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  prUrl: z.string().url().optional(),
});

const tasksPlugin = definePlugin(
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
        handler: async ({ taskIds }, context) => {
          const tasks = await context.entities.task.updateMany(
            taskIds.map((id) => ({ id, data: { status: "done" as const } })),
          );
          return { count: tasks.length, tasks };
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

Keep entity and action descriptions explicit because they become tool guidance for agents. Add indexes only for fields that the application queries. Use `context.entities` rather than bypassing the framework with direct database access inside actions.

## Mechanical safety rules

Treat policy as executable code:

- Put schema constraints in Zod.
- Put state-transition, authorization, approval, and spend rules in `beforeCreate`, `beforeUpdate`, `beforeDelete`, or `beforeAction` hooks.
- Throw `HookVetoError` with a specific, actionable reason.
- Inspect `context.principal.actorType`, roles, and scopes when policy differs for agents, humans, and system workers.
- Keep checks and mutations in the Embody execution path so failures roll back transactionally.
- Never substitute a prompt instruction, UI validation, or client-side check for a server-side invariant.
- Use `updateMany` for an all-or-nothing batch rather than a loop of separately committed updates.
- Treat external side effects as retryable and idempotent. Publish durable events through the transactional outbox rather than making an untracked dual write.

## Testing pattern

Test through the harness instead of calling handlers directly. Always close it:

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
    const agent = harness.asActor({
      actorType: "agent",
      actorId: "coding-agent",
      roles: [],
      scopes: [],
    });

    await expect(
      agent.call("tasks.task.update", {
        id: task.id,
        data: { status: "done" },
      }),
    ).rejects.toThrow("linked PR URL");
  } finally {
    await harness.close();
  }
});
```

For every guardrail, test at least one rejection and one allowed path. Also test relevant actor types, rollback behavior for batch operations, emitted outbox events, and progress updates where applicable.

## Running and inspecting

Use scripts already declared by the project. A scaffolded application normally supports:

```bash
npm test
npm run typecheck
npm run build
npm run dev
```

The local development host exposes loopback-only endpoints such as:

- `http://127.0.0.1:8080/health`
- `http://127.0.0.1:8080/__inspector`
- `http://127.0.0.1:8080/__inspector/manifest`

Do not represent the local inspector as a production authorization boundary. Production CLI discovery and MCP access are provided through a registered Embody gateway.

For a deployed gateway, set `EMBODY_GATEWAY_URL` and `EMBODY_TOKEN`, then inspect before mutating:

```bash
npx -y @embody/cli apps list
npx -y @embody/cli apps inspect ops
```

Prefer JSON input/output for automation. Never print, commit, or embed bearer tokens.

## MCP integration

Connect agents to the gateway's MCP endpoint, not the local inspector. A stdio bridge can be configured with:

```json
{
  "mcpServers": {
    "embody": {
      "command": "npx",
      "args": [
        "-y",
        "@embody/cli",
        "mcp",
        "--url",
        "https://gateway.example.com/mcp",
        "--token",
        "YOUR_TOKEN"
      ]
    }
  }
}
```

Prefer an environment variable or the client's secret facility over a literal token when supported. Use an app-scoped endpoint such as `/mcp/<appId>` when an agent should not discover every registered application.

## References

Consult the version-matched source and docs when an API is uncertain. Do not invent framework methods.

- Documentation hub: https://github.com/embodyapp/embody/tree/main/docs
- Quickstart: https://github.com/embodyapp/embody/blob/main/docs/getting-started/02-quickstart.md
- Plugin guide: https://github.com/embodyapp/embody/blob/main/docs/guides/01-defining-plugins.md
- Safety hooks: https://github.com/embodyapp/embody/blob/main/docs/guides/04-mechanical-safety-guardrails.md
- Testing guide: https://github.com/embodyapp/embody/blob/main/docs/developer-tools/03-testing-guide.md
- CLI reference: https://github.com/embodyapp/embody/blob/main/docs/developer-tools/01-cli-reference.md
- MCP integration: https://github.com/embodyapp/embody/blob/main/docs/agent-integrations/01-model-context-protocol.md
- Complete examples: https://github.com/embodyapp/embody/tree/main/examples
