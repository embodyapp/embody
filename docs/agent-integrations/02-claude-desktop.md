# Connecting Claude Desktop

> Learn how to configure Anthropic's Claude Desktop application to talk to your Embody backend via MCP.

---

## 🖥️ Overview

Claude Desktop connects to Model Context Protocol (MCP) servers using stdio or HTTP transports. Embody provides a built-in CLI bridge that allows Claude Desktop to discover, introspect, and execute actions on your local or remote Embody backend.

---

## ⚙️ Configuration File Location

Open your Claude Desktop configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

If the file does not exist, create it.

---

## 📝 Configuration Snippet

Add your Embody server under the `mcpServers` object:

### Local Development (Zero-Auth)

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
        "http://127.0.0.1:8080/mcp"
      ]
    }
  }
}
```

### Production / Remote Host (With Authentication)

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
        "eyJhbGciOi..."
      ]
    }
  }
}
```

---

## 🔄 Restart & Verification

1. **Save** `claude_desktop_config.json`.
2. **Quit and restart** Claude Desktop.
3. Open a new chat in Claude Desktop.
4. Look for the **hammer icon (🔨)** at the bottom-right of the chat input. Click it to inspect the tools registered by Embody:
   - `ops_tasks_task_create`
   - `ops_tasks_task_list`
   - `ops_tasks_task_update`
   - `ops_tasks_bulk_complete`

---

## 💬 Prompts to Try with Claude

Once connected, you can talk to your business application in natural language:

### 1. Create a Task
> *"Please create a high-priority task titled 'Fix flaky Redis reconnection test' in my ops app."*

Claude will call `ops_tasks_task_create`, passing the validated JSON parameters.

### 2. Query and Filter State
> *"List all tasks currently in progress."*

Claude will call `ops_tasks_task_list` with `{ "filter": { "status": "in_progress" } }` and format the output into a readable table.

### 3. Observe Mechanical Safety Vetoes in Real-Time
> *"Mark the task as 'done'."*

If your app has a PR validation hook, Claude will attempt to call `ops_tasks_task_update` with `{ "status": "done" }`. Embody will reject the mutation with:

```text
HookVetoError: Autonomous agents cannot mark a task 'done' without a linked PR URL.
```

Claude will read the error and respond intelligently:
> *"I attempted to mark the task as done, but the system prevented the change because a verified Pull Request URL is required. Please provide the PR URL so I can attach it and complete the task."*

---

## 🩺 Troubleshooting

### Hammer Icon Does Not Appear
1. Ensure your local server is running (`pnpm dev`) on port 8080.
2. Open terminal and verify the endpoint responds:
   ```bash
   curl http://127.0.0.1:8080/health
   ```
3. Check Claude Desktop logs:
   - macOS: `tail -f ~/Library/Logs/Claude/mcp*.log`

Next: **[Connecting Cursor & Cline →](./03-cursor-and-cline.md)**
