import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createGenUiSession } from "@embody/genui/session";
import { createPiOutcomeReporter } from "@embody/genui-pi";
import { createTestHarness } from "@embody/testing";
import { z } from "@embody/core";
import { expect, it } from "vitest";
import { kanbanPlugin, KanbanBoardSchema, KanbanBoardCardSchema } from "../src/plugin.js";

it("makes real agent-principal veto/correction outcomes visible to Pi without publishing local drafts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanban-pi-"));
  const harness = await createTestHarness({
    plugins: [kanbanPlugin],
    principal: {
      orgId: "pi-journey",
      actorId: "initiating-agent",
      actorType: "agent",
      roles: [],
      scopes: ["kanban:*"],
    },
  });
  const manager = SessionManager.inMemory(directory);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const card = KanbanBoardCardSchema.parse(
    await harness.call("kanban.card.create", { data: { title: "Add login" } }),
  );
  const target = "kanban.card.update";
  const readTarget = "kanban.board";
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        pi.registerCommand("journey", {
          description: "Real-kernel visibility fixture",
          handler: async (_args, ctx) => {
            const reporter = createPiOutcomeReporter(pi, ctx, {
              callableTargets: [target, readTarget],
              readTarget,
            });
            const controller = createGenUiSession({
              generation: "fixture-1",
              initialSnapshot: KanbanBoardSchema.parse(await harness.call(readTarget, {})),
              snapshotSchema: KanbanBoardSchema,
              readTarget,
              mutations: {
                [target]: z.object({
                  id: z.uuid(),
                  data: z.object({ status: z.literal("done"), prUrl: z.url().optional() }),
                }),
              },
              items: (snapshot) => snapshot.cards,
              dispatch: (name, input, signal) => harness.call(name, input, { signal }),
            });
            try {
              const before = manager.getEntries();
              await controller.openItem(card.id);
              controller.edit({ id: card.id, data: { status: "done" } });
              expect(manager.getEntries()).toEqual(before);
              const rejected = controller.submit(target);
              expect(controller.state.phase).toBe("pending");
              await rejected;
              expect(controller.state.draft).toEqual({ id: card.id, data: { status: "done" } });
              expect(reporter.report(controller.state.outcome, { reconciled: false })).toBe(
                "recorded",
              );
              const afterVeto = manager.getEntries();
              controller.edit({
                id: card.id,
                data: { status: "done", prUrl: "https://private.example/pr/1" },
              });
              expect(manager.getEntries()).toEqual(afterVeto);
              await controller.submit(target);
              expect(controller.state.snapshot.cards[0]?.data.status).toBe("done");
              expect(controller.state.draft).toEqual({});
              expect(
                reporter.report(controller.state.outcome, { reconciled: !controller.state.stale }),
              ).toBe("recorded");
            } finally {
              controller.dispose();
              reporter.dispose();
            }
          },
        });
      },
    ],
  });
  try {
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
      noTools: "all",
    });
    try {
      await session.bindExtensions({});
      await session.prompt("/journey");
      expect(manager.buildSessionContext().messages).toMatchObject([
        {
          role: "custom",
          display: true,
          content:
            "Embody UI: kanban.card.update rejected (HOOK_VETO). Authoritative state not reconciled. Read kanban.board before relying on current state.",
        },
        {
          role: "custom",
          display: true,
          content:
            "Embody UI: kanban.card.update confirmed. Authoritative state refreshed. Read kanban.board before relying on current state.",
        },
      ]);
      expect(convertToLlm(manager.buildSessionContext().messages)).toMatchObject([
        { role: "user" },
        { role: "user" },
      ]);
      expect(JSON.stringify(manager.getEntries())).not.toContain("private.example");
      expect(
        KanbanBoardSchema.parse(await harness.call(readTarget, {})).cards[0]?.data.status,
      ).toBe("done");
    } finally {
      session.dispose();
    }
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});
