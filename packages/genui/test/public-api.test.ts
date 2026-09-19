import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("built GenUI public API", () => {
  it("is consumable through package exports under Node ESM", () => {
    const root = resolve(import.meta.dirname, "..");
    execFileSync(process.execPath, [
      resolve(root, "../../node_modules/typescript/bin/tsc"),
      "-p",
      resolve(root, "tsconfig.build.json"),
    ]);
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import { genUiResourceUri } from "@embody/genui"; console.log(genUiResourceUri("demo", "board", "1.0.0"));',
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(output).toBe("ui://demo/board@1.0.0\n");
  }, 15_000);
});
