# Agent App Framework (Embody) — Technical Specifications

This directory contains the formal architectural and technical specifications for **Embody**, the microkernel plugin framework for building, deploying, and operating agent-ready applications across an organization.

---

## 📑 Specification Index

| Document | Title | Description |
| :--- | :--- | :--- |
| [**01. System Architecture & Gateway**](./01-system-architecture.md) | System Topology & Gateway Hub | Centralized Gateway Hub, dynamic app discovery, push-based registration protocol, and enterprise routing. |
| [**02. Plugin Microkernel SPI**](./02-plugin-microkernel-spi.md) | Plugin SPI & Microkernel Engine | Plugin lifecycle, capability manifests, dependency injection services, vetoable hooks, and execution context. |
| [**03. Dynamic Entity Engine**](./03-dynamic-entity-engine.md) | Zero-Migration Dynamic Entities | Declarative Zod schemas, auto-generated CRUD actions, and PostgreSQL JSONB / SQLite document storage. |
| [**04. Pluggable Auth & Identity**](./04-pluggable-auth-identity.md) | Pluggable Dual-Sided Security | Gateway auth providers (OIDC, API Key, SSO), signed `Principal` tokens, remote app verifiers, and Postgres RLS. |
| [**05. Client Surfaces: CLI & MCP**](./05-client-surfaces-cli-mcp.md) | Unified CLI & Multi-Modal MCP | Single hierarchical CLI surface (`embody <app> ...`), global aggregated `/mcp`, and scoped `/mcp/:app` endpoints. |
| [**06. Durable Outbox & SSE Streaming**](./06-durable-outbox-events-streaming.md) | Outbox, Events & Real-time SSE | Zero-infra transactional outbox, in-process concurrent worker (`SKIP LOCKED`), and live progress streaming. |
| [**07. Developer Tooling & Testing**](./07-developer-tooling-testing.md) | Tooling, Inspector & Testing | `create-embody-app` scaffolder, local dev server with Web MCP Inspector, and `@embody/testing` harness. |
| [**08. Reference Applications**](./08-reference-apps.md) | Reference Apps (Kanban & Email) | End-to-end specifications for distributed Kanban Board and Email Automation reference applications. |

---

## 🎯 Core Guiding Principles

1. **Everything is a Plugin**: Applications are modular hosts composed of plugins. Plugins encapsulate entities, actions, hooks, workflows, services, and event subscriptions.
2. **Instant Agent & Human Surfaces**: Every action and entity declared in a plugin automatically exposes a typed CLI subcommand and an MCP tool out of the box.
3. **Zero-Migration Entity Evolution**: Entities are defined in TypeScript/Zod and backed by dynamic JSONB storage. Teams can iterate and add fields without database downtime or running DDL migrations.
4. **Single Gateway Control Surface**: A central gateway aggregates distributed remote apps into a single CLI and MCP endpoint while providing centralized identity, rate limiting, and audit logging.
5. **Zero Extra Infrastructure for Durability**: The framework utilizes the app's existing PostgreSQL or SQLite database for transactional outbox event delivery and background jobs.
