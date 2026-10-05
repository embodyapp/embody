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
async function* execute() {
  await Promise.resolve();
  yield { type: "result" as const, value: { title: "Authoritative data" } };
}

it("does not advertise Apps metadata or change ordinary results without a resource provider", async () => {
  await withApps(
    { catalog: () => createMcpCatalog([{ appId: "cards", manifest }]), execute },
    async (client) => {
      expect((await client.listTools()).tools[0]?._meta).toBeUndefined();
      expect(client.getServerCapabilities()?.resources).toBeUndefined();
      expect(await client.callTool({ name: "cards__cards_board", arguments: {} })).toEqual({
        content: [{ type: "text", text: '{"title":"Authoritative data"}' }],
      });
    },
  );
});

it("never resolves traversal, foreign, network, or local-file URIs through the provider", async () => {
  let reads = 0;
  await withApps(
    {
      catalog: () => createMcpCatalog([{ appId: "cards", manifest }]),
      readResource: () => {
        reads++;
        return Promise.resolve({ text: html });
      },
      execute,
    },
    async (client) => {
      expect((await client.listResources()).resources).toEqual([
        { uri, name: "board", mimeType: "text/html;profile=mcp-app" },
      ]);
      for (const requested of [
        "ui://other/board@1.0.0",
        "ui://cards/../board@1.0.0",
        "ui://cards/%2e%2e/board@1.0.0",
        "https://private.example/secret",
        "file:///etc/passwd",
      ]) {
        await expect(client.readResource({ uri: requested })).rejects.toThrow(
          "Resource not found or unavailable",
        );
      }
      expect(reads).toBe(0);
    },
  );
});

it.each(["bytes", "mime", "cause"])(
  "rejects substituted %s without leaking provider details or breaking ordinary data",
  async (substitution) => {
    await withApps(
      {
        catalog: () => createMcpCatalog([{ appId: "cards", manifest }]),
        readResource: () => {
          if (substitution === "cause")
            return Promise.reject(new Error("private credential details"));
          return Promise.resolve(
            substitution === "mime"
              ? { text: html, mimeType: "text/html" as never }
              : { text: "private substituted bytes" },
          );
        },
        execute,
      },
      async (client) => {
        await expect(client.readResource({ uri })).rejects.toThrow(
          "Resource not found or unavailable",
        );
        expect(
          (await client.callTool({ name: "cards__cards_board", arguments: {} })).structuredContent,
        ).toEqual({ title: "Authoritative data" });
      },
    );
  },
);

it("forwards a safe definitive error code to Apps clients without adding the cause or changing fallback text", async () => {
  await withApps(
    {
      catalog: () => createMcpCatalog([{ appId: "cards", manifest }]),
      readResource: () => Promise.resolve({ text: html }),
      execute: async function* () {
        await Promise.resolve();
        yield { type: "error", message: "Tool execution failed", code: "HOOK_VETO" };
      },
    },
    async (client) => {
      const result = await client.callTool({ name: "cards__cards_board", arguments: {} });
      expect(result).toEqual({
        isError: true,
        content: [{ type: "text", text: "Tool execution failed" }],
        _meta: { "embody/errorCode": "HOOK_VETO" },
      });
    },
  );
});
