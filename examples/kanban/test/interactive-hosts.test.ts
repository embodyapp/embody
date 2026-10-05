import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { runKanbanAppsBrowser } from "./apps-browser-fixture.js";
import { verifyPlainHosts } from "./plain-hosts-fixture.js";
import { defineApp, createAppHost, createRegistrationClient } from "@embody/host";
import { gatewayJwtVerifier } from "@embody/auth";
import {
  AuthChain,
  apiKeyProvider,
  hashApiKey,
  GatewayRegistry,
  createGateway,
} from "@embody/gateway";
import { defineGenUi, defineView, withGenUi } from "@embody/genui";
import { createGenUiGatewayConnection } from "@embody/genui/client";
import {
  createGenUiController,
  type GenUiController,
  type GenUiDelivery,
} from "@embody/genui/controller";
import { createGenUiBrowserHost } from "@embody/genui/browser";
import { resolveGenUiPayload } from "@embody/genui/payload";
import { createPiGenUiComponent } from "@embody/genui-pi";
import { kanbanPlugin, KanbanBoardSchema, KanbanBoardCardSchema } from "../src/plugin.js";
import { kanbanProvider } from "../src/native-provider.js";

it("completes the real agent-principal Kanban journey through authenticated discovery and native keyboard controls", async () => {
  const key = new TextEncoder().encode("test-key-for-kanban-at-least-32-bytes");
  const gateway = createGateway({
    registry: new GatewayRegistry({
      allowPrivateEndpoints: true,
      credentials: { kanban: "registration" },
    }),
    token: { issuer: "gateway", key },
    auth: new AuthChain([
      apiKeyProvider([
        {
          id: "agent",
          hash: hashApiKey("api-key"),
          principal: {
            orgId: `journey-${randomUUID()}`,
            actorId: "agent-1",
            actorType: "agent",
            roles: [],
            scopes: ["kanban:*"],
          },
        },
      ]),
    ]),
  });
  const gatewayUrl = await gateway.listen({ port: 0, host: "127.0.0.1" });
  const app = withGenUi(
    defineApp({ appId: "kanban", version: "1.0.0", plugins: [kanbanPlugin] }),
    defineGenUi({
      views: {
        board: defineView({
          kind: "standard",
          version: "1.0.0",
          props: KanbanBoardSchema,
          callableTargets: ["kanban.board", "kanban.card.get", "kanban.card.update"],
          fallback: "text",
          resource: {
            text: readFileSync(new URL("../dist/kanban-app.html", import.meta.url), "utf8"),
          },
        }),
      },
      actions: { "kanban.board": "board" },
    }),
  );
  const runtime = await createAppHost(app, {
    env: {
      NODE_ENV: "development",
      PORT: "0",
      DATABASE_FILE: ":memory:",
      ...(process.env["P14_DATABASE_URL"] ? { DATABASE_URL: process.env["P14_DATABASE_URL"] } : {}),
    },
    verifier: gatewayJwtVerifier({
      issuer: "gateway",
      audience: "kanban",
      key,
      algorithms: ["HS256"],
      maxTokenAgeSeconds: 60,
    }),
  });
  let connection: Awaited<ReturnType<typeof createGenUiGatewayConnection>> | undefined;
  let browserHost: Awaited<ReturnType<typeof createGenUiBrowserHost>> | undefined;
  try {
    const endpoint = await runtime.start();
    await createRegistrationClient({
      gatewayUrl,
      appId: "kanban",
      version: "1.0.0",
      endpoint,
      healthCheckUrl: endpoint + "/health",
      manifest: runtime.manifest,
      secret: "registration",
    }).register();
    const created = await gateway.inject({
      method: "POST",
      url: "/api/execute/kanban/kanban.card.create",
      headers: { authorization: "Bearer api-key" },
      payload: { data: { title: "Add login" } },
    });
    const card = KanbanBoardCardSchema.parse(created.json());
    connection = await createGenUiGatewayConnection({
      gatewayUrl,
      appId: "kanban",
      authorization: "Bearer api-key",
    });
    const discovered = await connection.discover("kanban.board");
    const controller: GenUiController = createGenUiController({
      document: kanbanProvider.present(
        "kanban.board",
        await discovered.dispatch("kanban.board", {}, new AbortController().signal),
      ),
      callableTargets: discovered.view.callableTargets,
      readTargets: kanbanProvider.readTargets,
      refresh: { target: "kanban.board", input: {} },
      dispatch: discovered.dispatch,
      present: kanbanProvider.present,
      resolveAction: (id, values) =>
        resolveGenUiPayload(kanbanProvider.bindings(controller.document)[id], values),
    });
    const outcomes: Omit<GenUiDelivery, "document">[] = [];
    const component = createPiGenUiComponent({
      controller,
      requestRender: () => {},
      onClose: () => {},
      publishOutcome: (outcome) => {
        outcomes.push(outcome);
        return Promise.resolve();
      },
    });
    expect(component.render(80).join("\n")).toContain("Add login");
    component.handleInput("\r");
    await component.settled();
    // Details: status select -> PR input -> submit, operated without browser or test-only draft access.
    component.handleInput("\u001b[B");
    component.handleInput("\u001b[B");
    component.handleInput("\u001b[B");
    component.handleInput("\t");
    component.handleInput("\t");
    component.handleInput("\r");
    await component.settled();
    expect(component.render(80).join("\n")).toContain("HOOK_VETO");
    expect(outcomes).toHaveLength(1); // Opening a task did not enter conversation context.
    component.handleInput("\u001b[Z");
    component.handleInput("https://private.example/pull/1");
    component.handleInput("\t");
    component.handleInput("\r");
    await component.settled();
    expect(component.render(80).join("\n")).toContain("confirmed");
    expect(JSON.stringify(outcomes)).not.toContain("private.example");
    const final = KanbanBoardCardSchema.parse(
      await discovered.dispatch("kanban.card.get", { id: card.id }, new AbortController().signal),
    );
    expect(final.data.status).toBe("done");
    await verifyPlainHosts(gatewayUrl, card.id);
    component.dispose();
    // The identical controller and packaged renderer are available to non-Apps browser clients.
    if (process.env["P14_BROWSER"] === "1")
      await gateway.inject({
        method: "POST",
        url: "/api/execute/kanban/kanban.card.create",
        headers: { authorization: "Bearer api-key" },
        payload: { data: { title: "Browser task" } },
      });
    const browserController: GenUiController = createGenUiController({
      document: kanbanProvider.present(
        "kanban.board",
        await discovered.dispatch("kanban.board", {}, new AbortController().signal),
      ),
      callableTargets: discovered.view.callableTargets,
      readTargets: kanbanProvider.readTargets,
      refresh: { target: "kanban.board", input: {} },
      dispatch: discovered.dispatch,
      present: kanbanProvider.present,
      resolveAction: (id, values) =>
        resolveGenUiPayload(kanbanProvider.bindings(browserController.document)[id], values),
    });
    browserHost = await createGenUiBrowserHost({ mode: "development" });
    const lease = browserHost.open({
      appId: "kanban",
      viewId: "board",
      generation: discovered.generation,
      controller: browserController,
      bindings: kanbanProvider.bindings,
      publishOutcome: (outcome) => {
        outcomes.push(outcome);
        return Promise.resolve();
      },
    });
    expect(new URL(lease.url).hash).toHaveLength(44);
    if (process.env["P14_BROWSER"] === "1") {
      const browser = await chromium.launch({
        headless: true,
        ...(process.env["CHROME_PATH"] ? { executablePath: process.env["CHROME_PATH"] } : {}),
      });
      try {
        const page = await browser.newPage();
        await page.goto(lease.url);
        await page.getByText("Browser task", { exact: true }).waitFor();
        await page
          .locator(".genui-stack")
          .filter({ has: page.getByText("Browser task", { exact: true }) })
          .getByRole("button", { name: "Open task" })
          .click();
        await page.getByLabel("Status", { exact: true }).selectOption("done");
        await page.getByRole("button", { name: "Update task" }).click();
        await page
          .getByRole("status", { name: "Presentation status" })
          .filter({ hasText: "Action rejected" })
          .waitFor();
        const warning = page.waitForEvent("dialog", { timeout: 2000 });
        // A dismissed beforeunload cancels navigation. Playwright/Chrome may
        // reject immediately or leave the navigation waiter until its deadline.
        const reloading = page.reload({ timeout: 2000 }).catch(() => {});
        const dialog = await warning;
        expect(dialog.type()).toBe("beforeunload");
        await dialog.dismiss();
        await reloading;
        await page.getByLabel("PR URL").fill("https://private.example/browser/pr");
        await page.getByRole("button", { name: "Update task" }).click();
        await page.locator("#connection").filter({ hasText: "confirmed" }).waitFor();
        await page.getByText("Done", { exact: true }).first().waitFor();
        expect(await page.evaluate(() => location.hash)).toBe("");
        expect(await page.evaluate(() => localStorage.length)).toBe(0);
        expect(JSON.stringify(outcomes)).not.toContain("private.example");
      } finally {
        await browser.close();
      }
    }
    lease.revoke();
    if (process.env["P14_BROWSER"] === "1") {
      await gateway.inject({
        method: "POST",
        url: "/api/execute/kanban/kanban.card.create",
        headers: { authorization: "Bearer api-key" },
        payload: { data: { title: "Apps task" } },
      });
      const before = outcomes.length;
      const appOutcomes: unknown[] = [];
      await runKanbanAppsBrowser(gatewayUrl, runtime.generation, (value) => {
        const parsed = typeof value === "object" && value !== null ? value : undefined;
        expect(parsed).toMatchObject({
          target: "kanban.card.update",
          reconciliation: "read-required",
        });
        appOutcomes.push(parsed);
      });
      expect(outcomes).toHaveLength(before);
      expect(appOutcomes).toMatchObject([{ status: "rejected" }, { status: "confirmed" }]);
      expect(JSON.stringify(appOutcomes)).not.toContain("private.example");
    }
  } finally {
    await browserHost?.close();
    await connection?.close();
    await runtime.stop();
    await gateway.close();
  }
}, 15000);
