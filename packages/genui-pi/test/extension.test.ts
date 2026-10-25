import { expect, it } from "vitest";
import { createPiGenUiExtension } from "../src/extension.js";
import { withPi } from "./pi-fixture.js";
it.each(["print", "json", "rpc"] as const)(
  "loads a public Pi factory with redacted %s fallback and no input prompt",
  async (mode) => {
    let closed = 0;
    let requested = "";
    const factory = createPiGenUiExtension({
      providers: [
        {
          appId: "cards",
          target: "cards.board",
          viewId: "board",
          readTargets: ["cards.board"],
          present: () => ({
            version: 1,
            root: {
              version: 1,
              type: "section",
              title: "Board",
              children: [{ version: 1, type: "text", text: "secret-pr", sensitive: true }],
            },
          }),
          bindings: () => ({}),
        },
      ],
      connect: () =>
        Promise.resolve({
          discover: (target) => {
            requested = target;
            return Promise.resolve({
              generation: "1",
              view: {
                protocolVersion: 1,
                id: "board",
                kind: "standard",
                version: "1.0.0",
                resourceUri: "ui://cards/board@1.0.0",
                propsSchema: {},
                callableTargets: ["cards.board"],
                fallback: "text",
                integrity: "sha256:" + "a".repeat(64),
              },
              dispatch: () => Promise.resolve({}),
            });
          },
          close: () => {
            closed++;
            return Promise.resolve();
          },
        }),
    });
    await withPi(factory, async (session) => {
      await session.bindExtensions({ mode });
      await session.prompt("/embody-view cards cards.board");
      expect(requested).toBe("cards.board");
      expect(JSON.stringify(session.messages)).toContain("Board");
      expect(JSON.stringify(session.messages)).not.toContain("secret-pr");
      expect(session.isStreaming).toBe(false);
    });
    expect(closed).toBe(1);
  },
);
