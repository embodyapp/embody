import { Buffer } from "node:buffer";
import { build } from "esbuild";
import { writeBundleLicenses } from "../../../scripts/bundle-licenses.mjs";
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
const result = await build({
  entryPoints: ["src/browser.mjs"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "eof",
  metafile: true,
});
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const digest = createHash("sha256").update(script).digest("base64");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${digest}'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"><title>Kanban standard view</title></head><body><main aria-label="Kanban presentation"></main><p id="connection" role="status">Connecting…</p><script>${script}</script></body></html>`;
if (Buffer.byteLength(html) > 1_048_576)
  throw new Error("Kanban presentation exceeds resource limit");
await mkdir("dist", { recursive: true });
writeBundleLicenses(result.metafile, "dist/THIRD-PARTY-LICENSES.txt");
await writeFile("dist/kanban-app.html", html);
console.log(`Static Kanban Apps resource: ${Buffer.byteLength(html)} bytes`);
