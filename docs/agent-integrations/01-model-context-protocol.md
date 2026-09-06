# Model Context Protocol (MCP) Integration

> Learn how Embody translates typed TypeScript actions and dynamic entities into standard Model Context Protocol tools.

---

## ⚡ What is MCP?

The **Model Context Protocol (MCP)** is the open standard developed by Anthropic that allows AI applications (such as Claude Desktop, Cursor, and custom agent runtimes) to discover and invoke external tools and context providers securely.

In Embody, **every entity and business action is an MCP tool by default**. You never need to write manual tool adapters, write JSON Schemas by hand, or manage separate API endpoints.

---

## 🗺️ How Targets Map to Tool Names

In Embody, every executable unit has a **canonical dotted target name**:
- Entity CRUD actions: `<appId>.<pluginId>.<entity>.<action>` (e.g., `ops.tasks.task.create`)
- Custom actions: `<appId>.<pluginId>.<action>` (e.g., `ops.tasks.bulkComplete`)

Because MCP clients (and LLM tool calling protocols) require snake_case identifiers, Embody converts dotted targets into stable, unique MCP names:

| Canonical Target | MCP Tool Name |
| :--- | :--- |
| `ops.tasks.task.create` | `ops_tasks_task_create` |
| `ops.tasks.task.list` | `ops_tasks_task_list` |
| `ops.tasks.task.update` | `ops_tasks_task_update` |
| `ops.tasks.bulkComplete` | `ops_tasks_bulk_complete` |

Embody verifies during startup that no name collisions occur. If two targets would produce the same MCP name, the microkernel fails closed with a descriptive configuration error.

---

## 📋 Tool Introspection & Schemas

When an AI agent connects to an Embody endpoint (`/mcp`), it queries the tool list via `tools/list`. Embody automatically responds with the compiled JSON Schemas generated from your Zod definitions:

```json
{
  "name": "ops_tasks_task_create",
  "description": "Create a new task record in ops.tasks",
  "inputSchema": {
    "type": "object",
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "title": { "type": "string", "minLength": 1 },
          "status": { "type": "string", "enum": ["todo", "in_progress", "done"], "default": "todo" },
          "priority": { "type": "string", "enum": ["low", "medium", "high"], "default": "medium" },
          "prUrl": { "type": "string", "format": "uri" }
        },
        "required": ["title"]
      }
    },
    "required": ["data"]
  }
}
```

The LLM receives exact types, descriptions, default values, and required constraints. This reduces tool hallucination rates to near zero.

---

## ⚡ Execution Protocol & Error Handling

When the agent calls a tool via `tools/call`:
1. **Input Validation**: Embody validates the argument payload against your Zod schema. If validation fails, a structured `ValidationError` is returned immediately.
2. **Policy Evaluation**: Pre-commit hooks run. If a safety invariant is violated, a `HookVetoError` is returned with an actionable error message.
3. **Execution**: The handler executes, optionally streaming progress events back to the agent.
4. **Result Envelope**: The result is returned as standard MCP text content:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"id\":\"d9e8c7b6...\",\"status\":\"in_progress\"}"
    }
  ]
}
```

---

## 🔌 Transports Supported

Embody supports two official MCP transport methods:

1. **Streamable HTTP (Recommended for Remote / Web)**:
   Exposed at `http://127.0.0.1:8080/mcp`. Supports bidirectional HTTP POST requests with Server-Sent Events (SSE) streaming.
2. **Stdio Bridge (Recommended for Local Desktop Clients)**:
   Provided by the `@embody/cli` binary:
   ```bash
   embody mcp --url http://127.0.0.1:8080/mcp
   ```
   This converts standard input/output streams used by Claude Desktop into HTTP calls to your Embody server.

Next: **[Connecting Claude Desktop →](./02-claude-desktop.md)**
