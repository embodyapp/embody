// Runs INSIDE the no-network sandbox, after the customer's own install and build. It imports
// the customer's compiled config, so everything it writes is untrusted: the gateway re-validates
// the output and derives the profile from the catalog itself.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const APP = "/app";
async function importPackage(name) {
  const root = join(APP, "node_modules", ...name.split("/"));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const entry = manifest.exports?.["."]?.import ?? manifest.exports?.["."] ?? manifest.main;
  if (typeof entry !== "string") throw new Error(`Cannot resolve ${name}`);
  return import(pathToFileURL(join(root, entry)).href);
}
const core = await importPackage("@embody/core");
const host = await importPackage("@embody/host");
const config = (await import(pathToFileURL(join(APP, "dist/embody.config.js")).href)).default;
if (!config || !Array.isArray(config.plugins)) throw new Error("embody.config default export must be defineApp(...)");
const passes = (check) => {
  try {
    check(config.plugins);
    return true;
  } catch {
    return false;
  }
};
const output = {
  format: "embody-build-output-v1",
  recipe: "embody-node24-pnpm-v1",
  nodeVersion: process.version,
  appId: config.appId,
  appVersion: config.version,
  preflight: {
    requestOnly: passes(core.assertRequestOnlyPlugins),
    durable: passes(core.assertDurablePlugins),
  },
  publishes: Array.isArray(config.publishes) ? config.publishes : [],
  catalog: core.compileManifest(config.plugins, { app: host.appMetadataOf(config) }),
};
await writeFile("/out/manifest.json", `${JSON.stringify(output)}\n`, { flag: "w" });
console.log("embody: manifest extracted");
