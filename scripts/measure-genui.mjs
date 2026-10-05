/* global window */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath, URL } from "node:url";
import { TextEncoder } from "node:util";
import { defineGenUi, defineView, withGenUi } from "../packages/genui/dist/index.js";
import { renderGenUiMarkdown } from "../packages/genui/dist/text.js";
import { createGenUiController } from "../packages/genui/dist/controller.js";
import { createGenUiBrowserHost } from "../packages/genui/dist/browser.js";
import { createGenUiGatewayConnection } from "../packages/genui/dist/client.js";
import { createPiGenUiComponent } from "../packages/genui-pi/dist/index.js";
import { createAppHost, defineApp, createRegistrationClient } from "../packages/host/dist/index.js";
import { gatewayJwtVerifier } from "../packages/auth/dist/index.js";
import {
  createGateway,
  GatewayRegistry,
  AuthChain,
  apiKeyProvider,
  hashApiKey,
} from "../packages/gateway/dist/index.js";
import { kanbanPlugin, KanbanBoardSchema } from "../examples/kanban/dist/src/plugin.js";
import {
  createKanbanBoardDocument,
  createKanbanTaskDocument,
} from "../examples/kanban/dist/src/presentation.js";

// Public built entrypoints only. pnpm build must precede this command; no source aliases.
const require = createRequire(new URL("../packages/genui/package.json", import.meta.url));
const { chromium } = require("playwright");
const budgets = {
  esmBytes: 786432,
  classicBytes: 786432,
  kanbanHtmlBytes: 786432,
  coldDiscoveryMs: 2000,
  resourceReadP95Ms: 1000,
  webFirstRenderMs: 250,
  webUpdateP95Ms: 100,
  markdownP95Ms: 100,
  nativeRenderP95Ms: 100,
  native300LifecyclesMs: 5000,
  native300LifecyclesHeapBytes: 16777216,
  web300LifecyclesMs: 10000,
  web300LifecyclesHeapBytes: 33554432,
  browser100SessionsHeapBytes: 67108864,
};
const measurements = {};
console.error("Measuring built renderer and native lifecycle...");
function measure(name, operation) {
  const start = performance.now();
  const result = operation();
  measurements[name] = performance.now() - start;
  return result;
}
function p95(values) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}
function sample(operation, count = 30) {
  return Array.from({ length: count }, () => {
    const start = performance.now();
    operation();
    return performance.now() - start;
  });
}
const asset = readFileSync(new URL("../packages/genui/dist/standard-renderer.js", import.meta.url));
const classic = readFileSync(
  new URL("../packages/genui/dist/standard-renderer-global.js", import.meta.url),
);
const html = readFileSync(new URL("../examples/kanban/dist/kanban-app.html", import.meta.url));
Object.assign(measurements, {
  esmBytes: asset.length,
  classicBytes: classic.length,
  kanbanHtmlBytes: html.length,
});
const document = createKanbanBoardDocument({
  title: "Performance fixture — 20 tasks",
  cards: Array.from({ length: 20 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    data: {
      title: `Task ${index} 👩‍💻`,
      status: ["todo", "in_progress", "in_review", "done"][index % 4],
      priority: "medium",
    },
  })),
  nextOffset: null,
});
const callableTargets = ["kanban.board", "kanban.card.get", "kanban.card.update"];
function controller() {
  return createGenUiController({
    document,
    callableTargets,
    readTargets: ["kanban.board", "kanban.card.get"],
    refresh: { target: "kanban.board", input: {} },
    present: () => document,
    resolveAction: () => ({}),
    dispatch: () => Promise.resolve({}),
  });
}
measurements.markdownP95Ms = p95(sample(() => renderGenUiMarkdown(document)));
const native = createPiGenUiComponent({
  controller: controller(),
  requestRender: () => {},
  onClose: () => {},
  publishOutcome: () => Promise.resolve(),
});
try {
  measurements.nativeRenderP95Ms = p95(
    sample(() => {
      native.invalidate();
      native.render(80);
    }),
  );
} finally {
  native.dispose();
}
globalThis.gc?.();
const nativeHeapBefore = process.memoryUsage().heapUsed;
measure("native300LifecyclesMs", () => {
  for (let i = 0; i < 300; i++) {
    const component = createPiGenUiComponent({
      controller: controller(),
      requestRender: () => {},
      onClose: () => {},
      publishOutcome: () => Promise.resolve(),
    });
    component.render(i % 2 ? 30 : 120);
    component.dispose();
    assert.deepEqual(component.render(80), []);
  }
});
globalThis.gc?.();
measurements.native300LifecyclesHeapBytes = Math.max(
  0,
  process.memoryUsage().heapUsed - nativeHeapBefore,
);
console.error("Measuring temporary browser leases...");
const browserHost = await createGenUiBrowserHost({ mode: "development", maxSessions: 100 });
try {
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  const leases = Array.from({ length: 100 }, () =>
    browserHost.open({
      appId: "kanban",
      viewId: "board",
      generation: "measurement",
      controller: controller(),
      bindings: {},
      publishOutcome: () => Promise.resolve(),
    }),
  );
  globalThis.gc?.();
  measurements.browser100SessionsHeapBytes = Math.max(0, process.memoryUsage().heapUsed - before);
  assert.throws(() =>
    browserHost.open({
      appId: "kanban",
      viewId: "board",
      generation: "measurement",
      controller: controller(),
      bindings: {},
      publishOutcome: () => Promise.resolve(),
    }),
  );
  leases.forEach((lease) => lease.revoke());
} finally {
  await browserHost.close();
}

