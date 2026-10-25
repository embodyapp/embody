import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import type * as WebRenderer from "../src/web.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

let browser: Browser;
let page: Page;
let stop: () => Promise<void>;
beforeAll(async () => {
  const source = await readFile(new URL("../dist/standard-renderer.js", import.meta.url), "utf8");
  const globalSource = await readFile(
    new URL("../dist/standard-renderer-global.js", import.meta.url),
    "utf8",
  );
  const hostScript =
    'const {createGenUiAppBridge,PostMessageTransport}=EmbodyGenUi; window.outcomes=[]; window.calls=[]; const frame=document.querySelector("iframe"); const hosted=createGenUiAppBridge({appId:"cards",generation:"a".repeat(64),currentGeneration:()=>"a".repeat(64),callableTargets:["cards.update"],tools:[{appId:"cards",target:"cards.update",tool:{name:"cards_update",inputSchema:{type:"object"},_meta:{ui:{visibility:["app"]}}}}],callTool:async(name,input)=>{window.calls.push({name,input});return {content:[{type:"text",text:"ok"}],structuredContent:{title:input.title}};},publishOutcome:async(outcome)=>{window.outcomes.push(outcome);}}); hosted.bridge.oninitialized=()=>{void hosted.bridge.sendToolInput({arguments:{}}).then(()=>hosted.bridge.sendToolResult({content:[{type:"text",text:"fallback"}],structuredContent:{title:"Before"}}));}; void hosted.bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow)); window.hosted=hosted; frame.src="/widget.html";';
  const widgetScript =
    'const {App,mountGenUiWeb}=EmbodyGenUi; const app=new App({name:"reference-widget",version:"1.0.0"},{},{autoResize:false,strict:true}); window.app=app; app.ontoolresult=(result)=>{const change={intent:"change",schema:{type:"object",additionalProperties:false,properties:{value:{type:"string",maxLength:100}},required:["value"]}}; mountGenUiWeb(document.querySelector("main"),{version:1,root:{version:1,type:"form",id:"edit",label:"Save",effect:"Change title",children:[{version:1,type:"field",id:"title",label:"Title",value:result.structuredContent.title,event:change}],event:{intent:"submit",target:"cards.update",schema:{type:"object",additionalProperties:false,properties:{title:{type:"string",maxLength:100}},required:["title"]}}}},{callableTargets:["cards.update"],resolveAction:(_id,values)=>({title:values.title}),onEvent:async(event)=>{if(event.intent==="change")return; const value=await app.callServerTool({name:"cards_update",arguments:event.payload},{signal:event.signal}); return {status:value.isError?"rejected":"confirmed"};}});}; void app.connect();';
  const server = createServer((request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
    );
    if (request.url === "/host.html")
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; frame-src 'self'; connect-src 'none'",
      );
    const scripts: Record<string, string> = {
      "/renderer.js": source,
      "/renderer-global.js": globalSource,
      "/host.js": hostScript,
      "/widget.js": widgetScript,
    };
    if (request.url && scripts[request.url] !== undefined) {
      response.setHeader("Content-Type", "text/javascript");
      response.end(scripts[request.url]);
      return;
    }
    if (request.url === "/host.html") {
      response.end(
        '<!doctype html><html lang="en"><title>Apps host</title><body><iframe title="Presentation" sandbox="allow-scripts"></iframe><script src="/renderer-global.js"></script><script src="/host.js"></script></body></html>',
      );
      return;
    }
    if (request.url === "/widget.html") {
      response.end(
        '<!doctype html><html lang="en"><title>View</title><body><main></main><script src="/renderer-global.js"></script><script src="/widget.js"></script></body></html>',
      );
      return;
    }
    response.setHeader(
      "Content-Type",
      request.url === "/renderer.js" || request.url === "/fixture.js"
        ? "text/javascript"
        : "text/html",
    );
    response.end(
      request.url === "/renderer.js"
        ? source
        : request.url === "/fixture.js"
          ? 'import * as renderer from "/renderer.js"; window.renderer = renderer;'
          : '<!doctype html><html lang="en"><title>GenUI fixture</title><body><main id="view"></main><script type="module" src="/fixture.js"></script></body></html>',
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  stop = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  browser = await chromium.launch({
    ...(process.env["CHROME_PATH"] ? { executablePath: process.env["CHROME_PATH"] } : {}),
    headless: true,
  });
  const context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => "renderer" in window);
});
afterAll(async () => {
  await browser?.close();
  await stop?.();
});
beforeEach(async () => {
  if (page) {
    await page.goto(new URL("/", page.url()).toString());
    await page.waitForFunction(() => "renderer" in window);
  }
});

