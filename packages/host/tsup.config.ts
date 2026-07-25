import { defineConfig } from "tsup";
import { chmod, readFile, writeFile } from "node:fs/promises";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // Sourcemaps plus `src` in `files` means a consumer can still step into the runtime
  // they are extending, which is most of what the pre-npm layout gave them for free.
  sourcemap: true,
  target: "node20",
  // Flat output: a plugin resolves `../migrations` relative to its own emitted file,
  // so dist/ must sit at the package root exactly as src/ did.
  outDir: "dist",

  // The source shebang is `tsx` so the bin can run straight from src in development.
  // What we publish is already compiled and must not drag a TypeScript loader in.
  async onSuccess() {
    const file = "dist/bin.js";
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace(/^#![^\n]*\n/, "#!/usr/bin/env node\n"));
    await chmod(file, 0o755);
  },
});
