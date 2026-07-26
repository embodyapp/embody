# embody — Headless Business Operating System

> **Welcome to embody!** `embody` is an open-source, AI-native, **headless business operating system**. Think of it as a solid foundation that a company can run instead of paying for dozens of separate SaaS subscriptions (like CRMs, accounting tools, or customer support platforms).

---

## 💡 What is Embody? (In Simple Terms)

Imagine you are building software for a growing company. Usually, companies buy separate tools: Salesforce for CRM, QuickBooks for accounting, Zendesk for support. Over time, these tools don't talk to each other cleanly, customer data gets duplicated, and subscriptions become extremely expensive.

**Embody solves this with a Microkernel Architecture:**
1. **Tiny Core (Microkernel)**: A lightweight engine (`@embody/kernel`) that manages security, database connections, background tasks, and AI integrations, but contains zero specific business logic.
2. **Modular Plugins**: Every business feature (like CRM, ERP, or Billing) is built as a plug-in module.
3. **Unified System of Record**: Customers, products, and users live in one shared place (`@embody/core`), while individual apps attach their own custom details ("facets").
4. **No Forking Required**: Companies can write their own plugins or add custom fields without ever editing or forking the core codebase.

---

## 🔑 Key Architecture Highlights

| Concept | Plain Language Explanation |
| :--- | :--- |
| **Microkernel** | A tiny core engine. Features (CRM, Accounting) plug into it as separate packages. |
| **Plugin** | A self-contained package with its own database tables, AI tools, and CLI commands. Registering a tool once makes it callable by an agent, a script, and a UI. |
| **Multi-Tenant (RLS)** | One instance can serve many companies ("tenants") safely. Row-Level Security in Postgres automatically isolates company data. |
| **Shared Core & Facets** | A person is stored once in `core.parties`. The CRM plugin adds a "contact profile" facet to that same person instead of copying them. |
| **Entity Registry** | A lightweight pointer index (`core.entities`) enabling global search across all plugins and linking records (e.g. linking a Deal to a Person). |
| **Model Context Protocol (MCP)** | Built-in AI assistant integration. AI tools pass through the exact same security and permission checks as web users. |

---

## ⚡ Quickstart & Local Setup

Get up and running locally in 4 simple steps!

> [!NOTE]
> **Prerequisites:**
> - **Node.js**: `v20` or higher
> - **pnpm**: `v10` or higher (`npm i -g pnpm`)
> - **Docker Desktop**: Required to run PostgreSQL locally

### 1. Clone & Install Dependencies
```bash
cd embody
pnpm install
```

### 2. Start PostgreSQL Database
```bash
pnpm db:up
```
*This starts a local PostgreSQL instance on port `5432` via Docker Compose.*

### 3. Set Up Environment Variables
```bash
cp .env.example .env
```

### 4. Run Development Server
```bash
pnpm dev
```

Run test suite to make sure everything works:
```bash
pnpm test
```

---

## 🗺️ Project Directory Map

