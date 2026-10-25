import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPiOutcomeReporter, type PiOutcomeReporter } from "@embody/genui-pi";
import { expect } from "vitest";
/** Real public Pi host context for Apps outcome delivery. Model-provider boundary is offline only. */
export async function createPiVisibilityHost() {
  const directory = await mkdtemp(join(tmpdir(), "apps-pi-context-"));
  const settings = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const requests: string[] = [];
  let reporter: PiOutcomeReporter | undefined;
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.registerCommand("open-context", {
          description: "Reference-host context binding",
          handler: (_args, ctx) => {
            reporter = createPiOutcomeReporter(pi, ctx, {
              callableTargets: ["kanban.card.update"],
              readTarget: "kanban.board",
            });
            return Promise.resolve();
          },
        });
        pi.registerProvider("apps-offline", {
          api: "apps-offline",
          baseUrl: "http://127.0.0.1:1",
          apiKey: "offline",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              input: ["text"],
              reasoning: false,
              contextWindow: 8192,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
          streamSimple: (_model, context) => {
            requests.push(JSON.stringify(context.messages));
            throw new Error("Offline fixture terminates");
          },
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(directory),
    noTools: "all",
  });
  await session.bindExtensions({});
  await session.prompt("/open-context");
  const model = session.modelRuntime.getModel("apps-offline", "fixture");
  if (!model) throw new Error("Offline model unavailable");
  await session.setModel(model);
  return {
    publish(value: unknown) {
      expect(requests).toHaveLength(0);
      expect(reporter?.report(value, { reconciled: false })).toBe("recorded");
    },
    async verify() {
      expect(requests).toHaveLength(0);
      await session.prompt("Read current state before relying on consequential changes");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("HOOK_VETO");
      expect(requests[0]).toContain("confirmed");
      expect(requests[0]).toContain("Read kanban.board before relying on current state");
      expect(requests[0]).not.toContain("private.example");
    },
    async close() {
      reporter?.dispose();
      session.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
