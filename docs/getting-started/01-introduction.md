# Introduction to Embody

> **The Connected Application Framework & Operational Hub for Autonomous AI Agents**

---

## ⚡ The Shift: From Human Clicks to Autonomous Agent Execution

Over the past two years, developer tools underwent a dramatic revolution. Tools like v0, Lovable, Bolt, and Cursor made it trivial to generate frontend UIs, prototypes, and landing pages for **humans to click**.

However, when teams attempt to put **autonomous AI agents** (like Claude, Devin, Cline, OpenHands, or custom LLM workers) to work inside real business operations, they encounter a fundamental roadblock:

```
Human Software:   Visual UIs  ──►  Clicks & Forms  ──►  Tolerant of loose errors
Agent Software:   Raw APIs    ──►  DB Mutations    ──►  Zero tolerance for hallucinations
```

### The Three Pitfalls of Raw Agent Access

When engineering teams attempt to connect AI agents to their internal business systems, they usually resort to one of three fragile patterns:

1. **Giving Agents Direct SQL / Database Access**:
   Agents write raw queries. They lack business logic awareness, violate invariants, bypass validation rules, perform catastrophic unindexed table scans, and hallucinate foreign key relationships.
2. **Exposing Unattenuated Internal REST APIs**:
   Traditional API keys grant full administrative power. An agent given a Stripe, GitHub, or internal ERP key has no capability attenuation—it can delete customers or drain account balances on a single hallucinated prompt loop.
3. **Fragile Prompt-Chained Ad-Hoc Scripts**:
   Building dozens of custom one-off scripts with loose JSON outputs leads to severe schema drift, zero transactional integrity, and unmaintainable glue code.

---

## 💡 What is Embody?

**Embody is the backend application framework built specifically for autonomous AI agents.**

Just as Next.js or Ruby on Rails revolutionized how web backends serve human browsers, Embody is engineered from the ground up for how AI agents consume, mutate, and interact with business software.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Autonomous AI Agents                            │
│           Claude Desktop  •  Cursor  •  Cline  •  SDKs                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Model Context Protocol (MCP) / CLI
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                             EMBODY HOST                                │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                     Mechanical Policy Shield                   │   │
│   │      Principal Scoping  •  Spend Gates  •  Vetoable Hooks      │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
│                                   │                                    │
│   ┌───────────────────────────────▼────────────────────────────────┐   │
│   │                    Deterministic Microkernel                   │   │
│   │        Zod Dynamic Entities  •  Strict Typed Actions           │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
│                                   │                                    │
│   ┌───────────────────────────────▼────────────────────────────────┐   │
│   │                 Transactional Outbox Engine                    │   │
│   │        Durable Events  •  SSE Progress  •  Audit Logs          │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
└───────────────────────────────────┼────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Operational Storage                             │
│               SQLite (Dev)  /  PostgreSQL + RLS (Prod)                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🛡️ The Four Core Pillars of Embody

### 1. Instant Day-1 Agent Tools (MCP & Hierarchical CLI)
Every entity and business action declared in an Embody application automatically compiles into:
- **Model Context Protocol (MCP)** tools with standard JSON Schema input and output validation.
- A **hierarchical CLI** (`embody <app> <entity> <action>`) ready for local terminal testing and agent shell execution.
- A **live Web Inspector** (`/__inspector`) to visualize and invoke actions interactively.

You never have to manually write MCP glue code or keep OpenAPI specs in sync again.

### 2. One Shared Company Brain (Zero Schema Drift)
Agents across your organization collaborate on a single connected storage engine (PostgreSQL or SQLite). All reads and writes pass through strict **Zod schemas** that are checked before mutations touch the disk:
- Optimistic concurrency control prevents race conditions when multiple agents work simultaneously.
- Automatic secondary indexes optimize agent lookups.
- Row-Level Security (RLS) and organization scoping (`orgId`) enforce multi-tenant isolation out of the box.

### 3. Mechanical Safety & Policy Guardrails (The Policy Shield)
You never rely on LLM system prompts to enforce safety rules. In Embody:
- Every execution identifies the **Actor Type** (`agent`, `human`, or `system`).
- Pre-commit hooks (`beforeCreate`, `beforeUpdate`, `beforeDelete`, `beforeAction`) can evaluate state transitions and throw `HookVetoError` before transactions commit.
- Mechanical policies enforce hard spending limits, mandatory pull request URLs, and required human supervisor approvals.

### 4. Durable Outbox & SSE Streaming
Long-running agent workflows cannot afford lost events or broken HTTP connections:
- **Transactional Outbox**: Business mutations and event publications commit atomically in the same database transaction.
- **SSE Live Progress**: Long-running actions stream ordered progress updates (`context.progress({ percent, message })`) back to agents and humans.
- **Deterministic Audit Trail**: Every action execution generates an immutable audit record capturing actor ID, parameters, timestamp, and result.

---

## 🗺️ How to Read This Documentation

This documentation is structured into five progressive sections:

1. **[Getting Started](../getting-started/02-quickstart.md)**: Install Embody, scaffold your first app with `create-embody-app`, and run the local development server.
2. **[Core Guides](../guides/01-defining-plugins.md)**: Deep dives into Plugins, Dynamic Entities, Typed Actions, Safety Hooks, Events, and Authentication.
3. **[Agent Integrations](../agent-integrations/01-model-context-protocol.md)**: Connect Claude Desktop, Cursor, Cline, or custom LangChain/Python agents.
4. **[Developer Tools](../developer-tools/01-cli-reference.md)**: Master the CLI, test applications with `@embody/testing`, and explore the Web Inspector.
5. **[Step-by-Step Tutorials](../tutorials/01-kanban-board.md)**: Build an Agent Kanban Board and an Email Dispatcher from scratch.
6. **[Production & Deployment](../production/01-deployment.md)**: Docker containerization, PostgreSQL configuration, and environment setup.

Next: **[5-Minute Quickstart →](./02-quickstart.md)**
