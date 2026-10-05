import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "embody-genui-consumer-"));
function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}
try {
  run("pnpm", ["--filter", "@embody/genui-pi...", "build"], root);
  const dependencies = {};
  for (const directory of ["core", "genui", "genui-pi"]) {
    const path = join(root, "packages", directory);
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    run("pnpm", ["pack", "--pack-destination", temporary], path);
    const filename = `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`;
    dependencies[manifest.name] = `file:./${filename}`;
  }
  writeFileSync(
    join(temporary, "package.json"),
    JSON.stringify({
      name: "genui-external-consumer",
      private: true,
      type: "module",
      dependencies: {
        ...dependencies,
        "@earendil-works/pi-coding-agent": "1.0.0",
        "@earendil-works/pi-tui": "1.0.0",
        ...(process.argv.includes("--browser") ? { playwright: "1.58.2" } : {}),
      },
    }),
  );
  writeFileSync(
    join(temporary, "pnpm-workspace.yaml"),
    "overrides:\n" +
      Object.entries(dependencies)
        .map(([name, file]) => "  " + JSON.stringify(name) + ": " + JSON.stringify(file))
        .join("\n") +
      "\n",
  );
  run("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], temporary);
  writeFileSync(
    join(temporary, "smoke.mjs"),
    `
    import assert from "node:assert/strict";
    import { parseGenUiDocument, parseGenUiEvent } from "@embody/genui/document";
    import { renderGenUiText, renderGenUiMarkdown } from "@embody/genui/text";
    import { createGenUiSession } from "@embody/genui/session";
    import { genUiResourceUri } from "@embody/genui";
    import { mountGenUiWeb } from "@embody/genui/web";
    import { createGenUiAppBridge } from "@embody/genui/apps";
    import { readFileSync } from "node:fs";
    assert.equal(typeof mountGenUiWeb, "function");
    assert.equal(typeof createGenUiAppBridge, "function");
    assert.ok(readFileSync(new URL(import.meta.resolve("@embody/genui/renderer-global.js")), "utf8").includes("EmbodyGenUi"));
    const document = parseGenUiDocument({ version: 1, root: { version: 1, type: "section", title: "Current sprint", children: [{ version: 1, type: "list", items: [{ version: 1, type: "text", text: "Add login" }] }] } });
    assert.equal(renderGenUiText(document), "Current sprint\\n\\n- Add login\\n");
    assert.equal(renderGenUiMarkdown(document), "## Current sprint\\n\\n- Add login\\n");
    const controls = { version: 1, root: { version: 1, type: "actions", actions: [{ id: "refresh", label: "Refresh", effect: "Read current state", event: { intent: "invoke", target: "cards.board", schema: { type: "object", additionalProperties: false, properties: {}, required: [] } } }] } };
    assert.deepEqual(parseGenUiEvent(controls, "refresh", {}, { callableTargets: ["cards.board"] }), {});
    assert.throws(() => parseGenUiEvent(controls, "refresh", {}), /allowlisted/);
    assert.equal(typeof createGenUiSession, "function");
    assert.equal(genUiResourceUri("kanban", "board", "1.0.0"), "ui://kanban/board@1.0.0");
    console.log("GenUI packed external-consumer smoke passed.");
  `,
  );
  run(process.execPath, ["smoke.mjs"], temporary);
  writeFileSync(
    join(temporary, "pi-smoke.mjs"),
    `
    import assert from "node:assert/strict";
    import { join } from "node:path";
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
    import { createPiGenUiComponent, createPiGenUiExtension } from "@embody/genui-pi";
    assert.equal(typeof createPiGenUiComponent,"function"); assert.equal(typeof createPiGenUiExtension,"function");
    const isolated=mkdtempSync(join(tmpdir(),"packed-pi-"));
    const settingsManager=SettingsManager.inMemory({packages:[join(process.cwd(),"node_modules/@embody/genui-pi")],retry:{enabled:false},compaction:{enabled:false}});
    const loader=new DefaultResourceLoader({cwd:isolated,agentDir:isolated,settingsManager,noContextFiles:true,noSkills:true,noPromptTemplates:true,noThemes:true});
    try { await loader.reload(); assert.deepEqual(loader.getExtensions().errors,[]); assert.ok(loader.getExtensions().extensions.some(e=>e.path.includes("genui-pi"))); const {session}=await createAgentSession({cwd:isolated,agentDir:isolated,resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(isolated),noTools:"all"}); try {await session.bindExtensions({}); await session.prompt("/embody-view cards cards.board"); assert.equal(session.isStreaming,false); } finally {session.dispose();} console.log("Packed Pi manifest discovery/load/lifecycle smoke passed."); } finally {rmSync(isolated,{recursive:true,force:true});}
  `,
  );
  run(process.execPath, ["pi-smoke.mjs"], temporary);
  if (process.argv.includes("--browser")) {
    writeFileSync(
      join(temporary, "browser.mjs"),
      `
      import assert from "node:assert/strict";
      import { createServer } from "node:http";
      import { once } from "node:events";
      import { readFileSync } from "node:fs";
      import { chromium } from "playwright";
      const asset = readFileSync(new URL(import.meta.resolve("@embody/genui/renderer-global.js")), "utf8");
      const fixture = 'EmbodyGenUi.mountGenUiWeb(document.querySelector("main"),{version:1,root:{version:1,type:"section",title:"Packed presentation",children:[{version:1,type:"text",text:"<script>inert</script>"}]}},{callableTargets:[],onEvent:()=>{}});';
      const server = createServer((req,res) => { res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'"); res.setHeader("Content-Type", req.url === "/" ? "text/html" : "text/javascript"); res.end(req.url === "/renderer.js" ? asset : req.url === "/fixture.js" ? fixture : '<!doctype html><html lang="en"><title>Packed fixture</title><body><main></main><script src="/renderer.js"></script><script src="/fixture.js"></script></body></html>'); });
      server.listen(0,"127.0.0.1"); await once(server,"listening");
      const browser = await chromium.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
      try { const page=await browser.newPage(); await page.goto("http://127.0.0.1:"+server.address().port); assert.equal(await page.getByRole("heading",{name:"Packed presentation"}).count(),1); assert.equal(await page.locator("main script").count(),0); assert.ok((await page.locator("main").textContent()).includes("<script>inert</script>")); console.log("Packed GenUI browser artifact smoke passed."); }
      finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
    `,
    );
    run(process.execPath, ["browser.mjs"], temporary);
  }
  const installed = JSON.parse(
    readFileSync(join(temporary, "node_modules", "@embody", "genui", "package.json"), "utf8"),
  );
  assert.equal(installed.name, "@embody/genui");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
