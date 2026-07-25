# AI & Model Context Protocol (MCP) Integration

Embody is built **AI-native from day one**. AI assistants (such as Claude, Cursor, or Antigravity) can safely interact with business data and trigger plugin logic via the **Model Context Protocol (MCP)**.

---

## 🤖 What is Model Context Protocol (MCP)?

MCP is an open standard that allows LLMs to query databases, call function tools, and read structured application resources with strongly-typed schemas.

In Embody:
- Every plugin can expose **MCP Tools** (agent-callable actions like `crm_create_deal`).
- Every plugin can expose **MCP Resources** (read-only structured contexts like `crm://deals/pipeline`).

---

## 🔒 Security & Authorization Parity

> [!IMPORTANT]
> **MCP is NOT a back-door around security!**
> AI tool executions pass through the exact same tenant Row-Level Security (RLS) policies and permission authorization checks (`req.assert("write", "crm:deal")`) as a human clicking a button in a UI.

That parity is literal, not aspirational: all three arrows below are the **same function call** (`makeExecutor(...).invoke(tool, input)`). A UI does not get its own REST API — it calls the very tools you write here, over the `/api` bridge described in [React Hooks & the HTTP Bridge](./react-hooks.md).

```text
 ┌────────────────┐          ┌───────────────────┐
 │ Browser (UI)   │─────────►│                   │
 │ @embody/react  │          │  makeExecutor()   │
 └────────────────┘          │                   │
 ┌────────────────┐          │  req.assert()     │
 │ AI Assistant   │─────────►│  + Tenant RLS     │─────► Postgres DB
 │ (stdio MCP)    │          │  + vetoable hooks │
 └────────────────┘          │                   │
 ┌────────────────┐          │                   │
 │ CLI / scripts  │─────────►│                   │
 └────────────────┘          └───────────────────┘
```

One practical consequence: **writing a tool is writing your UI's API.** There is no second surface to build, and no way for a UI to skip a rule an agent must obey.

---

## 🛠️ Exposing MCP Tools in Your Plugin

Use `registerMcpTools` inside your `EmbodyPlugin` object. Validate inputs using **Zod**:

```typescript
import { z } from "zod";

registerMcpTools(mcp, ctx) {
  mcp.tool({
    name: "crm_create_deal",
    description: "Create a new deal for a company in the current tenant.",
    input: z.object({
      title: z.string().min(1),
      amount: z.number().positive().optional(),
      stage: z.string().optional(),
    }),
    handler: (input, req) => {
      // 1. Verify caller has permission to write CRM deals
      req.assert("write", "crm:deal");

      // 2. Run inside tenant database transaction with RLS active
      return req.tx(async (tx) => {
        const [deal] = await tx`
          INSERT INTO crm.deals (org_id, title, amount, stage)
          VALUES (${req.orgId}, ${input.title}, ${input.amount ?? null}, ${input.stage ?? "lead"})
          RETURNING id, title, amount, stage;
        `;
        return deal;
      });
    },
  });
}
```

---

## 📄 Exposing MCP Resources

MCP Resources give AI assistants context about current data structures:

```typescript
registerMcpResources(mcp, ctx) {
  mcp.resource({
    uri: "crm://deals/stages",
    name: "CRM Deal Stages",
    description: "Returns standard stage names for deals in this organization.",
    handler: async (req) => {
      return {
        stages: ["lead", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"],
      };
    },
  });
}
```

---

## 🖥️ Running the MCP Server Process

Embody includes a universal stdio MCP server package located in [`framework/mcp-server`](file:///Users/nimrodfeldman/playground/embody/framework/mcp-server).

Run the stdio MCP server runner filtered by plugins:

```bash
pnpm --filter @embody/mcp-server run start --plugins crm
```

AI clients connect via stdio and automatically discover all registered tools and resources!
