# Embody

> **The Connected Application Framework & Operational Hub for Autonomous AI Agents**

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D11.0.0-orange.svg)](https://pnpm.io/)
[![skills.sh](https://skills.sh/b/nimrod4278/embody)](https://skills.sh/nimrod4278/embody)

---

## 💡 What is Embody?

Visual vibe-coding tools create web pages and UI prototypes for humans to click. **Embody builds the connected backends, operational apps, and mechanical safety guardrails that autonomous AI agents need to run business software safely.**

When businesses build one-off tools or give autonomous agents direct access to raw SQL databases and unattenuated API keys, agents hallucinate mutations, break scrapers, and lack safety boundaries. 

Embody replaces fragile prompt chains with **deterministic, typed applications**:
- 🧠 **One Shared Company Brain**: All your agents work against a single connected PostgreSQL / SQLite database with zero schema drift.
- ⚡ **Instant Day 1 Agent Tools**: Every application declared in Embody automatically compiles introspectable **Model Context Protocol (MCP)** tools and a hierarchical **CLI**.
- 🛡️ **Mechanical Policy & Safety Guardrails**: AI agents are never given blind execution keys. Every tool dispatch is mechanically checked by spend gates, required supervisor approvals, and deterministic state machine invariants.
- 🔄 **Durable Outbox & SSE Streaming**: Zero-infrastructure transactional event delivery and live progress streaming.

```
                  ┌──────────────────────────────────────────────────┐
                  │              Autonomous AI Workforce             │
                  │  (Claude Desktop, Cursor, Cline, LangChain, SDK) │
                  └─────────────────────────┬────────────────────────┘
                                            │ MCP / CLI
                                            ▼
                  ┌──────────────────────────────────────────────────┐
                  │                 Embody Gateway                   │
                  │  • Global & Scoped MCP Endpoints (/mcp, /mcp/:app)│
                  │  • Reverse Proxy & Unified Authentication        │
                  └─────────────────────────┬────────────────────────┘
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     ▼                                             ▼
       ┌───────────────────────────┐                 ┌───────────────────────────┐
       │     Kanban Board App      │                 │   Email Automation App    │
       │  • Task & Backlog Engine  │                 │  • Draft Review & Queue   │
       │  • 🛡️ PR URL Done Veto    │                 │  • 🛡️ Send Approval Gate   │
       └─────────────┬─────────────┘                 └─────────────┬─────────────┘
                     │                                             │
                     └──────────────────────┬──────────────────────┘
                                            ▼
                  ┌──────────────────────────────────────────────────┐
                  │             Live Shared Operations DB            │
                  │    PostgreSQL (JSONB + RLS) or Embedded SQLite   │
                  └──────────────────────────────────────────────────┘
```

---

## 📦 Monorepo Architecture

Embody is structured as a modular TypeScript monorepo with clean architectural boundaries:

| Package | Description |
| :--- | :--- |
| [`@embody/core`](./packages/core) | Microkernel runtime, 7-phase lifecycle, Zod dynamic entities, capability sandbox, and vetoable hooks. |
| [`@embody/host`](./packages/host) | App host runtime, HTTP server, SSE progress streaming, and outbox event worker. |
| [`@embody/gateway`](./packages/gateway) | Central control plane, aggregated `/mcp` tools, app-scoped `/mcp/:app`, and reverse proxy routing. |
| [`@embody/mcp`](./packages/mcp) | Standard Model Context Protocol (MCP) server adapter for direct agent integration. |
| [`@embody/cli`](./packages/cli) | Unified hierarchical CLI (`embody <app> <action>`) and local developer server with web inspector. |
| [`@embody/storage`](./packages/storage) | Transactional PostgreSQL and SQLite storage adapters with JSONB query acceleration and row-level security. |
| [`@embody/auth`](./packages/auth) | Pluggable authentication providers, API keys, Bearer token verifiers, and principal context scoping. |
| [`@embody/testing`](./packages/testing) | End-to-end testing harness with typed actor simulation (`agent`, `human`, `system`) and observation helpers. |
| [`create-embody-app`](./packages/create-embody-app) | Instant zero-config application scaffolding CLI. |

---

## 🤖 Install the Agent Skill

Give a compatible coding agent the Embody development workflow, API patterns, safety guidance, and testing conventions:

```bash
npx skills add nimrod4278/embody --skill embody
```

The skill is defined in [`skills/embody/SKILL.md`](./skills/embody/SKILL.md) and is discoverable on [skills.sh](https://skills.sh/nimrod4278/embody/embody). Review the skill before installing it, as you should with any agent instructions.

---

## 🚀 Quickstart

### Prerequisites

- **Node.js**: `>= 22.0.0`
- **pnpm**: `>= 9.0.0` (or npm / yarn)

### 1. Scaffold a New App

Generate a ready-to-run Embody application in seconds:

```bash
# Using npm
npm create embody-app@latest my-agent-app

# Using pnpm
pnpm create embody-app my-agent-app
```

Navigate into your project:

```bash
cd my-agent-app
pnpm install
```

### 2. Define Your Agent Application

Applications in Embody are defined declaratively in `embody.config.ts`. You declare **entities**, **custom actions**, and **mechanical safety hooks**:

```typescript
import { definePlugin, HookVetoError, z } from "@embody/core";
import { defineApp } from "@embody/host";

// 1. Declare dynamic entity schema with Zod
export const TaskSchema = z.object({
  title: z.string().min(1),
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  prUrl: z.string().url().optional(),
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
            description: "Work items and tickets executed by autonomous agents",
            schema: TaskSchema,
            indexes: ["status", "priority"],
          },
        },
      },
      (define) => ({
        // 2. Declare typed business actions
        actions: {
          bulkComplete: define.action({
            description: "Atomically mark multiple tasks as completed",
            input: z.object({ taskIds: z.array(z.string().uuid()) }),
            handler: async ({ taskIds }, context) => {
              const updated = await context.entities.task.updateMany(
                taskIds.map((id) => ({ id, data: { status: "done" } }))
              );
              return { completedCount: updated.length };
            },
          }),
        },

        // 3. Mechanical Safety Guardrail: Prevent AI agents from closing tasks without a PR
        hooks: [
          define.beforeUpdate("task", ({ current, patch }, context) => {
            if (
              context.principal.actorType === "agent" &&
              patch.status === "done" &&
              !current.data.prUrl &&
              !patch.prUrl
            ) {
              throw new HookVetoError("Agents cannot mark a task 'done' without a verified PR URL");
            }
          }),
        ],
      })
    ),
  ],
});
```

### 3. Start the Development Server

```bash
pnpm dev
```

Your app will start on `http://127.0.0.1:8080` with:
- `http://127.0.0.1:8080/health`: Healthcheck endpoint.
- `http://127.0.0.1:8080/__inspector`: Loopback-only development inspector.
- SQLite transactional storage.

CLI discovery and MCP endpoints are exposed after the app registers with an Embody Gateway.

---

## 🤖 Connecting AI Agents via MCP

Embody apps are **agent-native out of the box**. AI agents can introspect schemas, query records, and trigger actions with zero glue code.

### Claude Desktop Configuration

Add Embody to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "embody": {
      "command": "npx",
      "args": ["-y", "@embody/cli", "mcp", "--url", "http://127.0.0.1:3000/mcp", "--token", "YOUR_TOKEN"]
    }
  }
}
```

### Cursor / Cline Configuration

In your `.cursor/mcp.json` or Cline settings:

```json
{
  "mcpServers": {
    "embody": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

When connected, the AI agent immediately receives typed tools such as:
- `ops.task.create`: Create a new task with full schema validation.
- `ops.task.list`: Filter and query tasks by status, priority, or custom attributes.
- `ops.task.update`: Update task attributes (gated by safety hooks).
- `ops.tasks.bulkComplete`: Execute your custom business action.

---

## 💻 Developer & Agent CLI

Embody includes a unified CLI that works seamlessly for human developers in the terminal and autonomous agents running shell commands:

```bash
# List all registered applications and capabilities
embody apps list

# Inspect an application's entities and actions
embody apps inspect ops

# Create an entity record
embody ops task create --title "Investigate memory leak" --priority high

# List tasks with filters
embody ops task list --status todo

# Update a task by ID
embody ops task update <TASK_ID> --status in_progress

# Pass JSON payloads directly or via stdin
echo '{"taskIds": ["c7a4e6...", "f1b2d3..."]}' | embody ops tasks bulkComplete --json
```

---

## 🛡️ Mechanical Safety & Policy Shield

Traditional API keys allow an AI agent to do anything the key owner can do. Embody uses **principal-aware capability attenuation**:

1. **Actor Scoping**: Every request identifies whether the actor is a `human`, `agent`, or `system`.
2. **Vetoable Hooks**: `beforeCreate`, `beforeUpdate`, and `beforeDelete` hooks can inspect state changes and veto mutations with descriptive error messages before any database transaction commits.
3. **Spend Limits & Approval Gates**: Actions can enforce budgets and require supervisor approval before execution.
4. **Deterministic Auditing**: All actions and state changes produce a verifiable audit trail with actor metadata.

```typescript
// Example: Spend Policy Hook
define.beforeAction("payout", async (input, context) => {
  if (context.principal.actorType === "agent" && input.amount > 500) {
    throw new HookVetoError("Transactions over $500 require human supervisor approval");
  }
});
```

---

## 🧪 Testing with `@embody/testing`

Embody includes a comprehensive test harness designed for agent-native applications:

```typescript
import { expect, it } from "vitest";
import { createTestHarness } from "@embody/testing";
import config from "./embody.config.js";

it("prevents agents from completing tasks without a PR URL", async () => {
  const harness = await createTestHarness({ plugins: config.plugins });

  try {
    // 1. Human creates a task
    const task = await harness.call("ops.task.create", {
      data: { title: "Refactor auth", status: "todo" },
    });

    // 2. Switch context to autonomous agent actor
    const agentHarness = harness.asActor({ actorType: "agent", actorId: "agent-007" });

    // 3. Attempting to mark done without prUrl is vetoed
    await expect(
      agentHarness.call("ops.task.update", {
        id: task.id,
        data: { status: "done" },
      })
    ).rejects.toThrow("Agents cannot mark a task 'done' without a verified PR URL");

    // 4. Marking done with prUrl succeeds
    const completed = await agentHarness.call("ops.task.update", {
      id: task.id,
      data: { status: "done", prUrl: "https://github.com/org/repo/pull/42" },
    });

    expect(completed.status).toBe("done");
  } finally {
    await harness.close();
  }
});
```

---

## 📂 Reference Applications

Explore complete, production-ready reference implementations in [`examples/`](./examples/):

- **[`examples/kanban`](./examples/kanban)**: Kanban task management system with multi-agent coordination, swimlanes, and PR completion validation hooks.
- **[`examples/email`](./examples/email)**: Autonomous email workflow automation with transactional outbox queuing and supervisor approval checkpoints.

---

## 🛠️ Monorepo Development

### Building the Entire Workspace

```bash
pnpm install
pnpm build
```

### Running Test Suites

```bash
# Run unit and integration tests across all packages
pnpm test

# Run PostgreSQL-backed tests
pnpm test:postgres

# Run End-to-End test suite
pnpm test:e2e
```

### Formatting & Linting

```bash
pnpm format
pnpm lint
pnpm verify
```

---

## 📚 Comprehensive Documentation

For complete, multi-page user documentation with guides, tutorials, and agent setup instructions, visit the **[Embody Documentation Hub](./docs/README.md)**:

- 🚀 **[Getting Started](./docs/getting-started/01-introduction.md)**: [5-Minute Quickstart](./docs/getting-started/02-quickstart.md) • [Core Concepts](./docs/getting-started/03-core-concepts.md) • [Project Layout](./docs/getting-started/04-project-structure.md)
- 📖 **[Developer Guides](./docs/guides/01-defining-plugins.md)**: [Plugins & Microkernel](./docs/guides/01-defining-plugins.md) • [Entities & Storage](./docs/guides/02-entities-and-storage.md) • [Actions & Progress](./docs/guides/03-actions-and-handlers.md) • [Mechanical Safety Guardrails](./docs/guides/04-mechanical-safety-guardrails.md) • [Outbox & Events](./docs/guides/05-events-and-outbox.md) • [Auth & Identity](./docs/guides/06-authentication-and-principals.md) • [Gateway](./docs/guides/07-gateway-and-control-plane.md)
- 🤖 **[Agent Integrations](./docs/agent-integrations/01-model-context-protocol.md)**: [Model Context Protocol (MCP)](./docs/agent-integrations/01-model-context-protocol.md) • [Claude Desktop](./docs/agent-integrations/02-claude-desktop.md) • [Cursor & Cline](./docs/agent-integrations/03-cursor-and-cline.md) • [Python & LangChain](./docs/agent-integrations/04-custom-agents-sdk.md)
- 🛠️ **[Developer Tools](./docs/developer-tools/01-cli-reference.md)**: [CLI Reference Manual](./docs/developer-tools/01-cli-reference.md) • [Web Inspector](./docs/developer-tools/02-dev-inspector.md) • [Testing Guide](./docs/developer-tools/03-testing-guide.md)
- 🎓 **[Step-by-Step Tutorials](./docs/tutorials/01-kanban-board.md)**: [AI Kanban Board](./docs/tutorials/01-kanban-board.md) • [Email Campaign Automation](./docs/tutorials/02-email-automation.md)
- 🚢 **[Production Operations](./docs/production/01-deployment.md)**: [Docker & PostgreSQL Deployment](./docs/production/01-deployment.md) • [Troubleshooting & FAQ](./docs/production/02-troubleshooting-faq.md)

---

## 📖 Detailed Specifications

For in-depth architectural documents, lifecycle diagrams, and technical deep dives, check out the [`docs/specs/`](./docs/specs/) directory:

- [01. System Architecture & Central Gateway](./docs/specs/01-system-architecture.md)
- [02. Plugin Microkernel SPI](./docs/specs/02-plugin-microkernel-spi.md)
- [03. Dynamic Entity Engine](./docs/specs/03-dynamic-entity-engine.md)
- [04. Pluggable Auth & Identity](./docs/specs/04-pluggable-auth-identity.md)
- [05. Client Surfaces: CLI & MCP](./docs/specs/05-client-surfaces-cli-mcp.md)
- [06. Durable Outbox & SSE Streaming](./docs/specs/06-durable-outbox-events-streaming.md)
- [07. Developer Tooling & Testing](./docs/specs/07-developer-tooling-testing.md)
- [08. Reference Applications](./docs/specs/08-reference-apps.md)

---

## 🤝 Community and support

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.
- Use [SUPPORT.md](SUPPORT.md) for help and [SECURITY.md](SECURITY.md) for private vulnerability reporting.
- Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## 📄 License

Embody is source-available under the [Elastic License 2.0](LICENSE). You may build and host your own applications with Embody, but you may not provide Embody itself as a hosted or managed service that exposes a substantial set of its functionality. Commercial hosting rights are available separately. Embody is not OSI-approved open-source software. See the [licensing FAQ](docs/commercial/LICENSING-FAQ.md) for non-binding, plain-language guidance; the license text controls.
