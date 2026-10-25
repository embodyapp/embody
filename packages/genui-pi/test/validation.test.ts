import { expect, it } from "vitest";
import { createPiOutcomeReporter } from "../src/index.js";
import { withPi } from "./pi-fixture.js";

it("rejects undeclared/malformed outcomes and never copies raw error codes or sensitive details", async () => {
  await withPi(
    (pi) => {
      pi.registerCommand("validate", {
        description: "Redaction fixture",
        handler: (_args, ctx) => {
          const reporter = createPiOutcomeReporter(pi, ctx, {
            callableTargets: ["kanban.card.update"],
            readTarget: "kanban.board",
          });
          expect(
            reporter.report(
              { target: "other.card.update", status: "confirmed" },
              { reconciled: true },
            ),
          ).toBe("invalid");
          expect(
            reporter.report(
              { target: "kanban.card.update", status: "unexpected" },
              { reconciled: true },
            ),
          ).toBe("invalid");
          expect(
            reporter.report(
              { target: "kanban.card.update", status: "rejected", code: "x".repeat(129) },
              { reconciled: false },
            ),
          ).toBe("invalid");
          expect(
            reporter.report(
              {
                target: "kanban.card.update",
                status: "uncertain",
                code: "secret-token",
                cause: "private failure",
                snapshot: { title: "private task" },
              },
              { reconciled: true },
            ),
          ).toBe("recorded");
          reporter.dispose();
          return Promise.resolve();
        },
      });
    },
    async (session) => {
      await session.prompt("/validate");
      const messages = session.sessionManager.buildSessionContext().messages;
      expect(messages).toMatchObject([
        {
          role: "custom",
          content:
            "Embody UI: kanban.card.update uncertain (ACTION_OUTCOME_UNAVAILABLE). Authoritative state refreshed. Read kanban.board before relying on current state.",
        },
      ]);
      expect(JSON.stringify(session.sessionManager.getEntries())).not.toMatch(
        /secret-token|private failure|private task/,
      );
    },
  );
});
