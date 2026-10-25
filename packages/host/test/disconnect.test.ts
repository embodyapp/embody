import { expect, it } from "vitest";
import { definePlugin, Kernel, z } from "@embody/core";
import { SqliteStorage } from "@embody/storage";
import { createHost } from "../src/index.js";
it.each(["/execute", "/execute/stream"])(
  "propagates a completed-body caller disconnect through %s to ordinary action cancellation",
  async (route) => {
    let entered: () => void = () => {};
    let canceled: () => void = () => {};
    let wasCanceled = false;
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      canceled = resolve;
    });
    const plugin = definePlugin({ id: "cards", version: "1.0.0", entities: {} }, (define) => ({
      actions: {
        wait: define.action({
          input: z.object({}),
          output: z.object({}),
          handler: async (_input, context) => {
            await new Promise<void>((resolve) => {
              release = resolve;
              context.signal?.addEventListener(
                "abort",
                () => {
                  wasCanceled = true;
                  canceled();
                  resolve();
                },
                { once: true },
              );
              entered();
            });
            return {};
          },
        }),
      },
    }));
    const kernel = new Kernel({
      plugins: [plugin],
      storage: new SqliteStorage({ filename: ":memory:" }),
    });
    await kernel.boot();
    const runtime = createHost({
      kernel,
      appId: "cards",
      version: "1.0.0",
      verifier: {
        id: "fixture",
        verify: () =>
          Promise.resolve({
            orgId: "org",
            actorId: "agent",
            actorType: "agent",
            roles: [],
            scopes: ["cards:*"],
          }),
      },
    });
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await runtime.start();
      const url = await runtime.app.listen({ port: 0, host: "127.0.0.1" });
      const pending = fetch(url + route, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Gateway-Auth": "Bearer fixture" },
        body: JSON.stringify({ protocolVersion: 1, target: "cards.wait", input: {} }),
      })
        .then((response) => response.text())
        .catch(() => "disconnected");
      await started;
      controller.abort();
      await pending;
      await Promise.race([
        aborted,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Downstream action was not canceled")),
            1000,
          );
        }),
      ]);
      expect(wasCanceled).toBe(true);
    } finally {
      if (deadline) clearTimeout(deadline);
      release();
      await runtime.stop();
      await kernel.stop();
    }
  },
);
