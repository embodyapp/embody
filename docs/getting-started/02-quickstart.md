# 5-Minute Quickstart

> Get an agent-native Embody application running locally in under five minutes.

---

## 📋 Prerequisites

Before getting started, make sure your machine meets the minimum runtime requirements:

- **Node.js**: `v22.0.0` or higher (`v24.x` supported)
- **Package Manager**: `pnpm >= 9.0.0` (recommended), `npm >= 10.0.0`, or `yarn`
- **Operating System**: macOS, Linux, or Windows (WSL recommended)

Verify your Node version:

```bash
node -v
# Output: v22.x.x or higher
```

---

## ⚡ Step 1: Scaffold Your Application

Use `create-embody-app` to generate a pre-configured, production-ready Embody project:

```bash
# Using pnpm (recommended)
pnpm create embody-app my-agent-ops

# Or using npm
npm create embody-app@latest my-agent-ops

# Or using npx
npx -y create-embody-app my-agent-ops
```

The scaffolding CLI initializes:
- `embody.config.ts`: The declarative app definition, dynamic schemas, and safety hooks.
- `src/index.ts`: The app entry point and plugin exports.
- `package.json` & `tsconfig.json`: Pre-configured for ES Modules and TypeScript 5.x.
- Local SQLite database directory (`.embody/`).

Navigate into your newly created project and install dependencies:

```bash
cd my-agent-ops
pnpm install
```

---

## 🛠️ Step 2: Understand the Application Config

Open `embody.config.ts`. In Embody, an application is composed of **plugins** that declare **entities**, **actions**, and **safety hooks**:

```typescript
import { definePlugin, HookVetoError, z } from "@embody/core";
import { defineApp } from "@embody/host";

// 1. Declare dynamic entity schema
export const TaskSchema = z.object({
  title: z.string().min(1, "Title cannot be empty"),
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  assignee: z.string().optional(),
  prUrl: z.string().url("Must be a valid URL").optional(),
});

export default defineApp({
  appId: "ops",
  version: "1.0.0",
  plugins: [
    definePlugin(
      {
        id: "tasks",
        version: "1.0.0",
        entities: {
          task: {
            description: "Work items executed by autonomous agents and engineers",
            schema: TaskSchema,
            indexes: ["status", "priority"],
          },
        },
      },
      (define) => ({
        // 2. Declare typed business actions
        actions: {
          bulkComplete: define.action({
            description: "Mark multiple tasks as completed atomically",
            input: z.object({
              taskIds: z.array(z.string().uuid()).min(1),
            }),
            handler: async ({ taskIds }, context) => {
              const updated = await context.entities.task.updateMany(
                taskIds.map((id) => ({ id, data: { status: "done" } }))
              );
              return { completedCount: updated.length };
            },
          }),
        },

        // 3. Mechanical Safety Rule: Prevent AI agents from closing tasks without a PR
        hooks: [
          define.beforeUpdate("task", ({ current, patch }, context) => {
            if (
              context.principal.actorType === "agent" &&
              patch.status === "done" &&
              !current.data.prUrl &&
              !patch.prUrl
            ) {
              throw new HookVetoError(
                "Autonomous agents cannot mark a task 'done' without a linked PR URL."
              );
            }
          }),
        ],
      })
    ),
  ],
});
```

Notice what Embody automatically creates for you from this simple file:
1. **Database tables & indexes** managed automatically in SQLite / PostgreSQL.
2. **MCP Tools** ready for any AI agent:
   - `ops_tasks_task_create`
   - `ops_tasks_task_get`
   - `ops_tasks_task_list`
   - `ops_tasks_task_update`
   - `ops_tasks_task_delete`
   - `ops_tasks_bulkComplete`
3. **Mechanical Guardrail**: No agent can ever bypass your PR requirement, even with custom prompts.

---

## 🚀 Step 3: Start the Development Server

Start the local server with hot reloading enabled:

```bash
pnpm dev
```

You will see output similar to:

```text
Embody Host running on http://127.0.0.1:8080
Dev Inspector: http://127.0.0.1:8080/__inspector
Registered Tools:
  ops.tasks.task.create
  ops.tasks.task.get
  ops.tasks.task.list
  ops.tasks.task.update
  ops.tasks.task.delete
  ops.tasks.bulkComplete
```

Your app is live with three essential endpoints:
- `http://127.0.0.1:8080/mcp`: The live Model Context Protocol (MCP) stream.
- `http://127.0.0.1:8080/health`: JSON health check and uptime monitor.
- `http://127.0.0.1:8080/__inspector`: Interactive web UI for testing tools and schemas.

---

## 🧪 Step 4: Interact with Your App via the CLI

In another terminal window, verify that the Embody CLI can introspect and mutate your application.

### 1. Inspect the Registered Application

```bash
pnpm embody apps list
```

Output:
```json
[
  {
    "appId": "ops",
    "version": "1.0.0"
  }
]
```

### 2. Create a Task

```bash
pnpm embody ops task create --title "Investigate Redis cache eviction" --priority high
```

Output:
```json
{
  "id": "e83296c0-7e3f-4f81-a97e-d1b49f481c03",
  "orgId": "local-org",
  "entityType": "task",
  "data": {
    "title": "Investigate Redis cache eviction",
    "priority": "high",
    "status": "todo"
  },
  "createdAt": "2026-09-06T18:00:00.000Z",
  "updatedAt": "2026-09-06T18:00:00.000Z"
}
```

### 3. List Tasks with Filters

```bash
pnpm embody ops task list --status todo
```

---

## 🛡️ Step 5: Test the Mechanical Safety Guardrail

Let's test what happens when an AI agent attempts to mark the task as `done` without providing a PR URL.

Using the test suite or by simulating an agent actor:

```bash
pnpm embody ops task update e83296c0-7e3f-4f81-a97e-d1b49f481c03 --status done
```

If invoked by a human operator, the update succeeds. But when invoked by an agent (e.g., via Claude Desktop, Cursor, or an authenticated agent token), Embody blocks the transaction with an explicit error:

```text
HookVetoError: Autonomous agents cannot mark a task 'done' without a linked PR URL.
  Code: HOOK_VETO
  Entity: task
  Target: ops.tasks.task.update
```

The database transaction is aborted instantly. No invalid state was written to disk!

---

## 🎯 Next Steps

Now that you have your first Embody application running:

- Learn the core building blocks: **[Core Concepts →](./03-core-concepts.md)**
- Connect Claude Desktop or Cursor: **[Claude Desktop Integration →](../agent-integrations/02-claude-desktop.md)**
- Deep dive into safety rules: **[Mechanical Safety Guardrails →](../guides/04-mechanical-safety-guardrails.md)**
