import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  // Flat output: the plugin resolves `../migrations` relative to its own emitted file,
  // so dist/ must sit at the package root exactly as src/ did.
  outDir: "dist",
});