it("keeps a single long-lived view's replacements bounded without recursive lifecycle chains", async () => {
  const result = await page.evaluate(() => {
    const renderer = (window as unknown as { renderer: typeof WebRenderer }).renderer;
    const container = document.getElementById("view")!;
    const text = (value: string) => ({
      version: 1,
      root: { version: 1, type: "text", text: value },
    });
    const view = renderer.mountGenUiWeb(container, text("initial"), {
      callableTargets: [],
      onEvent: () => {},
    });
    for (let iteration = 0; iteration < 10000; iteration++) view.update(text(String(iteration)));
    const content = container.textContent;
    view.dispose();
    return { content, remaining: container.childElementCount };
  });
  expect(result).toEqual({ content: expect.stringContaining("9999"), remaining: 0 });
});
it("soaks repeated public mount/update/dispose without retained nodes or live detached controls", async () => {
  const result = await page.evaluate(() => {
    const renderer = (window as unknown as { renderer: typeof WebRenderer }).renderer;
    const container = document.getElementById("view")!;
    const change = {
      intent: "change",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string", maxLength: 100 } },
        required: ["value"],
      },
    };
    const documentFor = (value: string) => ({
      version: 1,
      root: { version: 1, type: "field", id: "value", label: "Value", value, event: change },
    });
    let events = 0;
    let maximum = 0;
    const start = performance.now();
    for (let iteration = 0; iteration < 300; iteration++) {
      const view = renderer.mountGenUiWeb(container, documentFor("before"), {
        callableTargets: [],
        onEvent: () => {
          events++;
        },
      });
      view.update(documentFor("after"));
      maximum = Math.max(maximum, container.querySelectorAll("*").length);
      const input = container.querySelector("input")!;
      view.dispose();
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return {
      events,
      maximum,
      remaining: container.childElementCount,
      elapsedMs: performance.now() - start,
    };
  });
  expect(result.events).toBe(0);
  expect(result.maximum).toBeLessThan(20);
  expect(result.remaining).toBe(0);
  expect(result.elapsedMs).toBeLessThan(5000);
});
it.each(["uncertain", "confirmed"] as const)(
  "disables mutation retry after a %s unreconciled outcome until authoritative replacement",
  async (status) => {
    await page.evaluate((status) => {
      const state = window as unknown as {
        renderer: typeof WebRenderer;
        recoveryView: WebRenderer.GenUiWebView;
        recoveryDocument: unknown;
        calls: number;
      };
      state.calls = 0;
      state.recoveryDocument = {
        version: 1,
        root: {
          version: 1,
          type: "actions",
          actions: [
            {
              id: "save",
              label: "Save",
              effect: "Update task",
              event: {
                intent: "invoke",
                target: "cards.update",
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {},
                  required: [],
                },
              },
            },
          ],
        },
      };
      state.recoveryView = state.renderer.mountGenUiWeb(
        window.document.getElementById("view")!,
        state.recoveryDocument,
        {
          callableTargets: ["cards.update"],
          onEvent: () => {
            state.calls++;
            return { status, reconciled: false };
          },
        },
      );
    }, status);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page
      .getByRole("status", { name: "Presentation status" })
      .filter({ hasText: "current state" })
      .waitFor();
    expect(await page.getByRole("button", { name: "Save", exact: true }).isDisabled()).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { calls: number }).calls)).toBe(1);
    await page.evaluate(() => {
      const state = window as unknown as {
        recoveryView: WebRenderer.GenUiWebView;
        recoveryDocument: unknown;
      };
      state.recoveryView.update(state.recoveryDocument, { discardDraft: true });
    });
    expect(await page.getByRole("button", { name: "Save", exact: true }).isDisabled()).toBe(false);
    await page.evaluate(() => {
      (window as unknown as { recoveryView: WebRenderer.GenUiWebView }).recoveryView.markStale();
    });
    expect(await page.getByRole("button", { name: "Save", exact: true }).isDisabled()).toBe(true);
  },
);
it("renders standard semantic content and hostile text inert under a no-eval/no-network CSP", async () => {
  await page.evaluate(() => {
    const { mountGenUiWeb } = (window as unknown as { renderer: typeof WebRenderer }).renderer;
    mountGenUiWeb(
      document.getElementById("view")!,
      {
        version: 1,
        root: {
          version: 1,
          type: "section",
          title: "Sprint board",
          children: [
            {
              version: 1,
              type: "text",
              text: '<img src="https://evil.example" onerror="alert(1)">',
            },
            { version: 1, type: "keyValue", label: "Status", value: "In review" },
            { version: 1, type: "list", items: [{ version: 1, type: "badge", text: "Urgent" }] },
          ],
        },
      },
      { callableTargets: [], onEvent: () => {} },
    );
  });
  expect(await page.getByRole("heading", { name: "Sprint board" }).count()).toBe(1);
  expect(await page.locator("dt").textContent()).toBe("Status");
  expect(await page.locator("dd").textContent()).toBe("In review");
  expect(await page.getByRole("listitem").textContent()).toBe("Urgent");
  expect(await page.locator("#view img, #view script, #view [onerror]").count()).toBe(0);
  expect(await page.locator("#view").textContent()).toContain(
    '<img src="https://evil.example" onerror="alert(1)">',
  );
});

