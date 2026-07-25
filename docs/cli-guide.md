# Using the `embody` CLI

The **`embody` CLI binary** (`@embody/cli`) serves a dual purpose:
1. **Agent-First Tool Execution**: Allows AI agents and terminal scripts to discover tools, run database queries, and invoke plugin actions directly as JSON outputs.
2. **Developer & Operational Workflows**: Provides commands to start web servers, run database migrations, seed test data, scaffold new app packages, and execute custom plugin CLI subcommands.

---

## 🛠️ Global Flags & Tenant Identity

All CLI commands run through Embody's central authorization (`ctx.can`) and Row-Level Security (RLS) policies. Pass acting organization and user IDs using global flags or environment variables:

| Global Flag | Environment Variable | Purpose |
| :--- | :--- | :--- |
| `-c, --config <path>` | — | Path to deployment config file (default: `./embody.config.ts`). |
| `-o, --org <uuid>` | `EMBODY_ORG` | Acting organization ID for multi-tenant database isolation. |
| `-u, --user <uuid>` | `EMBODY_USER` | Acting user ID for identity checks. |
| `--roles <csv>` | `EMBODY_ROLES` | Comma-separated user roles (e.g. `owner`, `admin`). |

---

## 🤖 Agent & Tool Invocation Subcommands

### 1. List Available Agent Tools (`embody tools`)
List all agent-callable tools registered by currently enabled plugins:

```bash
pnpm embody tools
```

**Example JSON Output:**
```json
[
  {
    "name": "crm_create_deal",
    "description": "Create a deal in the current org.",
    "params": ["title", "stage", "amount", "partyId", "customFields"]
  },
  {
    "name": "crm_query_deals",
    "description": "List deals in the current org, optionally filtered by stage.",
    "params": ["stage", "limit"]
  }
]
```

---

### 2. Directly Invoke a Tool (`embody call <tool>`)
Execute any registered plugin tool directly from the terminal or a bash script. The tool executes inside a tenant database transaction with Row-Level Security active:

```bash
pnpm embody call crm_create_deal \
  -o "11111111-1111-1111-1111-111111111111" \
  --input '{"title": "Acme Renewal", "amount": 45000}'
```

---

### 3. Run Stdio MCP Server for AI Assistants (`embody mcp`)
Connect AI assistants (Claude Desktop, Cursor, Antigravity) via stdio:

```bash
pnpm embody mcp -c ./examples/service-crm/embody.config.ts
```

---

## ⚡ Developer & Operations Subcommands

### 1. Seed Development Data (`embody seed`)
Creates a dev organization and user in PostgreSQL, then outputs copy-pasteable environment variables:

```bash
pnpm embody seed --name "Acme Corp" --email "admin@acme.com"
```

---

### 2. Apply Database Migrations (`embody migrate`)
Executes all pending Drizzle SQL migrations across plugins in topological order and exits:

```bash
pnpm embody migrate
```

---

### 3. Start the Web Server Host (`embody serve`)
Boots the full kernel and starts the Hono HTTP server:

```bash
pnpm embody serve
```

---

## 🔌 Running Custom Plugin CLI Commands (`embody run <command>`)

Plugins register custom CLI subcommands via **`registerCliCommands`**. 

See the reference app implementations:
- [**`catalog/b2b-saas/src/plugin.ts`**](file:///Users/nimrodfeldman/playground/embody/catalog/b2b-saas/src/plugin.ts): Registers `b2b:quote`.
- [**`catalog/ecom-fulfillment/src/plugin.ts`**](file:///Users/nimrodfeldman/playground/embody/catalog/ecom-fulfillment/src/plugin.ts): Registers `ecom:track`.

### Example 1: B2B Quote Calculation (`b2b:quote`)
Calculate an annual recurring revenue discount for an enterprise contract:

```bash
pnpm embody run b2b:quote --options '{"arr": 120000, "months": 24}'
```

**Output:**
```json
{
  "command": "b2b:quote",
  "baseArr": 120000,
  "contractMonths": 24,
  "discountedArr": 102000,
  "totalContractValue": 204000,
  "discountApplied": "15% Multi-Year Commitment Discount"
}
```

### Example 2: E-Commerce Shipment Tracking (`ecom:track`)
Lookup delivery package status for an order ID:

```bash
pnpm embody run ecom:track 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d
```

**Output:**
```json
{
  "command": "ecom:track",
  "orderId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "status": "In Transit",
  "carrier": "FedEx Express",
  "estimatedDelivery": "Tomorrow by 5:00 PM",
  "trackingNumber": "TRK-892341"
}
```

---

## 🏗️ Code Scaffolding Subcommands

Each generator writes into exactly one bucket, and the bucket decides who owns the
result. See [OWNERSHIP.md](../OWNERSHIP.md).

### Scaffold Your Own Plugin (`embody new custom <name>`)

**This is the one you want.** It creates a plugin package under `custom/` — yours, and
untouched by upgrades:

```bash
embody new custom hipaa-rules --for deploy/acme
```

With `--for`, it also does the wiring that would otherwise be four manual steps: adds
the workspace dependency, and inserts the import and the `plugins` array entry into that
deployment's `embody.config.ts`.

Without `--for` it just creates the package, and tells you it isn't enabled anywhere yet.

---

### Scaffold Your Own Deployment (`embody new deployment <name>`)
Creates a deployable under `deploy/` — the thing you actually run:

```bash
embody new deployment acme --apps crm,b2b-saas
embody new deployment acme --apps crm --custom hipaa-rules   # or wire it up front
```

---

### Scaffold a First-Party App (`embody new app <name>`)
Creates a plugin package in `catalog/` — **upstream-owned**. Anything you add there
conflicts when you merge upstream, so this refuses unless you pass `--internal`:

```bash
embody new app billing --internal    # only when contributing upstream
```

To customize your own instance, use `embody new custom` instead.

---

## 🩺 Upgrade Safety (`embody doctor`)

Reports any file you have changed inside an upstream bucket (`framework/`, `catalog/`,
`examples/`) — committed or not — and exits non-zero. Those are exactly the files a
merge can conflict on:

```bash
git fetch upstream
embody doctor && git merge upstream/main
```

If it cannot find an upstream ref it says so and checks nothing, rather than reporting
a false pass.

---

## ➡️ Summary CLI Cheat Sheet

```bash
# Agent & Tools
embody tools                                # List all agent tools
embody call <tool> --input '{"key":"val"}'   # Call tool directly
embody mcp                                  # Run stdio MCP server

# Custom Plugin Commands
embody run b2b:quote --options '{"arr":120000,"months":24}'
embody run ecom:track <orderId>

# Database & Dev Ops
embody seed --name "Dev Org"                # Create test org & print exports
embody migrate                              # Apply SQL migrations
embody serve                                # Run HTTP server

# Scaffolding (yours)
embody new custom <name> --for deploy/<svc>   # Your plugin + wire it in (the usual path)
embody new deployment <name> --apps crm,b2b-saas
embody new app <name> --internal              # First-party catalog app (upstream only)

# Upgrade safety
embody doctor                                 # Any edits outside custom/ and deploy/?
```