console.error("Measuring Chrome renderer...");
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'",
  );
  res.setHeader(
    "Content-Type",
    req.url === "/renderer.js" || req.url === "/fixture.js" ? "text/javascript" : "text/html",
  );
  res.end(
    req.url === "/renderer.js"
      ? asset
      : req.url === "/fixture.js"
        ? 'import * as renderer from "/renderer.js"; window.renderer=renderer;'
        : '<!doctype html><html lang="en"><title>GenUI release fixture</title><body><main></main><script type="module" src="/fixture.js"></script></body></html>',
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
let browserVersion;
try {
  browserVersion = browser.version();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => !!window.renderer);
  const web = await page.evaluate(
    ({ document, callableTargets }) => {
      const container = window.document.querySelector("main");
      const start = performance.now();
      const view = window.renderer.mountGenUiWeb(container, document, {
        callableTargets,
        onEvent: () => {},
      });
      const first = performance.now() - start;
      const updates = [];
      for (let i = 0; i < 30; i++) {
        const next = performance.now();
        view.update(document);
        updates.push(performance.now() - next);
      }
      window.view = view;
      return { first, updates };
    },
    { document, callableTargets },
  );
  measurements.webFirstRenderMs = web.first;
  measurements.webUpdateP95Ms = p95(web.updates);
  mkdirSync(new URL("../artifacts/genui/", import.meta.url), { recursive: true });
  for (const [name, width, scheme] of [
    ["wide-light", 1200, "light"],
    ["narrow-dark", 360, "dark"],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.evaluate(
      (board) => {
        window.view.update(board);
      },
      {
        version: 1,
        root: {
          version: 1,
          type: "stack",
          children: [
            document.root,
            createKanbanTaskDocument({
              id: "00000000-0000-4000-8000-000000000000",
              data: { title: "Task details", status: "todo", priority: "medium" },
            }).root,
            {
              version: 1,
              type: "callout",
              tone: "warning",
              text: "Review current state before submitting",
            },
            { version: 1, type: "emptyState", text: "No tasks in this filtered view" },
            { version: 1, type: "errorState", text: "A safe rejected action" },
          ],
        },
      },
    );
    await page.screenshot({
      path: fileURLToPath(new URL(`../artifacts/genui/${name}.png`, import.meta.url)),
      fullPage: true,
    });
  }
  await page.evaluate(() => window.view.dispose());
  assert.equal(await page.locator("main > *").count(), 0);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  const heapBefore = await cdp.send("Runtime.getHeapUsage");
  measurements.web300LifecyclesMs = await page.evaluate(
    ({ document, callableTargets }) => {
      const start = performance.now();
      for (let i = 0; i < 300; i++) {
        const view = window.renderer.mountGenUiWeb(
          window.document.querySelector("main"),
          document,
          { callableTargets, onEvent: () => {} },
        );
        view.update(document);
        view.dispose();
      }
      return performance.now() - start;
    },
    { document, callableTargets },
  );
  await cdp.send("HeapProfiler.collectGarbage");
  const heapAfter = await cdp.send("Runtime.getHeapUsage");
  measurements.web300LifecyclesHeapBytes = Math.max(0, heapAfter.usedSize - heapBefore.usedSize);
  assert.equal(await page.locator("main > *").count(), 0);
  await cdp.detach();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

// Cold authenticated discovery and subsequent generation/integrity-checked resource reads.
// These are loopback reference-host measurements, not WAN/vendor latency promises.
console.error("Measuring authenticated host resources...");
const key = new TextEncoder().encode("performance-fixture-signing-key-32-bytes");
const gateway = createGateway({
  registry: new GatewayRegistry({
    allowPrivateEndpoints: true,
    credentials: { kanban: "measurement" },
  }),
  token: { issuer: "gateway", key },
  auth: new AuthChain([
    apiKeyProvider([
      {
        id: "measure",
        hash: hashApiKey("measurement-key"),
        principal: {
          orgId: "measurement",
          actorId: "agent",
          actorType: "agent",
          roles: [],
          scopes: ["kanban:*"],
        },
      },
    ]),
  ]),
});
let runtime;
let connection;
try {
  const gatewayUrl = await gateway.listen({ host: "127.0.0.1", port: 0 });
  const application = withGenUi(
    defineApp({ appId: "kanban", version: "1.0.0", plugins: [kanbanPlugin] }),
    defineGenUi({
      views: {
        board: defineView({
          kind: "standard",
          version: "1.0.0",
          props: KanbanBoardSchema,
          callableTargets,
          fallback: "text",
          resource: { text: html.toString("utf8") },
        }),
      },
      actions: { "kanban.board": "board" },
    }),
  );
  console.error("Starting app host...");
  runtime = await createAppHost(application, {
    env: { NODE_ENV: "development", PORT: "0", DATABASE_FILE: ":memory:" },
    verifier: gatewayJwtVerifier({
      issuer: "gateway",
      audience: "kanban",
      key,
      algorithms: ["HS256"],
      maxTokenAgeSeconds: 60,
    }),
  });
  const endpoint = await runtime.start();
  await createRegistrationClient({
    gatewayUrl,
    appId: "kanban",
    version: "1.0.0",
    endpoint,
    healthCheckUrl: endpoint + "/health",
    manifest: runtime.manifest,
    secret: "measurement",
  }).register();
  console.error("Discovering authenticated view...");
  const start = performance.now();
  connection = await createGenUiGatewayConnection({
    gatewayUrl,
    appId: "kanban",
    authorization: "Bearer measurement-key",
  });
  await connection.discover("kanban.board");
  measurements.coldDiscoveryMs = performance.now() - start;
  const reads = [];
  for (let i = 0; i < 10; i++) {
    const read = performance.now();
    await connection.discover("kanban.board");
    reads.push(performance.now() - read);
  }
  measurements.resourceReadP95Ms = p95(reads);
} finally {
  console.error("Closing authenticated hosts...");
  await connection?.close();
  console.error("Connection closed");
  await runtime?.stop();
  console.error("App host closed");
  await gateway.close();
  console.error("Gateway closed");
}
const evidence = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: platform(),
  arch: arch(),
  browser: browserVersion,
  fixture:
    "20-task Kanban board; 30 render samples; 10 authenticated resource samples; 100 leases; 300 native lifecycles",
  gc: typeof globalThis.gc === "function",
  budgets,
  measurements,
};
const output = new URL(process.argv[2] ?? "../artifacts/genui/performance.json", import.meta.url);
mkdirSync(new URL(".", output), { recursive: true });
writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
for (const [name, budget] of Object.entries(budgets))
  assert.ok(measurements[name] <= budget, `${name}: ${measurements[name]} exceeds ${budget}`);
