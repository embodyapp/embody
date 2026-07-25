import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
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
});
