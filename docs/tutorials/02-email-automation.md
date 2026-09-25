# Tutorial: Autonomous Email Automation with Approval Gates

> Build an email automation application featuring dependency injection, supervisor approval gates, live progress streaming, and transactional event handling.

---

## 🎯 What We Are Building

In this tutorial, you will build an autonomous email campaign workflow engine that demonstrates:
1. **Pluggable Mailer Service**: A decoupled `Mailer` service interface with a testable development implementation.
2. **Supervisor Approval Gate**: A mechanical safety rule preventing autonomous agents from dispatching email batches exceeding 500 recipients unless authorized with the `marketing_lead` role.
3. **Live Progress Streaming**: Real-time progress updates (`context.progress(...)`) emitted during batch delivery.
4. **Cooperative Cancellation**: Checking `context.signal.aborted` to cleanly stop delivery if the client aborts.
5. **Cross-Domain Event Subscription**: Reacting to domain events emitted by another application or plugin.

---

## 📁 Step 1: Declare the Mailer Service

Create `src/email/mailer.ts`:

```typescript
// src/email/mailer.ts
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Deterministic in-memory mailer for development and testing. */
export class RecordingMailer implements Mailer {
  readonly sentMessages: MailMessage[] = [];
  private readonly sentKeys = new Set<string>();

  async send(message: MailMessage): Promise<void> {
    if (this.sentKeys.has(message.idempotencyKey)) {
      return; // Deduplicate repeated idempotency keys
    }
    this.sentKeys.add(message.idempotencyKey);
    this.sentMessages.push(message);
  }
}
```

---

## ⚙️ Step 2: Build the Email Plugin

Create `src/email/plugin.ts`:

```typescript
// src/email/plugin.ts
import { definePlugin, HookVetoError, z } from "@embody/core";
import { type Mailer, RecordingMailer } from "./mailer.js";

export const SendBatchInputSchema = z.object({
  campaignId: z.string().min(1),
  recipients: z.array(z.string().email()).min(1),
  subject: z.string().min(1),
  template: z.string().min(1),
});

export const SendBatchResultSchema = z.object({
  campaignId: z.string(),
  totalSent: z.number().int().nonnegative(),
});

export function createEmailPlugin(mailer: Mailer = new RecordingMailer()) {
  return definePlugin(
    {
      id: "email",
      version: "1.0.0",
      entities: {},
      services: () => ({
        mailer,
      }),
      events: {
        // Automatically dispatch notification when an engineering card needs review
        "kanban.card.ready_for_review": async (event, context) => {
          const payload = event.payload as { cardId: string; title: string };
          const activeMailer = context.services.get<Mailer>("email.mailer");

          await activeMailer.send({
            to: "lead@company.com",
            subject: `Review Required: ${payload.title}`,
            body: `Card ${payload.cardId} has entered review.`,
            idempotencyKey: event.id,
          });
        },
      },
    },
    (define) => ({
      actions: {
        sendBatch: define.action({
          description: "Send an email batch with live progress reporting",
          input: SendBatchInputSchema,
          output: SendBatchResultSchema,
          handler: async (input, context) => {
            // 1. Mechanical Safety Gate: Require marketing_lead role for large batches
            if (
              input.recipients.length > 500 &&
              !context.principal.roles.includes("marketing_lead")
            ) {
              throw new HookVetoError(
                "Batches exceeding 500 recipients require the 'marketing_lead' role."
              );
            }

            const activeMailer = context.services.get<Mailer>("email.mailer");

            for (let i = 0; i < input.recipients.length; i++) {
              // 2. Cooperative cancellation check
              if (context.signal?.aborted) {
                throw new Error("Email batch was cancelled by caller");
              }

              const recipient = input.recipients[i]!;
              await activeMailer.send({
                to: recipient,
                subject: input.subject,
                body: input.template,
                idempotencyKey: `${input.campaignId}:${i}`,
              });

              // 3. Emit progress updates periodically
              const current = i + 1;
              if (current % 10 === 0 || current === input.recipients.length) {
                context.progress({
                  percent: Math.round((current / input.recipients.length) * 100),
                  message: `Sent ${current} of ${input.recipients.length} emails`,
                });
              }
            }

            return {
              campaignId: input.campaignId,
              totalSent: input.recipients.length,
            };
          },
        }),
      },
    })
  );
}
```

---

## 🧪 Step 3: Write the Test Suite

Create `test/email.test.ts`:

```typescript
// test/email.test.ts
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@embody/testing";
import { createEmailPlugin } from "../src/email/plugin.js";
import { RecordingMailer } from "../src/email/mailer.js";

describe("Email Automation System", () => {
  it("vetoes batches over 500 recipients without marketing_lead role", async () => {
    const harness = await createTestHarness({
      plugins: [createEmailPlugin()],
      actor: { actorType: "agent", actorId: "newsletter-bot", roles: ["agent"], scopes: ["email:send"] },
    });

    try {
      const largeRecipientList = Array.from({ length: 501 }, (_, i) => `user${i}@test.com`);

      await expect(
        harness.call("email.sendBatch", {
          campaignId: "black-friday",
          recipients: largeRecipientList,
          subject: "Sale Now On!",
          template: "Big discounts today.",
        })
      ).rejects.toThrow("Batches exceeding 500 recipients require the 'marketing_lead' role.");
    } finally {
      await harness.close();
    }
  });

  it("streams live progress and delivers messages for authorized users", async () => {
    const mockMailer = new RecordingMailer();
    const harness = await createTestHarness({
      plugins: [createEmailPlugin(mockMailer)],
      actor: {
        actorType: "human",
        actorId: "sarah",
        roles: ["marketing_lead"],
        scopes: ["email:sendBatch"],
      },
    });

    try {
      const recipients = ["alice@test.com", "bob@test.com", "charlie@test.com"];

      const result = await harness.call("email.sendBatch", {
        campaignId: "spring-launch",
        recipients,
        subject: "Welcome to Spring",
        template: "Enjoy the season!",
      });

      expect(result.totalSent).toBe(3);
      expect(mockMailer.sentMessages).toHaveLength(3);

      // Verify captured progress
      const finalProgress = harness.progress().at(-1);
      expect(finalProgress?.update.percent).toBe(100);
    } finally {
      await harness.close();
    }
  });
});
```

Run your tests:

```bash
pnpm test
```

---

## 💡 Key Takeaways

1. **Decoupled Architecture**: By injecting `Mailer` via `services`, you can run tests with in-memory recording adapters and swap in Amazon SES, SendGrid, or Postmark in production without changing application code.
2. **Deterministic Role Checks**: The safety gate checks `context.principal.roles` mechanically, protecting against runaway agent loops.
3. **Responsive Operations**: Long-running loops emit streaming SSE updates and listen to `context.signal`, keeping operators and AI models fully informed.

Next: **[Production Deployment & Operations →](../production/01-deployment.md)**
