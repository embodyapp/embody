import { App } from "@modelcontextprotocol/ext-apps";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createGenUiAppBridge } from "../src/apps.js";

it.each(["cancel", "dispose", "generation"])(
  "marks a %s-invalidated mutation uncertain even if an uncooperative dispatcher returns success later",
  async (reason) => {
    let generation = "a";
    let started!: () => void;
    let release!: () => void;
    let cancelled!: () => void;
    let reported!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const delivered = new Promise<void>((resolve) => {
      reported = resolve;
    });
    const outcomes: unknown[] = [];
    const hosted = createGenUiAppBridge({
      appId: "cards",
      generation,
      currentGeneration: () => generation,
      callableTargets: ["cards.update"],
      tools: [
        { target: "cards.update", tool: { name: "update", inputSchema: { type: "object" } } },
      ],
      callTool: async (_name, _input, signal) => {
        signal.addEventListener("abort", cancelled, { once: true });
        started();
        await wait;
        return { content: [], structuredContent: { private: "late props" } };
      },
      publishOutcome: (outcome) => {
        outcomes.push(outcome);
        reported();
        return Promise.resolve();
      },
    });
    const app = new App({ name: "widget", version: "1" }, {}, { autoResize: false, strict: true });
    const [view, host] = InMemoryTransport.createLinkedPair();
    const controller = new AbortController();
    try {
      await hosted.bridge.connect(host);
      await app.connect(view);
      const calling = app.callServerTool(
        { name: "update", arguments: {} },
        { signal: controller.signal },
      );
      const completion =
        reason === "generation"
          ? calling.then((result) => {
              expect(result.isError).toBe(true);
              expect(result.structuredContent).toBeUndefined();
            })
          : expect(calling).rejects.toThrow();
      await ready;
      if (reason === "generation") {
        generation = "b";
      } else if (reason === "dispose") hosted.dispose();
      else controller.abort();
      if (reason !== "generation") await aborted;
      release();
      await completion;
      await delivered;
      expect(outcomes).toEqual([
        { target: "cards.update", status: "uncertain", reconciliation: "read-required" },
      ]);
    } finally {
      release();
      hosted.dispose();
      await view.close();
    }
  },
);
