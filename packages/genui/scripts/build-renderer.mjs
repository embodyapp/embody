import { build } from "esbuild";
import { writeBundleLicenses } from "../../../scripts/bundle-licenses.mjs";
import { rm } from "node:fs/promises";
import { URL } from "node:url";
// Remove the pre-rename classic artifact; the ESM tsc entry must remain separate from bundles.
await rm(new URL("../dist/renderer-global.js", import.meta.url), { force: true });
await rm(new URL("../dist/renderer-global.js.map", import.meta.url), { force: true });
const shared = {
  entryPoints: ["src/renderer.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  legalComments: "eof",
  metafile: true,
};
await build({ ...shared, outfile: "dist/standard-renderer.js", format: "esm" });
const result = await build({
  ...shared,
  outfile: "dist/standard-renderer-global.js",
  format: "iife",
  globalName: "EmbodyGenUi",
});
writeBundleLicenses(result.metafile, "dist/THIRD-PARTY-LICENSES.txt");
