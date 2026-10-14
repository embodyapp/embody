import { expect, it, vi } from "vitest";
import type * as Storage from "@embody/storage";

const configs = vi.hoisted(() => [] as unknown[]);
vi.mock("@embody/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof Storage>();
  class RecordingPostgresStorage extends actual.PostgresStorage {
    public constructor(...args: ConstructorParameters<typeof actual.PostgresStorage>) {
      configs.push(args);
      super(...args);
    }
  }
  return { ...actual, PostgresStorage: RecordingPostgresStorage };
});

const { createAppHost } = await import("../src/index.js");

it("hosted runtime pins bounded PostgreSQL pool, statement and idle-transaction limits", async () => {
  // Boot fails on the unreachable database; only the pool configuration is asserted.
  await expect(
    createAppHost(
      { appId: "app", version: "1.0.0", plugins: [] },
      {
        env: {
          NODE_ENV: "production",
          EMBODY_HOST_PROFILE: "hosted",
          DATABASE_URL: "postgresql://runtime:unused@127.0.0.1:1/never_connected",
          PORT: "0",
          EMBODY_WORKSPACE_ID: "ws_test12345",
          GATEWAY_JWT_ISSUER: "https://gateway.example",
          GATEWAY_JWKS_URL: "https://gateway.example/jwks",
        },
      },
    ),
  ).rejects.toThrow();
  expect(configs).toEqual([
    [
      {
        connectionString: "postgresql://runtime:unused@127.0.0.1:1/never_connected",
        max: 5,
        statement_timeout: 30_000,
        idle_in_transaction_session_timeout: 30_000,
        idleTimeoutMillis: 1_000,
      },
      { schemaMode: "verify" },
    ],
  ]);
});
