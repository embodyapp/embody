# Embody: Agent App Framework — Specifications

This repository contains the complete architectural specifications for **Embody**, a plugin framework designed to build, deploy, and operate autonomous agent-ready applications with unified CLI and Model Context Protocol (MCP) surfaces.

## Implementation planning

The agent-executable phased plan, test success criteria, decision gates, and live status tracker are in [`docs/implementation-plan/`](./docs/implementation-plan/README.md). Implementing agents should start with that README and [`STATUS.md`](./docs/implementation-plan/STATUS.md).

---

## 📑 Detailed Specifications Directory

The complete technical specifications are located in [`docs/specs/`](./docs/specs/):

1. [**01. System Architecture & Centralized Gateway**](./docs/specs/01-system-architecture.md)
   * System topology, Central Gateway Hub, push registration protocol, and reverse proxy routing.
2. [**02. Plugin Microkernel SPI**](./docs/specs/02-plugin-microkernel-spi.md)
   * Microkernel contracts, 7-phase boot lifecycle, capability sandboxing, and vetoable guardrail hooks.
3. [**03. Dynamic Entity Engine**](./docs/specs/03-dynamic-entity-engine.md)
   * Zero-migration dynamic entities, Zod validation, auto-generated CRUD actions, and PostgreSQL `JSONB` / SQLite storage.
4. [**04. Pluggable Auth & Identity**](./docs/specs/04-pluggable-auth-identity.md)
   * Dual-sided auth plugins (Gateway OIDC/API Key providers + Remote App token verifiers), `Principal` model, and Postgres RLS.
5. [**05. Client Surfaces: CLI & MCP**](./docs/specs/05-client-surfaces-cli-mcp.md)
   * Unified hierarchical CLI (`embody <app> <entity/action>`), global aggregated `/mcp`, and scoped `/mcp/:app` endpoints.
6. [**06. Durable Outbox & SSE Streaming**](./docs/specs/06-durable-outbox-events-streaming.md)
   * Zero-infra transactional outbox, in-process concurrent worker (`FOR UPDATE SKIP LOCKED`), and live progress streaming.
7. [**07. Developer Tooling & Testing**](./docs/specs/07-developer-tooling-testing.md)
   * `create-embody-app` scaffolding, `embody dev` local server with Web MCP Dev Inspector, and `@embody/testing` harness.
8. [**08. Reference Applications**](./docs/specs/08-reference-apps.md)
   * End-to-end reference implementation specifications for the Kanban Board and Email Automation apps.
