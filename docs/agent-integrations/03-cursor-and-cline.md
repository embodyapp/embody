# Connecting Cursor & Cline

> Learn how to integrate Embody MCP tools directly into your AI code editors like Cursor and the Cline VS Code extension.

---

## 💻 Cursor IDE Setup

Cursor has native support for the Model Context Protocol. You can connect Cursor directly to your local development server or a remote Embody Gateway.

### Configuration via `.cursor/mcp.json`

Create a file named `.cursor/mcp.json` in the root of your workspace (or open **Cursor Settings ➔ Features ➔ MCP Servers**):

```json
{
  "mcpServers": {
    "embody": {
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

If you are connecting to a remote Embody Gateway requiring authentication:

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
        "https://gateway.internal/mcp",
        "--token",
        "YOUR_JWT_TOKEN"
      ]
    }
  }
}
```

### Verifying Connection in Cursor
1. Open Cursor's **Composer** (`Cmd+I` or `Ctrl+I`) or the Chat panel (`Cmd+L` or `Ctrl+L`).
2. Type `@embody` or check the MCP server indicator in settings. It should show a green status dot with the total count of loaded tools.

---

## 🤖 Cline (VS Code Extension) Setup

Cline is an autonomous coding agent running inside VS Code that executes terminal commands, reads files, and calls MCP tools.

### Configuration via `cline_mcp_settings.json`

Click the **MCP Server** icon in the Cline panel (top-right toolbar) and select **Configure MCP Servers**:

```json
{
  "mcpServers": {
    "embody-ops": {
      "command": "npx",
      "args": [
        "-y",
        "@embody/cli",
        "mcp",
        "--url",
        "http://127.0.0.1:8080/mcp"
      ],
      "disabled": false,
      "autoApprove": [
        "ops_tasks_task_list",
        "ops_tasks_task_get"
      ]
    }
  }
}
```

> [!TIP]
> Notice the `autoApprove` list: You can safely auto-approve read-only query tools (`task_list`, `task_get`) while requiring human approval for mutations (`task_create`, `task_update`).

---

## 🎯 IDE Agent Workflows

With Embody connected to your editor, your AI agent can coordinate real development work directly with your operational backlog:

### Workflow 1: "Work on Next High-Priority Ticket"
```text
Prompt: "Query my Embody ops board for the next high-priority ticket in 'todo' status, assign it to me, switch the status to 'in_progress', and implement the requested feature in src/auth.ts."
```

Cline or Cursor will:
1. Call `ops_tasks_task_list` with `status: "todo"`, `priority: "high"`.
2. Select the first ticket.
3. Call `ops_tasks_task_update` with `status: "in_progress"`.
4. Inspect your local codebase, write the code, and run tests.

### Workflow 2: "Close the Ticket with PR Link"
```text
Prompt: "Commit my changes, push the branch, open a pull request with gh pr create, and mark the ticket as done in Embody with the new PR URL."
```

When Cursor calls `ops_tasks_task_update`, the safety hook verifies that the PR URL is provided. The update commits cleanly!

Next: **[Custom Agent SDKs & LangChain →](./04-custom-agents-sdk.md)**