it("edits labeled controls, validates allowed submits, prevents duplicates and preserves a rejected draft", async () => {
  await page.evaluate(() => {
    type State = {
      renderer: typeof WebRenderer;
      events: unknown[];
      finish: () => void;
    };
    const state = window as unknown as State;
    state.events = [];
    const change = {
      intent: "change",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string", maxLength: 100 } },
        required: ["value"],
      },
    };
    state.renderer.mountGenUiWeb(
      document.getElementById("view")!,
      {
        version: 1,
        root: {
          version: 1,
          type: "form",
          id: "task",
          label: "Update task",
          effect: "Change status",
          children: [
            {
              version: 1,
              type: "select",
              id: "status",
              label: "Status",
              value: "todo",
              options: [
                { value: "todo", label: "Todo" },
                { value: "done", label: "Done" },
              ],
              event: change,
            },
            {
              version: 1,
              type: "field",
              id: "pr",
              label: "PR URL",
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
              properties: {
                status: { type: "string", maxLength: 16, enum: ["todo", "done"] },
                pr: { type: "string", maxLength: 100 },
              },
              required: ["status", "pr"],
            },
          },
        },
      },
      {
        callableTargets: ["cards.update"],
        resolveAction: (_id, values) => ({ status: values["status"], pr: values["pr"] }),
        onEvent: async (event) => {
          state.events.push(event);
          if (event.intent === "submit") {
            await new Promise<void>((resolve) => {
              state.finish = resolve;
            });
            return { status: "rejected" };
          }
        },
      },
    );
  });
  await page.getByLabel("Status", { exact: true }).selectOption("done");
  await page.getByLabel("PR URL").fill("https://example.com/pr/1");
  await page.getByRole("button", { name: "Update task" }).click();
  expect(await page.getByRole("button", { name: "Update task" }).isDisabled()).toBe(true);
  await page
    .getByRole("button", { name: "Update task" })
    .evaluate((button: HTMLButtonElement) => button.click());
  const submits = await page.evaluate(() =>
    (
      window as unknown as { events: { intent: string; payload: unknown; target?: string }[] }
    ).events
      .filter((event) => event.intent === "submit")
      .map(({ payload, target }) => ({ payload, target })),
  );
  expect(submits).toEqual([
    { target: "cards.update", payload: { status: "done", pr: "https://example.com/pr/1" } },
  ]);
  await page.evaluate(() => (window as unknown as { finish: () => void }).finish());
  await page
    .getByRole("status", { name: "Presentation status" })
    .filter({ hasText: "Action rejected" })
    .waitFor();
  expect(await page.getByLabel("PR URL").inputValue()).toBe("https://example.com/pr/1");
  expect(await page.getByRole("button", { name: "Update task" }).isEnabled()).toBe(true);
});

it("suppresses queued changes and detached controls after disposal", async () => {
  const count = await page.evaluate(async () => {
    const renderer = (window as unknown as { renderer: typeof WebRenderer }).renderer;
    let events = 0;
    const view = renderer.mountGenUiWeb(
      document.getElementById("view")!,
      {
        version: 1,
        root: {
          version: 1,
          type: "field",
          id: "title",
          label: "Title",
          value: "before",
          event: {
            intent: "change",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { value: { type: "string", maxLength: 100 } },
              required: ["value"],
            },
          },
        },
      },
      {
        callableTargets: [],
        onEvent: () => {
          events++;
        },
      },
    );
    const input = document.querySelector("input")!;
    input.value = "after";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    view.dispose();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    return events;
  });
  expect(count).toBe(0);
  expect(await page.locator("#view input").count()).toBe(0);
});

it("requires explicit draft discard before replacing changed authoritative data", async () => {
  const result = await page.evaluate(() => {
    const renderer = (window as unknown as { renderer: typeof WebRenderer }).renderer;
    const change = {
      intent: "change",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string", maxLength: 100 } },
        required: ["value"],
      },
    };
    const documentFor = (value: string) => ({
      version: 1,
      root: { version: 1, type: "field", id: "title", label: "Title", value, event: change },
    });
    const view = renderer.mountGenUiWeb(document.getElementById("view")!, documentFor("before"), {
      callableTargets: [],
      onEvent: () => {},
    });
    const input = document.querySelector("input")!;
    input.value = "draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const first = view.update(documentFor("external"));
    const preserved = document.querySelector("input")!.value;
    const second = view.update(documentFor("external"), { discardDraft: true });
    const refreshed = document.querySelector("input")!.value;
    view.dispose();
    return { first, preserved, second, refreshed };
  });
  expect(result).toEqual({
    first: "review-required",
    preserved: "draft",
    second: "updated",
    refreshed: "external",
  });
});

