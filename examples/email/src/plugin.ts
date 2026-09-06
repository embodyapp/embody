import { DependencyError, definePlugin, HookVetoError, z } from "@embody/core";

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Deterministic development/test adapter. Repeated idempotency keys are logical no-ops. */
export class RecordingMailer implements Mailer {
  readonly messages: MailMessage[] = [];
  private readonly sent = new Set<string>();

  public send(message: MailMessage): Promise<void> {
    if (!this.sent.has(message.idempotencyKey)) {
      this.sent.add(message.idempotencyKey);
      this.messages.push(message);
    }
    return Promise.resolve();
  }
}

const unavailableMailer: Mailer = {
  send: () => Promise.reject(new DependencyError("No production mailer adapter is configured")),
};

export const SendBatchInputSchema = z.object({
  campaignId: z.string().min(1),
  recipients: z.array(z.email()).min(1),
  subject: z.string().min(1),
  template: z.string().min(1),
});
export const SendBatchResultSchema = z.object({
  campaignId: z.string(),
  totalSent: z.number().int().nonnegative(),
});

const ReviewEventSchema = z.object({
  cardId: z.string().min(1),
  title: z.string().min(1),
  assigneeId: z.string().optional(),
});

export function createEmailPlugin(mailer: Mailer = unavailableMailer) {
  return definePlugin(
    {
      id: "email",
      version: "1.0.0",
      entities: {},
      services: () => ({ mailer }),
      events: {
        "kanban.card.ready_for_review": async (event, context) => {
          const payload = ReviewEventSchema.parse(event.payload);
          await context.services.get<Mailer>("email.mailer").send({
            to: "team-lead@company.com",
            subject: `Review Required: ${payload.title}`,
            body: `Card ${payload.cardId} has been moved to in_review and requires approval.`,
            idempotencyKey: event.id,
          });
        },
      },
    },
    (define) => ({
      actions: {
        sendBatch: define.action({
          description: "Send an email batch with ordered live progress",
          input: SendBatchInputSchema,
          output: SendBatchResultSchema,
          handler: async (input, context) => {
            if (
              input.recipients.length > 500 &&
              !context.principal.roles.includes("marketing_lead")
            )
              throw new HookVetoError(
                "Batches exceeding 500 recipients require the marketing_lead role",
              );

            for (let index = 0; index < input.recipients.length; index++) {
              if (context.signal?.aborted) throw new Error("Email batch was cancelled");
              const sent = index + 1;
              await context.services.get<Mailer>("email.mailer").send({
                to: input.recipients[index]!,
                subject: input.subject,
                body: input.template,
                idempotencyKey: `${input.campaignId}:${index}`,
              });
              if (sent % 10 === 0 || sent === input.recipients.length)
                context.progress({
                  percent: Math.round((sent / input.recipients.length) * 100),
                  message: `Sent ${sent} of ${input.recipients.length} emails`,
                });
            }
            return { campaignId: input.campaignId, totalSent: input.recipients.length };
          },
        }),
      },
    }),
  );
}

/** Default host plugin intentionally has no working production delivery adapter. */
export const emailPlugin = createEmailPlugin();
