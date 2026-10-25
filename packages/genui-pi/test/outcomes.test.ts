import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createPiOutcomeReporter, type PiOutcomeReporter } from "../src/index.js";
import { withPi } from "./pi-fixture.js";

const configuration = { callableTargets: ["kanban.card.update"], readTarget: "kanban.board" };

it("records a redacted human-visible outcome in Pi's active model context without starting a turn", async () => {
  await withPi(
    (pi) => {
      pi.registerCommand("outcome", {
        description: "Visibility fixture",
        handler: (_args, ctx) => {
          const reporter = createPiOutcomeReporter(pi, ctx, configuration);
          expect(
            reporter.report(
              {
                target: "kanban.card.update",
                status: "rejected",
                code: "HOOK_VETO",
                draft: { prUrl: "https://secret.example/pr/1" },
              },
              { reconciled: false },
            ),
          ).toBe("recorded");
          reporter.dispose();
          return Promise.resolve();
        },
      });
    },
    async (session) => {
      await session.prompt("/outcome");
      const context = session.sessionManager.buildSessionContext().messages;
      expect(context).toMatchObject([
        {
          role: "custom",
          customType: "embody.genui.outcome",
          display: true,
          content:
            "Embody UI: kanban.card.update rejected (HOOK_VETO). Authoritative state not reconciled. Read kanban.board before relying on current state.",
        },
      ]);
      expect(convertToLlm(context)).toMatchObject([{ role: "user" }]);
      expect(JSON.stringify(convertToLlm(context))).toContain("HOOK_VETO");
      expect(JSON.stringify(session.sessionManager.getEntries())).not.toContain("secret.example");
      expect(context.some((message) => message.role === "assistant")).toBe(false);
    },
  );
});

it.each(["tree", "new session", "shutdown", "reload"])(
  "does not publish a late outcome after Pi changes %s",
  async (change) => {
    let reporter: PiOutcomeReporter | undefined;
    await withPi(
      (pi) => {
        pi.registerCommand("open", {
          description: "Lifecycle fixture",
          handler: (_args, ctx) => {
            reporter = createPiOutcomeReporter(pi, ctx, configuration);
            return Promise.resolve();
          },
        });
      },
      async (session, runtime) => {
        await session.prompt("/open");
        reporter!.report(
          { target: "kanban.card.update", status: "confirmed" },
          { reconciled: true },
        );
        const anchor = session.sessionManager.getLeafId()!;
        reporter!.report(
          { target: "kanban.card.update", status: "rejected", code: "HOOK_VETO" },
          { reconciled: false },
        );
        if (change === "tree") await session.navigateTree(anchor, { summarize: false });
        else if (change === "new session") await runtime.newSession();
        else if (change === "reload") await session.reload();
        else await runtime.dispose();
        const before = runtime.session.sessionManager.getEntries();
        expect(
          reporter!.report(
            { target: "kanban.card.update", status: "uncertain" },
            { reconciled: false },
          ),
        ).toBe("disposed");
        expect(runtime.session.sessionManager.getEntries()).toEqual(before);
        reporter!.dispose();
      },
    );
  },
);
