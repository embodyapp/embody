// Stages the recipe image build context from the current checkout: packs every publishable
// @embody package (run `pnpm build` first), records name/version/sha512 integrity in
// framework.json, and copies the trusted step scripts. Usage: node stage.mjs <out-dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

export async function stageRecipe(out) {
  const framework = join(out, "framework");
  await mkdir(framework, { recursive: true });
  const entries = [];
  for (const dir of (await readdir(join(root, "packages"))).sort()) {
    const manifestPath = join(root, "packages", dir, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!manifest.name?.startsWith("@embody/") || manifest.private) continue;
    const packed = JSON.parse(
      execFileSync("pnpm", ["pack", "--json", "--pack-destination", framework], {
        cwd: join(root, "packages", dir),
        encoding: "utf8",
      }),
    );
    const record = Array.isArray(packed) ? packed[0] : packed;
    const file = resolve(join(root, "packages", dir), record.filename);
    const bytes = await readFile(file);
    const name = `${manifest.name.split("/")[1]}-${manifest.version}.tgz`;
    if (resolve(framework, name) !== file) await copyFile(file, join(framework, name));
    // The packument needs the published dependency map (workspace: ranges are rewritten by pack).
    const { execFileSync: x } = await import("node:child_process");
    const published = JSON.parse(
      x("tar", ["-xOzf", join(framework, name), "package/package.json"], { encoding: "utf8" }),
    );
    entries.push({
      name: manifest.name,
      version: manifest.version,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      file: name,
      manifest: {
        dependencies: published.dependencies ?? {},
        peerDependencies: published.peerDependencies ?? {},
        optionalDependencies: published.optionalDependencies ?? {},
        engines: published.engines ?? {},
        ...(published.bin ? { bin: published.bin } : {}),
      },
    });
  }
  await writeFile(join(framework, "framework.json"), `${JSON.stringify(entries, null, 2)}\n`);
  for (const file of ["Dockerfile", "prepare.mjs", "registry.mjs", "extract.mjs", "sandbox.sh"])
    await copyFile(join(here, file), join(out, file));
  return entries;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) throw new Error("Usage: node stage.mjs <out-dir>");
  const entries = await stageRecipe(resolve(out));
  console.log(`staged ${entries.length} framework packages`);
}
