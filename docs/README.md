# Embody Documentation Hub

> **The Connected Application Framework & Operational Hub for Autonomous AI Agents**

Welcome to the comprehensive documentation for Embody. Whether you are building your first agent-native tool or architecting an enterprise multi-agent backend, these guides explain everything from scratch with runnable examples.

---

## 🗺️ Documentation Sitemap

```
docs/
├── 🚀 Getting Started
│   ├── 01. Introduction              ──► Why Embody? The Agent Backend Problem
│   ├── 02. 5-Minute Quickstart       ──► Scaffold and run your first app
│   ├── 03. Core Concepts             ──► Applications, Plugins, Entities, Hooks, Outbox
│   └── 04. Project Structure         ──► Layout, embody.config.ts, and environment variables
│
├── 📖 Guides & Deep Dives
│   ├── 01. Defining Plugins          ──► Plugins, microkernel, lifecycle, and services
│   ├── 02. Entities & Storage        ──► Zod dynamic schemas, CRUD tools, SQLite vs Postgres
│   ├── 03. Actions & Handlers        ──► Custom business actions, validation, SSE progress
│   ├── 04. Safety Guardrails         ──► The Mechanical Policy Shield & pre-commit vetoes
│   ├── 05. Events & Outbox           ──► Transactional outbox, reliable delivery, SSE streaming
│   ├── 06. Authentication & Auth    ──► Principal identity, actor types, JWTs, and keys
│   └── 07. Gateway & Control Plane   ──► Multi-app routing, reverse proxy, and MCP aggregation
│
├── 🤖 Agent Integrations
│   ├── 01. Model Context Protocol    ──► How Embody compiles actions to MCP tools
│   ├── 02. Claude Desktop            ──► Connecting Anthropic Claude Desktop
│   ├── 03. Cursor & Cline            ──► Connecting Cursor IDE and Cline VS Code extension
│   └── 04. Custom Agent SDKs         ──► Python, LangChain, Node.js, and raw HTTP/SSE
│
├── 🛠️ Developer Tools
│   ├── 01. CLI Reference             ──► Full command syntax, JSON piping, flags, exit codes
│   ├── 02. Web Inspector             ──► Live development schema and tool visualizer
│   └── 03. Testing Guide             ──► Unit & E2E tests with @embody/testing
│
├── 🎓 Step-by-Step Tutorials
│   ├── 01. AI Kanban Board           ──► Build an engineering board with PR safety hooks
│   └── 02. Email Automation          ──► Build an outbox campaign dispatcher with approval gates
│
└── 🚢 Production & Operations
    ├── 01. Deployment                ──► Docker, PostgreSQL, health checks, clustering
    └── 02. Troubleshooting & FAQ     ──► Common error codes, debugging vetoes, and FAQ
```

---

## 📚 Section Overview

### 🚀 [Getting Started](./getting-started/01-introduction.md)
Start here if you are new to Embody:
- **[Introduction](./getting-started/01-introduction.md)**: Why traditional web frameworks and direct SQL fail for autonomous agents.
- **[5-Minute Quickstart](./getting-started/02-quickstart.md)**: Scaffold a project with `create-embody-app` and test your first agent tool.
- **[Core Concepts](./getting-started/03-core-concepts.md)**: The mental model: Apps, Plugins, Entities, Actions, and Hooks.
- **[Project Structure](./getting-started/04-project-structure.md)**: File organization and environment variables.

### 📖 [Core Guides](./guides/01-defining-plugins.md)
Master the architecture of Embody:
- **[Defining Plugins](./guides/01-defining-plugins.md)**: Plugin architecture, the 7-phase microkernel boot process, and services.
- **[Entities & Storage](./guides/02-entities-and-storage.md)**: Schema declaration with Zod, automated CRUD, optimistic locking, and database engines.
- **[Actions & Handlers](./guides/03-actions-and-handlers.md)**: Custom workflows, progress reporting, and cancellation.
- **[Mechanical Safety Guardrails](./guides/04-mechanical-safety-guardrails.md)**: Pre-commit veto hooks, spend limits, and supervisor gates.
- **[Events & Outbox](./guides/05-events-and-outbox.md)**: The Transactional Outbox pattern, reliable at-least-once delivery, and SSE streaming.
- **[Authentication & Identity](./guides/06-authentication-and-principals.md)**: Principals, actor types (`agent` vs `human` vs `system`), and tokens.
- **[Gateway & Control Plane](./guides/07-gateway-and-control-plane.md)**: Aggregated MCP endpoints and centralized routing.
- **[Durable Workflows](./guides/08-durable-workflows.md)**: Versioned DAGs, retries, cancellation, compensation, and deterministic tests.

### 🤖 [Agent Integrations](./agent-integrations/01-model-context-protocol.md)
Connect your AI agents seamlessly:
- **[Model Context Protocol (MCP)](./agent-integrations/01-model-context-protocol.md)**: Target mapping, JSON schemas, and error envelopes.
- **[Claude Desktop](./agent-integrations/02-claude-desktop.md)**: Setup, prompts, and testing safety vetoes with Claude.
- **[Cursor & Cline](./agent-integrations/03-cursor-and-cline.md)**: Direct IDE integration for autonomous coding agents.
- **[Custom Agent SDKs](./agent-integrations/04-custom-agents-sdk.md)**: Connecting Python, LangChain, LlamaIndex, or raw HTTP/SSE clients.

### 🛠️ [Developer Tools](./developer-tools/01-cli-reference.md)
Supercharge your developer workflow:
- **[CLI Reference](./developer-tools/01-cli-reference.md)**: Comprehensive command documentation, syntax, flags, and exit codes.
- **[Web Inspector](./developer-tools/02-dev-inspector.md)**: Interactive browser tool for schemas, action runs, and actor simulation.
- **[Testing Guide](./developer-tools/03-testing-guide.md)**: Writing unit and E2E tests with the `@embody/testing` harness.

### 🎓 [Tutorials](./tutorials/01-kanban-board.md)
Learn by building production-grade examples:
- **[AI Kanban Board](./tutorials/01-kanban-board.md)**: Multi-agent task management with PR completion guardrails.
- **[Email Automation](./tutorials/02-email-automation.md)**: Campaign dispatcher with supervisor approval gates and progress streaming.

### 🚢 [Production](./production/01-deployment.md)
Ship with confidence:
- **[Deployment & Operations](./production/01-deployment.md)**: Dockerfile, PostgreSQL pooling, health checks, and graceful shutdown.
- **[Troubleshooting & FAQ](./production/02-troubleshooting-faq.md)**: Debugging common errors, HookVetoError, and answers to common questions.
- **[Security](./production/03-security.md)** and **[operations runbook](./production/04-operations-runbook.md)**.
- **[Compatibility/upgrades](./production/05-compatibility-and-upgrades.md)** and **[performance baseline](./production/06-performance-baseline.md)**.
- **[Release evidence checklist](./RELEASE-CHECKLIST.md)**.

---

## 🏛️ Internal Engineering Specifications

Looking for low-level protocol specifications, architectural decision records (ADRs), or monorepo development plans?
- **[Architectural Decision Records (ADR)](./adr/)**
- **[Detailed System Specs](./specs/)**
- **[Phase Implementation Plans](./implementation-plan/)**
