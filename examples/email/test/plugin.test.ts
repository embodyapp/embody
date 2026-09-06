import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness } from "@embody/testing";
import { afterEach, describe, expect, it } from "vitest";
import { kanbanPlugin } from "@embody/example-kanban/plugin";
import {
  createEmailPlugin,
  JsonFileMailer,
  RecordingMailer,
  type MailMessage,
  type Mailer,
} from "../src/plugin.js";

const harnesses: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

async function harness(mailer: Mailer, roles: readonly string[] = []) {
  const value = await createTestHarness({
    plugins: [kanbanPlugin, createEmailPlugin(mailer)] as const,
    actor: { actorId: "agent", actorType: "agent", roles, scopes: ["kanban:*", "email:*"] },
    eventId: (() => {
      let id = 0;
      return () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
    })(),
  });
  harnesses.push(value);
  return value;
}

describe("Email reference plugin", () => {
  it("durably deduplicates file-adapter sends across adapter restarts", async () => {
    const filename = join(tmpdir(), `embody-mail-${crypto.randomUUID()}.json`);
    const message = {
      to: "lead@example.com",
      subject: "Review",
      body: "Ready",
      idempotencyKey: "event-1",
    };
    try {
      await new JsonFileMailer(filename).send(message);
      await new JsonFileMailer(filename).send(message);
      expect(JSON.parse(await readFile(filename, "utf8"))).toEqual([message]);
    } finally {
      await rm(filename, { force: true });
    }
  });

  it("sends a validated batch and reports each tenth and final recipient", async () => {
    const mailer = new RecordingMailer();
    const h = await harness(mailer);
    const recipients = Array.from({ length: 23 }, (_, index) => `person-${index}@example.com`);

    await expect(
      h.client.email.sendBatch({
        campaignId: "launch",
        recipients,
        subject: "Hello",
        template: "Welcome",
      }),
    ).resolves.toEqual({ campaignId: "launch", totalSent: 23 });
    expect(mailer.messages.map(({ to }) => to)).toEqual(recipients);
    expect(h.progress().map(({ update }) => update)).toEqual([
      { percent: 43, message: "Sent 10 of 23 emails" },
      { percent: 87, message: "Sent 20 of 23 emails" },
      { percent: 100, message: "Sent 23 of 23 emails" },
    ]);
  });

  it("validates every recipient and authorizes large batches before sending", async () => {
    const mailer = new RecordingMailer();
    const h = await harness(mailer);
    await expect(
      h.call("email.sendBatch", {
        campaignId: "invalid",
        recipients: ["valid@example.com", "invalid"],
        subject: "Hello",
        template: "Body",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mailer.messages).toEqual([]);

    await expect(
      h.call("email.sendBatch", {
        campaignId: "large",
        recipients: Array.from({ length: 501 }, (_, index) => `person-${index}@example.com`),
        subject: "Hello",
        template: "Body",
      }),
    ).rejects.toMatchObject({ code: "HOOK_VETO" });
    expect(mailer.messages).toEqual([]);
  });

  it("stops sending cooperatively when cancelled", async () => {
    const controller = new AbortController();
    const messages: MailMessage[] = [];
    const mailer: Mailer = {
      send: (message) => {
        messages.push(message);
        controller.abort();
        return Promise.resolve();
      },
    };
    const h = await harness(mailer);
    await expect(
      h.call(
        "email.sendBatch",
        {
          campaignId: "cancelled",
          recipients: ["one@example.com", "two@example.com"],
          subject: "Hello",
          template: "Body",
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(messages).toHaveLength(1);
    expect(h.audit().at(-1)?.outcome).toBe("cancelled");
  });

  it("turns a Kanban review event into one idempotent notification", async () => {
    const mailer = new RecordingMailer();
    const h = await harness(mailer);
    const card = (await h.call("kanban.card.create", { data: { title: "Review me" } })) as {
      id: string;
    };
    await h.call("kanban.card.update", { id: card.id, data: { status: "in_review" } });
    await h.tickOutbox();
    await h.tickOutbox();

    expect(mailer.messages).toEqual([
      expect.objectContaining({
        to: "team-lead@company.com",
        subject: "Review Required: Review me",
        body: `Card ${card.id} has been moved to in_review and requires approval.`,
        idempotencyKey: "00000000-0000-4000-8000-000000000002",
      }),
    ]);
    expect(h.kernel.manifest.eventSubscriptions).toContain("kanban.card.ready_for_review");
    expect(h.kernel.manifest.actions["email.sendBatch"]?.generated).toBe(false);
  });

  it("fails explicitly when no delivery adapter is configured", async () => {
    const value = await createTestHarness({
      plugins: [createEmailPlugin()] as const,
      actor: {
        actorId: "agent",
        actorType: "agent",
        roles: [],
        scopes: ["email:*"],
      },
    });
    harnesses.push(value);
    await expect(
      value.client.email.sendBatch({
        campaignId: "unconfigured",
        recipients: ["person@example.com"],
        subject: "Hello",
        template: "Body",
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_ERROR" });
  });

  it("dead-letters the event without losing metadata when the mailer is unavailable", async () => {
    const mailer: Mailer = { send: () => Promise.reject(new Error("mailer offline")) };
    const h = await harness(mailer);
    const card = (await h.call("kanban.card.create", { data: { title: "Review me" } })) as {
      id: string;
    };
    await h.call("kanban.card.update", { id: card.id, data: { status: "in_review" } });
    await h.tickOutbox();
    const event = (await h.events("kanban.card.ready_for_review"))[0];
    expect(event).toMatchObject({
      id: "00000000-0000-4000-8000-000000000002",
      eventName: "kanban.card.ready_for_review",
      status: "dead_letter",
      attempts: 1,
      payload: { cardId: card.id, title: "Review me" },
    });
  });
});
