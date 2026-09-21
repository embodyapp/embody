import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("built public API", () => {
  it("is consumable through package exports under Node ESM", () => {
    const root = resolve(import.meta.dirname, "..");
    execFileSync(process.execPath, [
      resolve(root, "../../node_modules/typescript/bin/tsc"),
      "-p",
      resolve(root, "tsconfig.build.json"),
    ]);
    const script = resolve(root, "../../test/fixtures/core-consumer/index.mjs");

    expect(execFileSync(process.execPath, [script], { encoding: "utf8" })).toBe(
      "email/sendBatch\n",
    );
  }, 30_000);
});
