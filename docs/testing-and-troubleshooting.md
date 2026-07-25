# Testing & Troubleshooting Guide

This guide covers how to write unit and integration tests for your Embody plugins and how to resolve common development errors.

---

## 🧪 1. Writing Tests with Vitest

Embody uses **Vitest** across the entire monorepo. Tests live alongside source files (e.g. `kernel.test.ts` or `plugin.test.ts`).

### Running Tests
To run all tests across the repository:
```bash
pnpm test
```

To run tests for a specific package (e.g. `@embody/kernel`):
```bash
pnpm --filter @embody/kernel test
```

---

## 🧩 2. Writing a Plugin Unit Test

Below is an example of testing a plugin registration and lifecycle using `@embody/kernel`:

```typescript
import { describe, it, expect } from "vitest";
import { Kernel } from "@embody/kernel";
import { myCustomPlugin } from "./plugin.js";

describe("MyCustomPlugin Integration Test", () => {
  it("should register services and initialize cleanly", async () => {
    const kernel = new Kernel();

    // Register custom plugin
    kernel.register(myCustomPlugin);

    // Boot the kernel
    await kernel.boot();

    // Verify service presence in DI registry
    const service = kernel.services.get("myplugin.service");
    expect(service).toBeDefined();
  });
});
```

---

## 🔧 3. Troubleshooting Common Errors

### Error 1: `Capability Violation Error`
```text
Error: Plugin 'crm' attempted to consume service 'billing.invoices' which is not declared in its capability manifest.
```
- **Cause**: Your plugin code called `ctx.services.get("billing.invoices")` without listing `"billing.invoices"` under `capabilities.services.consume` in your plugin declaration.
- **Fix**: Open your `plugin.ts` file and update your `capabilities`:
  ```typescript
  capabilities: {
    services: {
      consume: ["core.registry", "billing.invoices"],
    },
  }
  ```

---

### Error 2: `Circular Dependency in Topo-Sort`
```text
Error: Circular dependency detected involving plugins: ['appA', 'appB']
```
- **Cause**: `appA` specifies `dependsOn: ["appB"]` and `appB` specifies `dependsOn: ["appA"]`.
- **Fix**: Break the cycle. Plugins should depend downwards on `@embody/core` or shared services rather than mutually depending on each other. Use domain hooks or events for cross-plugin communication instead of hard code dependencies!

---

### Error 3: `Database Connection Failed (ECONNREFUSED 127.0.0.1:5432)`
```text
Error: connect ECONNREFUSED 127.0.0.1:5432
```
- **Cause**: The local PostgreSQL container is not running.
- **Fix**: Run `pnpm db:up` to start the Docker PostgreSQL container.

---

### Error 4: `Row-Level Security Violation`
```text
Error: new row for relation "deals" violates row-level security policy for table "deals"
```
- **Cause**: SQL query executed without setting `app.current_org` session variable or missing `org_id` value on insert.
- **Fix**: Wrap your query inside `req.tx(async (tx) => ...)` so the kernel automatically binds the current tenant context.
