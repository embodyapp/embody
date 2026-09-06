# Actions & Execution Handlers

> Learn how to declare custom business actions, validate inputs with Zod, stream real-time progress, and handle cooperative cancellations.

---

## ⚡ What is an Action?

While Dynamic Entities provide automatic CRUD operations, **Actions** are where your actual business workflows live.

Actions allow you to:
- Coordinate multi-step operations across multiple entities.
- Stream live progress updates back to agents and humans via Server-Sent Events (SSE).
- Interact with external services (e.g., GitHub, Stripe, Mailer).
- Enforce transactional consistency and emit domain events.
- Respond to client cancellations gracefully via `AbortSignal`.

---

## 🛠️ Declaring an Action

Actions are declared inside the second argument of `definePlugin` using the `define.action` helper:

```typescript
import { definePlugin, NotFoundError, z } from "@embody/core";

export const deploymentPlugin = definePlugin(
  {
    id: "deployment",
    version: "1.0.0",
    entities: {},
  },
  (define) => ({
    actions: {
      deployRelease: define.action({
        // 1. Description fed directly to AI agents during MCP tool discovery
        description: "Deploy a release tag to staging or production with live status checks",

        // 2. Input validation schema
        input: z.object({
          releaseTag: z.string().regex(/^v\d+\.\d+\.\d+$/, "Must be a valid semver tag (e.g. v1.2.3)"),
          targetEnvironment: z.enum(["staging", "production"]),
          dryRun: z.boolean().default(false),
        }),

        // 3. Output schema validation
        output: z.object({
          deploymentId: z.string().uuid(),
          deployedAt: z.string(),
          status: z.enum(["success", "dry_run_complete"]),
        }),

        // 4. Async execution handler
        handler: async (input, context) => {
          // Execution logic here...
          return {
            deploymentId: "d9e8c7b6-1234-5678-90ab-cdef01234567",
            deployedAt: new Date().toISOString(),
            status: input.dryRun ? "dry_run_complete" : "success",
          };
        },
      }),
    },
  })
);
```

---

## 🧭 The Action Execution Context (`KernelContext`)

Every action handler receives the parsed and validated `input` as its first argument, and the `KernelContext` as its second argument:

```typescript
handler: async (input, context) => { /* ... */ }
```

The `context` object provides access to the full power of the Embody microkernel:

### 1. `context.principal` (Caller Identity)
Contains the authenticated identity of the agent or user executing the action:

```typescript
if (context.principal.actorType === "agent") {
  console.log(`Action called by autonomous agent: ${context.principal.actorId}`);
}
```

### 2. `context.entities` (Dynamic Entity Accessors)
Query or mutate any entity registered across your application:

```typescript
const serviceRecord = await context.entities.service.get(input.serviceId);
await context.entities.deploymentLog.create({
  serviceId: input.serviceId,
  status: "in_progress",
});
```

### 3. `context.services` (Dependency Injection)
Access singleton services declared by plugins:

```typescript
const cloudClient = context.services.get<CloudProviderClient>("deployment.cloudClient");
await cloudClient.triggerBuild(input.releaseTag);
```

### 4. `context.events` (Transactional Outbox)
Atomically publish domain events that commit with your database updates:

```typescript
await context.events.publish("deployment.release.completed", {
  releaseTag: input.releaseTag,
  environment: input.targetEnvironment,
});
```

### 5. `context.progress({ percent, message })` (Live Streaming)
Stream real-time progress updates back over HTTP Server-Sent Events (SSE). Both the CLI and the MCP protocol receive these progress updates live:

```typescript
context.progress({ percent: 25, message: "Building Docker container..." });
// ... work ...
context.progress({ percent: 75, message: "Running database migrations..." });
// ... work ...
context.progress({ percent: 100, message: "Deployment complete" });
```

### 6. `context.signal` (Cooperative Cancellation)
If an agent aborts the request, or a user presses `Ctrl+C` in the CLI, `context.signal` emits an abort event. You can check `context.signal.aborted` during long loops to stop work immediately:

```typescript
for (const item of items) {
  if (context.signal?.aborted) {
    throw new Error("Action cancelled by caller");
  }
  await processItem(item);
}
```

---

## 🚨 Typed Errors & Envelopes

Embody includes standard HTTP-mapped error classes in `@embody/core`. When an action throws an Embody error, the framework automatically formats it into a standard error envelope:

```typescript
import {
  BadRequestError,      // 400
  UnauthenticatedError, // 401
  ForbiddenError,       // 403
  NotFoundError,        // 404
  ConflictError,        // 409
  HookVetoError,        // 422 (Mechanical policy veto)
  RateLimitedError,     // 429
  InternalError,        // 500
} from "@embody/core";

// Example usage:
if (!user) throw new NotFoundError(`User ${userId} not found`);
if (amount > balance) throw new ConflictError("Insufficient funds for transfer");
```

---

## 🏃 Complete Example: Batch Processing Action

Here is a complete, realistic example of a long-running batch action:

```typescript
export const bulkEnrichAction = define.action({
  description: "Batch enrich company domain names with firmographic data",
  input: z.object({
    domains: z.array(z.string().min(3)).max(100),
  }),
  output: z.object({
    totalProcessed: z.number(),
    results: z.array(z.object({ domain: z.string(), employees: z.number().optional() })),
  }),
  handler: async ({ domains }, context) => {
    const results: Array<{ domain: string; employees?: number }> = [];

    for (let i = 0; i < domains.length; i++) {
      // 1. Cooperative cancellation check
      if (context.signal?.aborted) {
        throw new Error("Batch enrichment aborted by client");
      }

      const domain = domains[i]!;
      
      // 2. Report progress
      const percent = Math.round(((i + 1) / domains.length) * 100);
      context.progress({
        percent,
        message: `Enriched ${i + 1} of ${domains.length}: ${domain}`,
      });

      // 3. Do the work
      results.push({ domain, employees: 42 });
    }

    return {
      totalProcessed: results.length,
      results,
    };
  },
});
```

Next: **[Mechanical Safety Guardrails →](./04-mechanical-safety-guardrails.md)**
