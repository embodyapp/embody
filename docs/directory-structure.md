# Directory Structure Guide

This guide provides a file-by-file and directory-by-directory breakdown of the **Embody** codebase.

The top level is split into five buckets by **ownership**. Three come from upstream and
are replaced wholesale when you upgrade; two are yours and upstream never writes to them.
That split is what makes customization survive upgrades — see
[OWNERSHIP.md](../OWNERSHIP.md).

---

## 📁 Repository Overview

```text
embody/
├── .env.example
├── .gitignore
├── .npmrc
├── ARCHITECTURE.md
├── OWNERSHIP.md            ← who owns what, and how to upgrade
├── docker-compose.yml
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── turbo.json
│
├── framework/              ⚙️  UPSTREAM — the runtime. Do not edit.
│   ├── auth/
│   ├── cli/
│   ├── core/
│   ├── db/
│   ├── host/
│   ├── kernel/
│   ├── mcp-server/
│   └── plugin-sdk/
├── catalog/                📦  UPSTREAM — first-party apps you can enable.
│   ├── crm/
│   ├── b2b-saas/
│   └── ecom-fulfillment/
├── examples/               📖  UPSTREAM — copy these, don't edit them.
│   ├── service-crm/
│   └── demo-ui/
│
├── custom/                 🛠️  YOURS — your plugins.
│   └── acme-crm/
└── deploy/                 🚀  YOURS — your deployables.
    └── acme/
```

---

## ⚙️ Root Configuration Files

