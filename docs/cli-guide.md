# Using the `embody` CLI

The **`embody` CLI binary** (`@embody/cli`) serves a dual purpose:
1. **Agent-First Tool Execution**: Allows AI agents and terminal scripts to discover tools, run database queries, and invoke plugin actions directly as JSON outputs.
2. **Developer & Operational Workflows**: Provides commands to start web servers, run database migrations, seed test data, scaffold plugins, and execute plugin-contributed CLI subcommands.

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
pnpm embody mcp -c ./examples/custom-crm/embody.config.ts
```

---

## ⚡ Developer & Operations Subcommands

### 1. Seed Development Data (`embody seed`)
Creates a dev organization and user in PostgreSQL, then outputs copy-pasteable environment variables:

```bash
pnpm embody seed --name "Acme Corp" --email "admin@acme.com"
```

The ids it prints are also what you sign into a UI with: paste them into the demo's live page, or export them and let the host's dev identity pick them up. See [React Hooks & the HTTP Bridge](./react-hooks.md#5-identity).

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
- [**`examples/b2b-saas/src/plugin.ts`**](file:///Users/nimrodfeldman/playground/embody/examples/b2b-saas/src/plugin.ts): Registers `b2b:quote`.
- [**`examples/ecom-fulfillment/src/plugin.ts`**](file:///Users/nimrodfeldman/playground/embody/examples/ecom-fulfillment/src/plugin.ts): Registers `ecom:track`.

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

## 🏗️ Code Scaffolding

There are two, and which you need depends on whether you already have an app. See
[PLUGINS.md](../PLUGINS.md).

### Start a New App (`npm create embody-app`)

Not a subcommand of this CLI — it is how you get a project in the first place, before
any of the above applies:

```bash
npm create embody-app my-crm
```

That writes a project you own outright: a `package.json` depending on `@embody/*`, an
`embody.config.ts` listing which plugins run, your own plugin under `src/`, and your own
`migrations/`. Nothing is checked into it from the embody repository, so there is no
fork to maintain.

---

### Scaffold a Plugin (`embody new plugin <name>`)

Creates a plugin **inside the app you are standing in** and enables it in your config:

```bash
npx embody new plugin compliance
```

It writes `plugins/compliance/{plugin.ts,index.ts,plugin.test.ts,migrations/}` and then
edits `embody.config.ts` to import and list it. The wiring is the part worth automating:
a plugin missing from `plugins: [...]` does nothing at all, and says nothing about it.

---

## 🩺 Checking Your Wiring (`embody doctor`)

```bash
npx embody doctor
```

Four checks, and the first is the one that matters:

| Check | Why |
| :--- | :--- |
| One shared `@embody/plugin-sdk` | With two copies, a plugin registers hooks against a registry your kernel never boots — it loads cleanly and its rules **silently never run**. Nothing throws. |
| Plugins peer-depend on the SDK | Declaring it as a `dependency` is what causes the duplicate above. |
| Config loads, plugins resolve | A typo in `embody.config.ts` otherwise surfaces at boot. |
| No two plugins claim one schema | Each plugin owns and migrates its Postgres schema; a collision means overwritten tables. |

It resolves through `realpath`, because pnpm symlinks the same package to many paths and
only distinct real directories are distinct module instances.

Exits non-zero on an error, zero on warnings, and lists which checks it actually ran so
a pass is not mistaken for a full audit.

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

# Scaffolding
npm create embody-app <name>                  # A new app you own outright
npx embody new plugin <name>                  # A plugin in this app + wire it in

# Wiring health
npx embody doctor                             # One SDK copy? schemas unique? config loads?
```
