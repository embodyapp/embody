import { chmod, readFile, writeFile } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  outDir: "dist",

  async onSuccess() {
    const file = "dist/bin.js";
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace(/^#![^\n]*\n/, "#!/usr/bin/env node\n"));
    await chmod(file, 0o755);
  },
});
