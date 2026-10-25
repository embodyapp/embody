import { expect, it } from "vitest";
import { createPiOutcomeReporter, type PiOutcomeReporter } from "../src/index.js";
import { withPi } from "./pi-fixture.js";

it("does not enqueue an outcome into a busy Pi run or trigger a continuation", async () => {
  let reporter: PiOutcomeReporter | undefined;
  const results: string[] = [];
  const requests: string[] = [];
  await withPi(
    (pi) => {
      pi.registerCommand("open", {
        description: "Busy fixture",
        handler: (_args, ctx) => {
          reporter = createPiOutcomeReporter(pi, ctx, {
            callableTargets: ["kanban.card.update"],
            readTarget: "kanban.board",
          });
          return Promise.resolve();
        },
      });
      // The model provider is the external system boundary. This offline fixture
      // exercises real Pi run ordering, without credentials or network calls.
      pi.registerProvider("genui-offline", {
        api: "genui-offline",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "offline-fixture",
        models: [
          {
            id: "fixture",
            name: "Offline fixture",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8_192,
            maxTokens: 1_024,
          },
        ],
        streamSimple: (_model, context) => {
          requests.push(JSON.stringify(context.messages));
          results.push(
            reporter!.report(
              { target: "kanban.card.update", status: "confirmed" },
              { reconciled: true },
            ),
          );
          throw new Error("Offline fixture terminates the model request");
        },
      });
    },
    async (session) => {
      await session.prompt("/open");
      expect(session.model?.provider).toBe("genui-offline");
      await session.prompt("Exercise the offline provider");
      expect(results).toEqual(["busy"]);
      expect(
        session.sessionManager
          .buildSessionContext()
          .messages.filter((message) => message.role === "custom"),
      ).toEqual([]);
      expect(
        reporter!.report(
          { target: "kanban.card.update", status: "confirmed" },
          { reconciled: true },
        ),
      ).toBe("recorded");
      expect(
        session.sessionManager
          .buildSessionContext()
          .messages.filter((message) => message.role === "custom"),
      ).toHaveLength(1);
      await session.prompt("Observe the published outcome");
      expect(results).toEqual(["busy", "busy"]);
      expect(requests[0]).not.toContain("Embody UI:");
      expect(requests[1]).toContain(
        "Embody UI: kanban.card.update confirmed. Authoritative state refreshed.",
      );
      reporter!.dispose();
    },
    { provider: "genui-offline", id: "fixture" },
  );
});
