import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
/** Inventory actual esbuild inputs, not every installed dependency. Fail closed on missing license text. */
export function writeBundleLicenses(metafile, destination) {
  const owners = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.includes("node_modules/")) continue;
    let directory = dirname(resolve(input));
    let manifest;
    while (directory !== dirname(directory)) {
      if (existsSync(join(directory, "package.json"))) {
        const candidate = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        if (typeof candidate.name === "string" && typeof candidate.version === "string") {
          manifest = candidate;
          break;
        }
      }
      directory = dirname(directory);
    }
    if (!manifest) throw new Error(`No owning package for bundled input ${input}`);
    const key = `${manifest.name}@${manifest.version}`;
    if (owners.has(key)) continue;
    const files = readdirSync(directory).filter((name) =>
      /^(licen[cs]e|copying|notice)(\.|$)/i.test(name),
    );
    if (!files.length) throw new Error(`Bundled dependency ${key} has no license text`);
    owners.set(key, { directory, manifest, files });
  }
  const text = [...owners.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, value]) =>
        `=== ${key} (${String(value.manifest.license ?? "license in accompanying text")}) ===\n${value.files
          .sort()
          .map((file) => `--- ${file} ---\n${readFileSync(join(value.directory, file), "utf8")}`)
          .join("\n")}\n`,
    )
    .join("\n");
  writeFileSync(destination, text);
  writeFileSync(
    destination.replace(/\.txt$/, ".json"),
    `${JSON.stringify(
      [...owners.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([component, { manifest }]) => ({ component, license: manifest.license ?? null })),
      null,
      2,
    )}\n`,
  );
}
