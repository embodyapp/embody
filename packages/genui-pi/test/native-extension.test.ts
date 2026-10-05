import { expect, it } from "vitest";
import { TuiMainScreen, matchesKey, Key, type Terminal } from "@earendil-works/pi-tui";
import type {
  ExtensionUIContext,
  Theme,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPiGenUiExtension } from "../src/extension.js";
import type { PiGenUiComponent } from "../src/native.js";
import { withPi } from "./pi-fixture.js";

it("runs native UI through Pi's public host contract, blocks concurrent agent input and records ordered redacted outcomes", async () => {
  const change = {
    intent: "change",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string", maxLength: 100 } },
    },
  };
  const document = {
    version: 1,
    root: {
      version: 1,
      type: "form",
      id: "save",
      label: "Save",
      effect: "Update",
      children: [
        {
          version: 1,
          type: "field",
          id: "pr",
          label: "PR",
          value: "",
          sensitive: true,
          event: change,
        },
      ],
      event: {
        intent: "submit",
        target: "cards.update",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["pr"],
          properties: { pr: { type: "string", maxLength: 100 } },
        },
      },
    },
  };
  let veto = true;
  let resolveReady: (component: PiGenUiComponent) => void = () => {};
  const ready = new Promise<PiGenUiComponent>((resolve) => {
    resolveReady = resolve;
  });
  const notices: string[] = [];
  const terminal: Terminal = {
    start: () => {},
    stop: () => {},
    drainInput: () => Promise.resolve(),
    write: () => {},
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
  const tui = new TuiMainScreen(terminal);
  // External UI host adapter only: no SDK session, stores or runner internals are mocked/patched.
  const theme = { fg: (_role: string, text: string) => text } as Theme;
  const keyboard = {
    matches: (data: string, action: string) =>
      matchesKey(
        data,
        action === "tui.input.tab"
          ? Key.tab
          : action === "tui.select.cancel"
            ? Key.escape
            : action === "tui.select.up"
              ? Key.up
              : action === "tui.select.down"
                ? Key.down
                : Key.enter,
      ),
  } as KeybindingsManager;
  const custom: ExtensionUIContext["custom"] = (factory) =>
    new Promise((resolve, reject) => {
      void Promise.resolve(factory(tui, theme, keyboard, resolve))
        .then((component) => resolveReady(component as PiGenUiComponent))
        .catch(reject);
    });
  const ui = new Proxy({} as ExtensionUIContext, {
    get: (_target, name) =>
      name === "custom"
        ? custom
        : name === "notify"
          ? (message: string) => notices.push(message)
          : () => undefined,
  });
  const factory = createPiGenUiExtension({
    providers: [
      {
        appId: "cards",
        target: "cards.get",
        viewId: "detail",
        readTargets: ["cards.get"],
        present: () => document,
        bindings: () => ({ save: { kind: "object", fields: { pr: { kind: "field", id: "pr" } } } }),
      },
    ],
    connect: () =>
      Promise.resolve({
        discover: () =>
          Promise.resolve({
            generation: "1",
            view: {
              protocolVersion: 1,
              id: "detail",
              kind: "standard",
              version: "1.0.0",
              resourceUri: "ui://cards/detail@1.0.0",
              propsSchema: {},
              callableTargets: ["cards.get", "cards.update"],
              fallback: "text",
              integrity: "sha256:" + "a".repeat(64),
            },
            dispatch: (target) =>
              target === "cards.update" && veto
                ? Promise.reject(Object.assign(new Error("private cause"), { code: "HOOK_VETO" }))
                : Promise.resolve({}),
          }),
        close: () => Promise.resolve(),
      }),
  });
  const requests: string[] = [];
  await withPi(
    (pi) => {
      pi.registerProvider("native-offline", {
        api: "native-offline",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "offline",
        models: [
          {
            id: "fixture",
            name: "Fixture",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 1024,
          },
        ],
        streamSimple: (_model, context) => {
          requests.push(JSON.stringify(context.messages));
          throw new Error("Offline request terminates");
        },
      });
      return factory(pi);
    },
    async (session) => {
      await session.bindExtensions({ mode: "tui", uiContext: ui });
      const interaction = session.prompt("/embody-view cards cards.get");
      const component = await ready;
      await session.prompt("Start an agent turn while the view is active");
      expect(notices.some((message) => message.includes("unavailable"))).toBe(false);
      expect(session.isStreaming).toBe(false);
      expect(requests).toHaveLength(0);
      component.handleInput("https://private.example/pr");
      component.handleInput("\t");
      component.handleInput("\r");
      await component.settled();
      veto = false;
      component.handleInput("\r");
      await component.settled();
      component.handleInput("\u001b");
      await interaction;
      const messages = JSON.stringify(session.sessionManager.buildSessionContext().messages);
      expect(messages).toContain("HOOK_VETO");
      expect(messages).toContain("confirmed");
      expect(messages).not.toContain("private.example");
      expect(session.sessionManager.buildSessionContext().messages).toHaveLength(2);
      await session.prompt("Read current state before relying on changed state");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("HOOK_VETO");
      expect(requests[0]).toContain("confirmed");
      expect(requests[0]).not.toContain("private.example");
    },
    { provider: "native-offline", id: "fixture" },
  );
  tui.stop();
});