> This is the layout of **this repository** — the one that publishes embody. You do not
> need it to build an app; see [Build your own app](#-build-your-own-app) below.

Each bucket answers one question: *does this ship, and to whom?* See
[PLUGINS.md](PLUGINS.md).

```text
embody/
│
├── packages/           📦  Published as @embody/*. The runtime and the SPI.
│   ├── plugin-sdk/        @embody/plugin-sdk  THE public contract a plugin builds on
│   ├── kernel/            @embody/kernel      Microkernel: lifecycle, DI, hooks, capabilities
│   ├── core/              @embody/core        Shared entities, parties, registry
│   ├── db/                @embody/db          Drizzle ORM, RLS helpers, migration runner
│   ├── auth/              @embody/auth        Principals, RBAC, req.assert() checks
│   ├── host/              @embody/host        HTTP engine + the /api tool bridge
│   ├── cli/               @embody/cli         The `embody` binary
│   ├── mcp-server/        @embody/mcp-server  Stdio MCP runner for AI agents
│   ├── testing/           @embody/testing     Boot a real runtime in your plugin's tests
│   └── create-embody-app/ create-embody-app   The project generator
│
├── plugins/            📦  Published. First-party plugins, on the PUBLIC SPI.
│   └── crm/               @embody/crm         Deals, contact profiles
│
├── ui/                 📦  Published, separate version line. Not part of embody itself.
│   └── react/             @embody/react       Hooks over the /api bridge
│
├── demo/               🖥️  Never published. Look at it.
│   └── demo-ui/           The demo SPA: two full CRMs + AI copilot + a live page
│
└── examples/           📖  Never published. Copy it.
    ├── custom-crm/        A complete app: config + its own plugin + its own schema
    ├── b2b-saas/          A plugin written the way a community plugin is
    └── ecom-fulfillment/  Another one
```

`plugins/crm` depends on `@embody/plugin-sdk` by version range rather than by workspace
link, so it continuously proves the public SPI is enough to build a real plugin.

---

## 🧩 Build your own app

You never clone this repo to use embody. It comes from npm:

```bash
npm create embody-app my-crm
```

That gives you a project you own outright — a config listing which plugins run, your own
plugin, and your own schema:

```text
my-crm/
├── embody.config.ts      which plugins run
├── src/plugin.ts         your rules, tools, extra fields
└── migrations/           your schema
```

Add another plugin and enable it in one step:

```bash
npx embody new plugin compliance
```

Check your wiring — most importantly, that every plugin shares one copy of the SDK:

```bash
npx embody doctor
```

Upgrade with `npm update`. There is no fork to maintain and nothing to merge.

---

## 📚 Complete Documentation Index

We have created comprehensive, step-by-step guides for developers of all experience levels:

| Guide | Description |
| :--- | :--- |
| 🚀 [**Getting Started Guide**](file:///Users/nimrodfeldman/playground/embody/docs/getting-started.md) | Detailed installation, Docker setup, running local services, and running CLI commands. |
| 🏗️ [**Architecture Overview**](file:///Users/nimrodfeldman/playground/embody/docs/architecture-overview.md) | Beginners' deep-dive into the 8 design decisions, plugin lifecycle, and data model. |
| 📁 [**Directory Structure**](file:///Users/nimrodfeldman/playground/embody/docs/directory-structure.md) | Folder-by-folder breakdown of every file, package, app, and service in the repository. |
| 🧩 [**Plugins: the contract**](file:///Users/nimrodfeldman/playground/embody/PLUGINS.md) | What publishes, the one-package SPI rule, peer dependencies, and publishing a plugin others can install. |
| 📦 [**Writing a Plugin Others Can Use**](file:///Users/nimrodfeldman/playground/embody/docs/writing-a-plugin-others-can-use.md) | Packaging, peer dependencies, schema naming, and the pre-publish checks that catch a broken plugin. |
| 🧩 [**Writing Plugins**](file:///Users/nimrodfeldman/playground/embody/docs/writing-plugins.md) | Complete step-by-step tutorial on building a custom plugin from scratch. |
| 🪝 [**Middleware & Hooks**](file:///Users/nimrodfeldman/playground/embody/docs/middleware-and-hooks.md) | How to write HTTP middlewares, vetoable synchronous hooks, and post-commit events. |
| ⚡ [**Automation**](file:///Users/nimrodfeldman/playground/embody/docs/automation.md) | Set a trigger, write a function: configurable workflows over the durable event bus, with no low-code builder. |
| 💻 [**CLI Guide**](file:///Users/nimrodfeldman/playground/embody/docs/cli-guide.md) | Complete guide for running the `embody` CLI binary, invoking tools, seeding data, and scaffolding apps. |
| 🔄 [**Customization & Upgrades**](file:///Users/nimrodfeldman/playground/embody/docs/customization-and-upgrades.md) | Real-world example comparing how a **B2B SaaS** vs **E-Commerce** company customizes the CRM without forking. |
| 🤖 [**AI & MCP Integration**](file:///Users/nimrodfeldman/playground/embody/docs/mcp-and-ai.md) | How Model Context Protocol works and how to write AI tools for Embody. |
| ⚛️ [**React Hooks & the HTTP Bridge**](file:///Users/nimrodfeldman/playground/embody/docs/react-hooks.md) | Building a UI on `@embody/react`: the `/api` tool bridge, the error taxonomy, caching, and identity. |
| 🔒 [**Security & Multi-Tenancy**](file:///Users/nimrodfeldman/playground/embody/docs/security-and-multitenancy.md) | PostgreSQL Row-Level Security (RLS) and Kernel Capability Sandboxing. |
| 🧪 [**Testing & Troubleshooting**](file:///Users/nimrodfeldman/playground/embody/docs/testing-and-troubleshooting.md) | Writing Vitest integration tests and debugging common development issues. |

---

## 🤝 Contributing & License

Embody is open-source software under the MIT License. Contributions, plugin additions, and feedback are always welcome!
# embody
