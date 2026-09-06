# Mechanical Safety Guardrails & Policy Shield

> Learn how to build unbreakable safety boundaries for autonomous AI agents using pre-commit veto hooks and capability attenuation.

---

## 🛑 Why Prompt-Based Guardrails Fail

The standard approach to AI safety is adding instructions to the model's system prompt:

> ❌ *"You are a helpful assistant. You must never execute a wire transfer over $500. You must never mark a ticket done without verifying the PR."*

In practice, prompt-based guardrails fail constantly due to:
1. **Prompt Injections**: Malicious user inputs or scraped content override the system prompt.
2. **Context Window Drift**: As conversations grow long, early safety instructions are deprioritized by the LLM's attention mechanism.
3. **Model Hallucinations & Confusion**: Even state-of-the-art models misunderstand constraints when dealing with complex multi-tool execution chains.

**Embody solves this mechanically**: Safety is enforced in the deterministic V8 runtime *before* any transaction commits to the database.

---

## 🛡️ The Mechanical Policy Shield

Embody provides **Vetoable Pre-Commit Hooks**. These hooks execute inside the database transaction:

```
[Agent Calls Action / Update]
             │
             ▼
     [BEGIN TRANSACTION]
             │
             ▼
     [Pre-Commit Hook Runs]
             ├── Pass ──────────► [Commit Mutation to Database]
             └── Fail (Throw) ──► [ABORT & ROLLBACK TRANSACTION]
                                         │
                                         ▼
                               [Return HookVetoError to Agent]
```

If a hook throws a `HookVetoError`, the transaction is instantly rolled back. **No invalid or unapproved state ever touches the database.**

---

## 🪝 Hook Types

Inside `definePlugin`, the extension builder provides four pre-commit hook types:

### 1. `beforeCreate`
Intercepts new entity creation before insertion:

```typescript
define.beforeCreate("invoice", async ({ data }, context) => {
  if (data.amountCents <= 0) {
    throw new HookVetoError("Invoice amount must be strictly greater than 0");
  }
});
```

### 2. `beforeUpdate`
Intercepts entity updates, providing access to both the `current` state in the database and the requested `patch`:

```typescript
define.beforeUpdate("card", async ({ current, patch }, context) => {
  // Check if status is transitioning to "done"
  if (
    context.principal.actorType === "agent" &&
    patch.status === "done" &&
    !current.data.prUrl &&
    !patch.prUrl
  ) {
    throw new HookVetoError("Agents cannot complete cards without a linked PR URL");
  }
});
```

### 3. `beforeDelete`
Intercepts entity deletions:

```typescript
define.beforeDelete("project", async ({ current }, context) => {
  if (current.data.isProtected) {
    throw new HookVetoError("Protected projects cannot be deleted");
  }
});
```

### 4. `beforeAction`
Intercepts custom action invocations before the action handler begins execution:

```typescript
define.beforeAction("payout", async (input, context) => {
  if (context.principal.actorType === "agent" && input.amount > 500) {
    throw new HookVetoError("Payouts exceeding $500 require human supervisor authorization");
  }
});
```

---

## 💡 Practical Safety Patterns

### Pattern 1: Actor-Type Attenuation
Humans and agents should not have the same power. Inspect `context.principal.actorType` to apply stricter rules to autonomous agents while giving human team members administrative latitude:

```typescript
define.beforeDelete("customer", ({ current }, context) => {
  if (context.principal.actorType === "agent") {
    throw new HookVetoError("Autonomous agents are prohibited from deleting customer records");
  }
});
```

### Pattern 2: State Machine Invariants
Enforce valid lifecycle transitions (e.g., `todo` ➔ `in_progress` ➔ `in_review` ➔ `done`):

```typescript
const VALID_TRANSITIONS: Record<string, string[]> = {
  todo: ["in_progress"],
  in_progress: ["in_review", "todo"],
  in_review: ["done", "in_progress"],
  done: ["in_progress"],
};

define.beforeUpdate("task", ({ current, patch }) => {
  if (patch.status && patch.status !== current.data.status) {
    const allowed = VALID_TRANSITIONS[current.data.status] ?? [];
    if (!allowed.includes(patch.status)) {
      throw new HookVetoError(
        `Invalid status transition from '${current.data.status}' to '${patch.status}'`
      );
    }
  }
});
```

### Pattern 3: Spend Limits & Approval Checkpoints
Prevent autonomous financial drain by gating high-value actions behind supervisor approval tokens:

```typescript
define.beforeAction("executeTrade", async (input, context) => {
  const MAX_AGENT_TRADE_USD = 1000;

  if (context.principal.actorType === "agent" && input.amountUsd > MAX_AGENT_TRADE_USD) {
    if (!input.supervisorApprovalId) {
      throw new HookVetoError(
        `Trades over $${MAX_AGENT_TRADE_USD} require a valid supervisorApprovalId`
      );
    }

    // Verify approval record exists
    const approval = await context.entities.approval.get(input.supervisorApprovalId);
    if (!approval || approval.data.status !== "approved") {
      throw new HookVetoError("Supervisor approval record is missing or not approved");
    }
  }
});
```

---

## 🤖 How AI Agents React to Vetoes

When Embody throws a `HookVetoError`, the error message is returned cleanly to the AI agent via the MCP protocol.

Because the error message explains *why* the mutation failed (e.g. `"Agents cannot complete cards without a linked PR URL"`), intelligent agents can self-correct!

```
Agent: Calls ops.tasks.task.update({ id: "123", status: "done" })
Embody: ❌ HookVetoError: Agents cannot complete cards without a linked PR URL.
Agent Thinks: "My update was rejected because I didn't attach a PR URL. Let me inspect git, create the PR, and try again."
Agent: Calls ops.tasks.task.update({ id: "123", status: "done", prUrl: "https://github.com/..." })
Embody: ✅ 200 OK
```

Next: **[Transactional Outbox & Events →](./05-events-and-outbox.md)**
