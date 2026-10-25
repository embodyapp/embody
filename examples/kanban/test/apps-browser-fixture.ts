import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect } from "vitest";
import { createPiVisibilityHost } from "./pi-host-fixture.js";
export async function runKanbanAppsBrowser(
  gatewayUrl: string,
  generation: string,
  publishOutcome: (value: unknown) => void,
): Promise<void> {
  const visibility = await createPiVisibilityHost();
  const client = new Client(
    { name: "Embody reference Apps host", version: "1.0.0" },
    {
      capabilities: {
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
      },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(gatewayUrl + "/mcp/kanban"), {
      requestInit: { headers: { Authorization: "Bearer api-key" } },
    }) as unknown as Transport,
  );
  const tools = (await client.listTools()).tools;
  const map = {
    kanban_board: "kanban.board",
    kanban_card_get: "kanban.card.get",
    kanban_card_update: "kanban.card.update",
  };
  const trusted = tools
    .filter((tool) => tool.name in map)
    .map((tool) => ({
      target: map[tool.name as keyof typeof map],
      appId: "kanban",
      tool,
      effect: tool.name === "kanban_card_update" ? "mutation" : "read",
    }));
  const resource = (await client.readResource({ uri: "ui://kanban/board@1.0.0" })).contents[0];
  if (!resource || !("text" in resource)) throw new Error("No resource");
  const initial = await client.callTool({ name: "kanban_board", arguments: {} });
  const asset = await readFile(
    new URL(import.meta.resolve("@embody/genui/renderer-global.js")),
    "utf8",
  );
  const key = randomBytes(32).toString("base64url");
  const script = `const {createGenUiAppBridge,PostMessageTransport}=EmbodyGenUi;const frame=document.querySelector('iframe'); const hosted=createGenUiAppBridge({appId:'kanban',generation:${JSON.stringify(generation)},currentGeneration:()=>${JSON.stringify(generation)},callableTargets:['kanban.board','kanban.card.get','kanban.card.update'],tools:${JSON.stringify(trusted)},callTool:async(name,input,signal)=>{const res=await fetch('/call',{method:'POST',headers:{Authorization:'Bearer ${key}','Content-Type':'application/json'},body:JSON.stringify({name,input}),signal});if(!res.ok)throw Error('Unavailable');return res.json();},publishOutcome:async(outcome)=>{const res=await fetch('/outcome',{method:'POST',headers:{Authorization:'Bearer ${key}','Content-Type':'application/json'},body:JSON.stringify(outcome)});if(!res.ok)throw Error('Unavailable');}}); hosted.bridge.oninitialized=()=>{void hosted.bridge.sendToolResult(${JSON.stringify(initial)});}; void hosted.bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/widget';window.hosted=hosted;`;
  let origin = "";
  const server = createServer((req, res) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    const work = async () => {
      if (req.url === "/renderer") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(asset);
        return;
      }
      if (req.url === "/script") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(script);
        return;
      }
      if (req.url === "/widget") {
        res.removeHeader("Content-Security-Policy");
        res.setHeader("Content-Type", "text/html");
        res.end(resource.text);
        return;
      }
      if (req.method === "GET" && req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<!doctype html><html lang="en"><title>Reference Apps host</title><body><iframe title="Kanban" sandbox="allow-scripts"></iframe><script src="/renderer"></script><script src="/script"></script></body></html>',
        );
        return;
      }
      if (
        req.method !== "POST" ||
        req.headers.authorization !== `Bearer ${key}` ||
        req.headers.origin !== origin ||
        !["/call", "/outcome"].includes(req.url ?? "")
      ) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const parts: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const data: unknown = chunk;
        if (!(data instanceof Uint8Array) || (bytes += data.byteLength) > 65536) throw new Error();
        parts.push(Buffer.from(data));
      }
      const body: unknown = JSON.parse(Buffer.concat(parts).toString());
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/outcome") {
        visibility.publish(body);
        publishOutcome(body);
        res.end("{}");
        return;
      }
      if (
        body === null ||
        typeof body !== "object" ||
        !("name" in body) ||
        typeof body.name !== "string" ||
        !(body.name in map) ||
        !("input" in body) ||
        body.input === null ||
        typeof body.input !== "object" ||
        Array.isArray(body.input)
      )
        throw new Error();
      res.end(
        JSON.stringify(
          await client.callTool({
            name: body.name,
            arguments: body.input as Record<string, unknown>,
          }),
        ),
      );
    };
    void work().catch(() => {
      res.statusCode = 404;
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({
    headless: true,
    ...(process.env["CHROME_PATH"] ? { executablePath: process.env["CHROME_PATH"] } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    const frame = page.frameLocator("iframe");
    await frame.getByText("Apps task", { exact: true }).waitFor();
    await frame
      .locator(".genui-stack")
      .filter({ has: frame.getByText("Apps task", { exact: true }) })
      .getByRole("button", { name: "Open task" })
      .click();
    await frame.getByLabel("Status", { exact: true }).selectOption("done");
    await frame.getByRole("button", { name: "Update task" }).click();
    await frame
      .getByRole("status", { name: "Presentation status" })
      .filter({ hasText: "Action rejected" })
      .waitFor();
    await frame.getByLabel("PR URL").fill("https://private.example/apps/pr");
    await frame.getByRole("button", { name: "Update task" }).click();
    await frame.locator("#connection").filter({ hasText: "confirmed" }).waitFor();
    await frame.getByText("Done", { exact: true }).first().waitFor();
    expect(await page.evaluate(() => document.querySelector("iframe")!.contentDocument)).toBeNull();
    await page.close();
    await visibility.verify();
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.close();
    await visibility.close();
  }
}
