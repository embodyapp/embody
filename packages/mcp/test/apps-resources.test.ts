import type { AppManifest } from "@embody/core";
import { genUiResourceIntegrity } from "@embody/genui";
import { expect, it } from "vitest";
import { createMcpCatalog } from "../src/index.js";
import { withApps } from "./apps-fixture.js";

const html = "<!doctype html><main>Static fixture</main>";
const uri = "ui://cards/board@1.0.0";
const manifest: AppManifest = {
  protocolVersion: 1,
  plugins: [{ id: "cards", version: "1.0.0" }],
  entities: {},
  eventSubscriptions: [],
  actions: {
    "cards.board": {
      generated: false,
      inputSchema: { type: "object", properties: {} },
      presentation: { view: "board" },
    },
  },
  views: {
    board: {
      protocolVersion: 1,
      id: "board",
      kind: "standard",
      version: "1.0.0",
      propsSchema: { type: "object", properties: {} },
      resourceUri: uri,
      callableTargets: ["cards.board"],
      fallback: "text",
      integrity: genUiResourceIntegrity({ text: html }),
    },
  },
};

it("delivers progress and cancels canonical execution without publishing a late result", async () => {
  let started!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const progress: number[] = [];
  await withApps(
    {
      catalog: () => createMcpCatalog([{ appId: "cards", manifest }]),
      readResource: () => Promise.resolve({ text: html }),
      execute: async function* (_context, _entry, _input, signal) {
        yield { type: "progress", update: { percent: 25, message: "Working" } };
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        expect(signal.aborted).toBe(true);
        finish();
      },
    },
    async (client) => {
      const abort = new AbortController();
      const calling = client.callTool({ name: "cards__cards_board", arguments: {} }, undefined, {
        signal: abort.signal,
        onprogress: (update) => {
          progress.push(update.progress);
          started();
        },
      });
      const rejection = expect(calling).rejects.toThrow();
      await ready;
      abort.abort();
      await rejection;
      await done;
      expect(progress).toEqual([25]);
    },
  );
});

it("rechecks authorization for resources and tool calls after session initialization", async () => {
  let authorized = true;
  let executions = 0;
  await withApps(
    {
      catalog: () => (authorized ? createMcpCatalog([{ appId: "cards", manifest }]) : []),
      readResource: () => Promise.resolve({ text: html }),
      execute: async function* () {
        executions++;
        await Promise.resolve();
        yield { type: "result", value: {} };
      },
    },
    async (client) => {
      expect((await client.listResources()).resources).toHaveLength(1);
      authorized = false;
      await expect(client.readResource({ uri })).rejects.toThrow(
        "Resource not found or unavailable",
      );
      expect((await client.callTool({ name: "cards__cards_board", arguments: {} })).isError).toBe(
        true,
      );
      expect(executions).toBe(0);
    },
  );
});

it.each(["generation", "permission"])(
  "does not return an in-flight resource after its %s changes",
  async (change) => {
    let generation = "a".repeat(64);
    let allow = true;
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withApps(
      {
        catalog: () => (allow ? createMcpCatalog([{ appId: "cards", manifest, generation }]) : []),
        readResource: async () => {
          started();
          await wait;
          return { text: html };
        },
        execute: async function* () {
          await Promise.resolve();
          yield { type: "result", value: {} };
        },
      },
      async (client) => {
        const reading = client.readResource({ uri });
        await ready;
        if (change === "generation") generation = "b".repeat(64);
        else allow = false;
        release();
        await expect(reading).rejects.toThrow("Resource not found or unavailable");
        expect((await client.listResources()).resources).toEqual([]);
      },
    );
  },
);
