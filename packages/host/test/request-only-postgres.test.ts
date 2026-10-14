import { describe, expect, it, vi } from "vitest";
import { createAppHost, type AppHostRuntime } from "../src/index.js";

const connectionString = process.env["EMBODY_POSTGRES_URL"];
if (process.env["EMBODY_POSTGRES_REQUIRED"] === "true" && !connectionString)
  throw new Error("Hosted factory proof requires EMBODY_POSTGRES_URL");
const suite = connectionString ? describe : describe.skip;
suite("hosted request-only factory", () => {
  it("20 concurrent runtime-role boots/starts have no registration, worker intervals or drain hooks", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const runtimes: AppHostRuntime[] = [];
    try {
      const created = await Promise.all(
        Array.from({ length: 20 }, () =>
          createAppHost(
            { appId: "app", version: "1.0.0", plugins: [] },
            {
              env: {
                NODE_ENV: "production",
                EMBODY_HOST_PROFILE: "hosted",
                DATABASE_URL: connectionString,
                PORT: "0",
                EMBODY_WORKSPACE_ID: "ws_test12345",
                GATEWAY_JWT_ISSUER: "https://gateway.example",
                GATEWAY_JWKS_URL: "https://gateway.example/jwks",
              },
            },
          ),
        ),
      );
      runtimes.push(...created);
      await Promise.all(runtimes.map((runtime) => runtime.start()));
      for (const runtime of runtimes) {
        expect((await runtime.app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({
          ready: true,
        });
        await expect(runtime.tickEvents()).rejects.toThrow(/no event delivery/);
        await expect(runtime.tickWorkflows()).rejects.toThrow(/no workflow/);
      }
      expect(interval).not.toHaveBeenCalled();
    } finally {
      await Promise.all(runtimes.map((runtime) => runtime.stop()));
      interval.mockRestore();
    }
  });
});
