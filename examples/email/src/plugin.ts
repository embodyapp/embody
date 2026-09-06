import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

/** Explicit durable adapter for local/distributed tests; not a production mail provider. */
export class JsonFileMailer implements Mailer {
  private pending = Promise.resolve();
  public constructor(
    private readonly filename: string,
    private readonly crashAfterFirstWrite = false,
  ) {}

  public send(message: MailMessage): Promise<void> {
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.filename), { recursive: true });
      let messages: MailMessage[] = [];
      try {
        const parsed: unknown = JSON.parse(await readFile(this.filename, "utf8"));
        if (!Array.isArray(parsed)) throw new Error("Mailer record file must contain an array");
        messages = parsed as MailMessage[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (messages.some((item) => item.idempotencyKey === message.idempotencyKey)) return;
      const temporary = `${this.filename}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify([...messages, message]), { mode: 0o600 });
      await rename(temporary, this.filename);
      if (this.crashAfterFirstWrite) {
        const marker = `${this.filename}.crash-injected`;
        try {
          await readFile(marker);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await writeFile(marker, "injected", { mode: 0o600 });
          process.exit(86);
        }
      }
    });
    this.pending = operation.catch(() => undefined);
    return operation;
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
