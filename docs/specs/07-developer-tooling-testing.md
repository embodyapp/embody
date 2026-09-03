# 07. Developer Tooling & Testing Specification

## 1. App Scaffolding (`create-embody-app`)

Developers can scaffold a new production-ready agent application in seconds:

```bash
npx create-embody-app@latest my-agent-service
```

### 1.1 Generated Project Layout
```text
my-agent-service/
  ├── embody.config.ts        # App host configuration & plugins
  ├── src/
  │   ├── index.ts            # Entrypoint (app.listen)
  │   ├── plugin.ts           # Domain entities, actions, hooks
  │   └── plugin.test.ts      # In-memory test suite
  ├── package.json
  ├── tsconfig.json
  └── Dockerfile
```

---

## 2. Local Development Server & Web Inspector (`embody dev`)

Running `embody dev` boots the local microkernel host with hot-reloading and mounts an interactive developer inspector:

```bash
$ embody dev

  🚀 Embody Host running on http://localhost:8080
  🛠  Dev Inspector API: http://localhost:8080/__inspector

  Registered Tools:
    ✔ kanban.card.create
    ✔ kanban.card.get
    ✔ kanban.card.list
    ✔ kanban.card.update
    ✔ kanban.card.delete
```

### 2.1 Development Inspector API

The framework provides no web frontend. Its development-only, loopback-bound `/__inspector` endpoints expose JSON for external tools:

* **Manifest and execution**: Read schemas and invoke actions through the normal execution path.
* **Outbox status**: Read redacted event metadata and status transitions.
* **Hook diagnostics**: Integrations may expose hook traces/latency where available; the base API does not require a UI.

---

## 3. Fast In-Memory Testing Harness (`@embody/testing`)

The `@embody/testing` package provides an in-memory testing environment that boots in under 10 milliseconds using SQLite:

```typescript
import { describe, it, expect } from "vitest";
import { createTestHarness } from "@embody/testing";
import { kanbanPlugin } from "./plugin";

describe("Kanban App Integration Tests", () => {
  it("enforces tenant isolation and guardrails", async () => {
    // 1. Instantiate test harness with principal context
    const harness = await createTestHarness({
      plugins: [kanbanPlugin],
      tenantId: "acme-corp",
      actor: {
        actorId: "agent-gemini-1",
        actorType: "agent",
        roles: ["operator"],
        scopes: ["kanban:*"],
      },
    });

    // 2. Execute auto-CRUD tool
    const card = await harness.call("kanban.card.create", {
      data: {
        title: "Migrate auth service",
        status: "in_progress",
        priority: "high",
      },
    });

    expect(card.id).toBeDefined();
    expect(card.data.title).toBe("Migrate auth service");

    // 3. Test vetoable guardrail rejection
    await expect(
      harness.call("kanban.card.update", {
        id: card.id,
        data: { status: "done" }, // Missing PR URL
      })
    ).rejects.toThrow(/Guardrail Veto/);
  });
});
```