it("initializes the official App/AppBridge in an opaque iframe, delivers direct props and records an allowed interaction", async () => {
  const host = new URL("/host.html", page.url());
  await page.goto(host.toString());
  const frame = page.frameLocator("iframe");
  await frame.getByLabel("Title").fill("After");
  await frame.getByRole("button", { name: "Save" }).click();
  await frame
    .getByRole("status", { name: "Presentation status" })
    .filter({ hasText: "Action confirmed" })
    .waitFor();
  expect(await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls)).toEqual([
    { name: "cards_update", input: { title: "After" } },
  ]);
  expect(
    await page.evaluate(() => (window as unknown as { outcomes: unknown[] }).outcomes),
  ).toEqual([{ target: "cards.update", status: "confirmed", reconciliation: "read-required" }]);
  const widget = page.frames().find((candidate) => candidate.url().endsWith("/widget.html"))!;
  expect(
    await widget.evaluate(() => {
      try {
        return !!window.parent.document;
      } catch {
        return false;
      }
    }),
  ).toBe(false);
  expect(
    await widget.evaluate(
      async () =>
        (
          await (
            window as unknown as {
              app: { callServerTool(params: unknown): Promise<{ isError?: boolean }> };
            }
          ).app.callServerTool({ name: "other_delete", arguments: {} })
        ).isError,
    ),
  ).toBe(true);
  await page.evaluate(() =>
    (window as unknown as { hosted: { dispose(): void } }).hosted.dispose(),
  );
});

it("renders all fourteen nodes accessibly in narrow dark reduced-motion mode with keyboard-only controls", async () => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.evaluate(() => {
    const renderer = (window as unknown as { renderer: typeof WebRenderer }).renderer;
    const change = {
      intent: "change",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "string", maxLength: 100 } },
        required: ["value"],
      },
    };
    const invoke = {
      intent: "invoke",
      target: "cards.read",
      schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    };
    renderer.mountGenUiWeb(
      document.getElementById("view")!,
      {
        version: 1,
        root: {
          version: 1,
          type: "section",
          title: "All nodes",
          children: [
            {
              version: 1,
              type: "columns",
              children: [
                {
                  version: 1,
                  type: "stack",
                  children: [
                    { version: 1, type: "text", text: "Plain text" },
                    { version: 1, type: "callout", tone: "warning", text: "Please review" },
                    { version: 1, type: "badge", text: "Urgent" },
                    { version: 1, type: "keyValue", label: "State", value: "Todo" },
                    { version: 1, type: "emptyState", text: "No other tasks" },
                    { version: 1, type: "errorState", text: "Safe error" },
                    {
                      version: 1,
                      type: "list",
                      items: [{ version: 1, type: "text", text: "First task" }],
                    },
                  ],
                },
              ],
            },
            {
              version: 1,
              type: "form",
              id: "form",
              label: "Save",
              effect: "Update task",
              event: { ...invoke, intent: "submit" },
              children: [
                {
                  version: 1,
                  type: "field",
                  id: "title",
                  label: "Title",
                  value: "First",
                  event: change,
                },
                {
                  version: 1,
                  type: "select",
                  id: "status",
                  label: "Status",
                  value: "todo",
                  options: [{ value: "todo", label: "Todo" }],
                  event: change,
                },
              ],
            },
            {
              version: 1,
              type: "actions",
              actions: [
                { id: "read", label: "Refresh", effect: "Read current data", event: invoke },
                {
                  id: "blocked",
                  label: "Unavailable",
                  effect: "Unavailable",
                  event: invoke,
                  disabled: true,
                },
              ],
            },
          ],
        },
      },
      { callableTargets: ["cards.read"], onEvent: () => ({ status: "confirmed" }) },
    );
  });
  expect(
    await page.locator(".genui-columns").evaluate((node) => getComputedStyle(node).display),
  ).toBe("grid");
  expect(
    await page.locator(".genui-view").evaluate((node) => getComputedStyle(node).colorScheme),
  ).toBe("light dark");
  expect(await page.getByRole("button", { name: "Unavailable" }).isDisabled()).toBe(true);
  await page.keyboard.press("Tab");
  expect(await page.getByLabel("Title").evaluate((node) => node === document.activeElement)).toBe(
    true,
  );
  await page.keyboard.press("Tab");
  expect(
    await page
      .getByLabel("Status", { exact: true })
      .evaluate((node) => node === document.activeElement),
  ).toBe(true);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page
    .getByRole("status", { name: "Presentation status" })
    .filter({ hasText: "Action confirmed" })
    .waitFor();
  expect(
    (await new AxeBuilder({ page }).analyze()).violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    ),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
