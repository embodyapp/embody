# CLI Reference Manual

> Complete reference manual for the `@embody/cli` command-line interface.

---

## 💻 Introduction

The `@embody/cli` provides a unified terminal interface for developers and autonomous agents. The CLI features:
- Dynamic discovery of registered apps, entities, and actions.
- Automatic argument coercion matching Zod schemas.
- Stdin JSON piping for complex nested objects.
- Deterministic exit codes suitable for automated scripting.
- Live development server with hot reload (`embody dev`).

---

## 🚀 Commands Overview

```text
Usage:
  embody dev [configPath]
  embody apps list
  embody apps inspect <appId>
  embody <appId> <entity> create [--flags] [--json]
  embody <appId> <entity> get <id> [--output json|table]
  embody <appId> <entity> list [--flags] [--output json|table]
  embody <appId> <entity> update <id> [--flags] [--json]
  embody <appId> <entity> delete <id>
  embody <appId> <action> [--flags] [--json]
  embody mcp --url <endpoint> [--token <token>]
```

---

## 🛠️ Core Commands

### 1. `embody dev`
Starts the local development server with automatic file watching and hot reloading.

```bash
# Start with default embody.config.ts
embody dev

# Start with a specific config file
embody dev ./configs/custom.config.ts
```

### 2. `embody apps list`
Lists all applications registered on the connected Gateway or host.

```bash
embody apps list
```

### 3. `embody apps inspect <appId>`
Returns the full compiled JSON schema manifest of an application, including all entities, actions, and indexes.

```bash
embody apps inspect ops
```

---

## 📦 Dynamic Entity Commands

Entity commands map directly to the auto-generated CRUD actions.

### 1. `create`
Creates a new record. Properties can be passed as CLI flags or via `--json`:

```bash
# Using CLI flags (auto-coerced to types)
embody ops task create --title "Investigate memory leak" --priority high

# Passing JSON via stdin
echo '{"title": "Investigate memory leak", "priority": "high"}' | embody ops task create --json
```

### 2. `get`
Fetches a single entity by its unique identifier:

```bash
embody ops task get 12345678-1234-1234-1234-123456789abc
```

### 3. `list`
Queries records matching specific filters:

```bash
# Filter by status
embody ops task list --status in_progress

# Output as JSON rather than table
embody ops task list --status todo --output json
```

### 4. `update`
Updates an existing record by ID:

```bash
embody ops task update 12345678-1234-1234-1234-123456789abc --status done --prUrl "https://github.com/org/repo/pull/42"
```

### 5. `delete`
Deletes an entity record by ID:

```bash
embody ops task delete 12345678-1234-1234-1234-123456789abc
```

---

## ⚡ Custom Action Commands

Custom actions defined in your plugins can be called directly by specifying `<appId> <actionName>`:

```bash
# Call action with flags
embody ops bulkComplete --taskIds "id1,id2,id3"

# Call action with complex JSON payload
embody ops bulkComplete --json '{"taskIds": ["id1", "id2"]}'
```

---

## 🌐 Global Flags & Options

| Flag | Env Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--base-url <url>` | `EMBODY_GATEWAY_URL` | `http://localhost:3000` | Target Gateway or Host URL. |
| `--token <jwt>` | `EMBODY_TOKEN` | *None* | Bearer authentication token. |
| `--profile <name>` | `EMBODY_PROFILE` | `"default"` | Configuration profile to load from `~/.config/embody/config.json`. |
| `--output <format>` | *None* | `"table"` | Output format: `"table"` or `"json"`. |
| `--json` | *None* | `false` | Instructs the CLI to read input arguments as raw JSON from stdin or argument. |

---

## 🚦 Exit Codes

The Embody CLI uses standardized exit codes so scripts and agents can reliably handle errors:

| Code | Constant | Meaning |
| :---: | :--- | :--- |
| `0` | `SUCCESS` | Command executed successfully. |
| `1` | `EXIT.internal` | Internal server or unhandled runtime error. |
| `2` | `EXIT.usage` | Invalid CLI arguments, missing flags, or schema validation error. |
| `3` | `EXIT.auth` | Authentication failed (missing or invalid token). |
| `4` | `EXIT.forbidden` | Authorization failed (insufficient role or scope). |
| `5` | `EXIT.notFound` | Requested entity ID or app not found. |
| `6` | `EXIT.remote` | Error returned by downstream host. |
| `7` | `EXIT.unavailable` | Gateway or host is unreachable or restarting. |

Next: **[Web Inspector →](./02-dev-inspector.md)**
