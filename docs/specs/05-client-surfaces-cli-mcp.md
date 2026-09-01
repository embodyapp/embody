# 05. Client Surfaces: CLI & MCP Specification

## 1. Unified Hierarchical CLI Specification

The Embody CLI provides a single binary surface (`embody`) to interact with all remote apps in an organization.

### 1.1 Command Syntax Hierarchy
```text
embody <app-id> <target-type> <subcommand> [flags]
```

### 1.2 CLI Command Examples

```bash
# 1. Auto-CRUD Entity Commands
# Create a card in the remote Kanban app
embody kanban card create --title "Resolve high latency" --priority high

# List cards with JSON filtering
embody kanban card list --status in_progress --limit 10

# Update a card
embody kanban card update 8f6b0f1a-829d-481b-90f7-b8f9e6d7a4d1 --status done

# 2. Custom Action Invocations
# Trigger an action in the Email Automation app
embody email sendBatch --campaignId "leads-q4" --dryRun true

# 3. Dynamic Interactive & JSON Modes
# Pipe JSON directly to an action
echo '{"query": "marketing"}' | embody crm searchContacts --json

# 4. App Discovery & Inspection
embody apps list                 # List all live remote apps registered with Gateway
embody apps inspect kanban       # Show all available entities, actions, and schemas
```

---

## 2. Multi-Modal Model Context Protocol (MCP) Specification

The Central Gateway serves as a high-performance MCP server adhering to the official Model Context Protocol (JSON-RPC 2.0 / Server-Sent Events).

### 2.1 Endpoint Modes
1. **Aggregated Global Endpoint (`GET/POST /mcp`)**:
   Exposes all tools from all active apps across the enterprise. Tool names are prefixed using double underscores (`<app>__<action>`):
   - `kanban__card_create`
   - `kanban__card_list`
   - `email__send_batch`
   - `crm__contact_search`

2. **Scoped Per-App Endpoint (`GET/POST /mcp/:appId`)**:
   Exposes only tools belonging to the specified application without prefixes:
   - `card_create`
   - `card_list`
   - `card_update`

### 2.2 MCP Tool Schema Translation
Every Zod schema defined in an Embody plugin is automatically converted into standard JSON Schema for MCP clients:

```json
{
  "name": "kanban__card_create",
  "description": "Create a new kanban card on the organization board",
  "inputSchema": {
    "type": "object",
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "title": { "type": "string", "description": "Title of the card" },
          "description": { "type": "string", "description": "Optional markdown description" },
          "priority": { "type": "string", "enum": ["low", "medium", "high"], "default": "medium" },
          "status": { "type": "string", "enum": ["todo", "in_progress", "done"], "default": "todo" }
        },
        "required": ["title", "status"]
      }
    },
    "required": ["data"]
  }
}
```

---

## 3. Real-Time Progress Notifications in MCP

When actions report progress via `ctx.progress()`, the Gateway streams standard MCP `notifications/progress` messages back to the LLM agent:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/progress",
  "params": {
    "progressToken": "req-12345",
    "progress": 50,
    "total": 100,
    "message": "Processed 250 of 500 emails..."
  }
}
```
