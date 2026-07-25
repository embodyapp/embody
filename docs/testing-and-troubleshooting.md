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

## 🌐 3. Testing the HTTP Tool Bridge

Hono needs no listening socket: `app.request(...)` (or `app.fetch(new Request(...))`) drives the real app in-process, which makes bridge tests as fast as unit tests.

```typescript
const res = await runtime.booted.app.request("/api/tools/crm_query_deals", {
  method: "POST",
  headers: {
    "content-type": "application/json",   // required — the bridge's CSRF check
    "x-embody-org": orgId,                // needs EMBODY_DEV_IDENTITY, or pass
    "x-embody-user": userId,              // allowUnauthenticatedIdentity to createDevIdentity
  },
  body: JSON.stringify({ input: { limit: 50 } }),
});
expect(res.status).toBe(200);
const { result } = await res.json();
```

Two levels are worth keeping separate:

- **No database.** Hand-build a fake `Runtime` whose `booted.mcp.tools` are real Zod schemas with handlers that throw the failures you care about, and never touch `req.tx`. See `packages/host/src/api.test.ts` — it covers the whole request path in milliseconds.
- **Real Postgres.** Only for what a fake cannot show: RLS, RBAC and genuine vetoes over HTTP. See `examples/custom-crm/src/api.integration.test.ts`.

### Testing React hooks

This repo has no vitest config files, so the DOM environment is selected per file with a docblock pragma on **line 1**:

```typescript
// @vitest-environment happy-dom
```

`@testing-library/react`'s automatic cleanup needs `globals: true`, which we do not set — call it yourself or renders leak between tests:

```typescript
import { cleanup } from "@testing-library/react";
afterEach(cleanup);
```

Most hook behaviour is really cache behaviour, and is covered without React at all in `ui/react/src/cache.test.ts`. Keep the rendered tests for what only React can show — StrictMode's double mount, and optimistic rollback.

---

## 🔧 4. Troubleshooting Common Errors

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