- [`package.json`](file:///Users/nimrodfeldman/playground/embody/package.json): Workspace root package file defining Turbo scripts (`build`, `dev`, `test`, `typecheck`) and pnpm package manager versions.
- [`pnpm-workspace.yaml`](file:///Users/nimrodfeldman/playground/embody/pnpm-workspace.yaml): Specifies monorepo package directories (`framework/*`, `catalog/*`, `deploy/*`, `custom/*`).
- [`turbo.json`](file:///Users/nimrodfeldman/playground/embody/turbo.json): Configures **TurboRepo** pipeline caching and task orchestration.
- [`docker-compose.yml`](file:///Users/nimrodfeldman/playground/embody/docker-compose.yml): Launches the local PostgreSQL 16 database container on port `5432`.
- [`tsconfig.base.json`](file:///Users/nimrodfeldman/playground/embody/tsconfig.base.json): Shared TypeScript compiler settings across all monorepo packages.
- [`ARCHITECTURE.md`](file:///Users/nimrodfeldman/playground/embody/ARCHITECTURE.md): The core architectural source-of-truth reference document.

---

## 📦 `framework/` — Framework & Core Infrastructure

The `framework/` directory contains the foundational, non-selectable framework modules:

| Package | Path | Purpose |
| :--- | :--- | :--- |
| **`kernel`** | [`framework/kernel`](file:///Users/nimrodfeldman/playground/embody/framework/kernel) | The Microkernel core engine. Defines `EmbodyPlugin` contracts, capability manifests, DI registry, hooks registry, logger, and lifecycle manager. Contains 0 business logic. |
| **`core`** | [`framework/core`](file:///Users/nimrodfeldman/playground/embody/framework/core) | The `@embody/core` plugin. Foundation for all business apps. Owns shared `parties`, `entities` registry, `entity_relationships`, `audit_log`, and `outbox`. |
| **`db`** | [`framework/db`](file:///Users/nimrodfeldman/playground/embody/framework/db) | Drizzle ORM database connection layer, Row-Level Security (RLS) helpers, transaction wrapper, and SQL migration runners. |
| **`auth`** | [`framework/auth`](file:///Users/nimrodfeldman/playground/embody/framework/auth) | Session management, tenant identification, and centralized permission authorization checks (`ctx.can`). |
| **`mcp-server`**| [`framework/mcp-server`](file:///Users/nimrodfeldman/playground/embody/framework/mcp-server) | Stdio Model Context Protocol (MCP) server runner that exposes plugin tools/resources to AI assistants. |
| **`cli`** | [`framework/cli`](file:///Users/nimrodfeldman/playground/embody/framework/cli) | The `embody` command-line binary powering CLI subcommands registered by plugins. |
| **`plugin-sdk`**| [`framework/plugin-sdk`](file:///Users/nimrodfeldman/playground/embody/framework/plugin-sdk) | `defineEntity`, the write path plugins build on. It runs the `before*`/`after*` hook chains **inside the tenant transaction** around every entity write, so a rule registered by another plugin genuinely vetoes the write (a throw rolls it back). |
| **`host`** | [`framework/host`](file:///Users/nimrodfeldman/playground/embody/framework/host) | Reusable Hono web server runner. Boots kernel, runs plugin lifecycle, and serves HTTP. Also mounts the **`/api` tool bridge** (`api.ts`, `errors.ts`, `identity.ts`): every plugin tool callable over HTTP through the same executor as MCP and the CLI. |
| **`react`** | [`framework/react`](file:///Users/nimrodfeldman/playground/embody/framework/react) | `@embody/react` — hooks over that bridge (`useToolQuery`, `useToolMutation`, `useTools`, `useCan`), with a small `useSyncExternalStore` cache. Zero runtime dependencies; `react` is a peer dependency. See [React Hooks](./react-hooks.md). |

---

## 📦 `catalog/` — First-Party Catalog Apps

The `catalog/` directory holds selectable business feature plugins that a deployment can enable in its `embody.config.ts`.

- [`catalog/crm/`](file:///Users/nimrodfeldman/playground/embody/catalog/crm): The `@embody/crm` plugin package.
  - `src/plugin.ts`: Defines `crmPlugin` (`EmbodyPlugin`), declaring capabilities, Drizzle migrations, an info route (`/crm`), and MCP tools (`crm_create_deal`, `crm_query_deals`, …). Those tools are simultaneously the agent's actions, the CLI's actions, and the UI's API.
  - `src/schemas.ts`: The tool input schemas and `DealRow`, in a leaf module importing **only zod** — exported as `@embody/crm/schemas` so a browser can share the exact shapes the server validates against. Every catalog app should follow this pattern.
  - `migrations/`: Versioned SQL migrations creating the `crm` Postgres schema and `crm.deals` table.

---

## 📖 `examples/` — Reference Code (Copy It, Don't Edit It)

Upstream-owned samples. They exist to be read and copied; editing them costs you a
merge conflict on the next upgrade.

- [`examples/service-crm/`](file:///Users/nimrodfeldman/playground/embody/examples/service-crm): A reference deployment enabling **catalog apps only**. Copy it, or run `embody new deployment <yours>`.
- [`examples/demo-ui/`](file:///Users/nimrodfeldman/playground/embody/examples/demo-ui): The demo SPA — two complete CRMs plus the AI copilot. Served by its own Vite dev server on port 5173. Most pages read an in-browser demo store; `src/live/` is the exception — the **Live data** page reads and writes real `crm.deals` rows through `@embody/react`, and is where you watch a catalog rule and a `custom/` rule both refuse a close.

---

## 🚀 `deploy/` — Your Deployables

Each deployment is a thin package: an `embody.config.ts` selecting which plugins run
together in one process, plus the `@embody/host` engine. There is no server code to fork.

```bash
embody new deployment acme --apps crm,b2b-saas
```

- [`deploy/acme/`](file:///Users/nimrodfeldman/playground/embody/deploy/acme): Worked example — catalog apps plus Acme's own `acme-crm` plugin.

This directory is **yours**. That matters: the line enabling a customization lives here,
in a file upstream never writes to, so it cannot conflict when you upgrade.

---

## 🛠️ `custom/` — Your Plugins (No Forking!)

Where a company places its own proprietary plugins.

```bash
embody new custom <name> --for deploy/<yours>
```

That one command creates the package **and** wires it into your deployment (dependency,
import, and `plugins` array).

- [`custom/acme-crm/`](file:///Users/nimrodfeldman/playground/embody/custom/acme-crm): Worked example — owns the `custom_acme` schema, gates healthcare deal closes on a HIPAA review, and ships its own MCP tools and CLI command.

Name these packages **unscoped and private** (`acme-crm`) — `@embody/*` is the vendor's
npm scope, not yours. `embody doctor` warns if one drifts.

> [!TIP]
> **Why `custom/` works**: a rule you register here is not advisory. Entity writes run
> through `defineEntity` in `@embody/plugin-sdk`, which executes the `before*` hook chain
> **inside the tenant transaction** — so throwing rolls the write back, for AI agents, the
> CLI, and a browser alike. Over HTTP your rule arrives as a `409 veto` carrying your own
> message. That is why you can change how a catalog app behaves without editing it. See
> [OWNERSHIP.md](../OWNERSHIP.md).
