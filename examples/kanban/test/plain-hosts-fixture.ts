import { runCli } from "@embody/cli";
import { z } from "@embody/core";
import { Readable, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect } from "vitest";
export async function verifyPlainHosts(gatewayUrl: string, id: string) {
  const client = new Client({ name: "plain-client", version: "1.0.0" });
  const cache = await mkdtemp(join(tmpdir(), "kanban-cli-"));
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(gatewayUrl + "/mcp/kanban"), {
        requestInit: { headers: { Authorization: "Bearer api-key" } },
      }) as unknown as Transport,
    );
    const tool = (await client.listTools()).tools.find((tool) => tool.name === "kanban_board");
    expect(tool?._meta).toBeUndefined();
    const result = await client.callTool({ name: "kanban_card_get", arguments: { id } });
    expect(result.structuredContent).toBeUndefined();
    const fallback = z
      .object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1) })
      .parse(result);
    const card: unknown = JSON.parse(fallback.content[0]!.text);
    expect(card).toMatchObject({ id, data: { status: "done" } });
    let output = "";
    const stdout = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    let errorText = "";
    const stderr = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        errorText += chunk.toString();
        callback();
      },
    });
    const code = await runCli(["kanban", "card", "get", id, "--output", "json"], {
      env: {
        ...process.env,
        EMBODY_GATEWAY_URL: gatewayUrl,
        EMBODY_TOKEN: "api-key",
        EMBODY_CACHE_DIR: cache,
        EMBODY_CONFIG: join(cache, "settings.json"),
      },
      io: { stdin: Readable.from([]), stdout, stderr },
    });
    expect(errorText).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(output) as unknown).toMatchObject({ id, data: { status: "done" } });
    expect(output).not.toContain("<!doctype html>");
  } finally {
    await client.close();
    await rm(cache, { recursive: true, force: true });
  }
}
