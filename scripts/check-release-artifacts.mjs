import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packages = JSON.parse(
  execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], { encoding: "utf8" }),
).filter(
  (entry) =>
    entry.path?.includes("/packages/") &&
    (entry.name?.startsWith("@embody/") || entry.name === "create-embody-app"),
);
const directory = mkdtempSync(join(tmpdir(), "embody-pack-"));
try {
  for (const pkg of packages) {
    const output = JSON.parse(
      execFileSync("pnpm", ["pack", "--json", "--pack-destination", directory], {
        cwd: pkg.path,
        encoding: "utf8",
      }),
    );
    const record = Array.isArray(output) ? output[0] : output;
    const files = (record.files ?? []).map((file) => file.path);
    const forbidden = files.filter(
      (file) => /(^|\/)(\.env|test|src)(\/|$)|\.tsbuildinfo$/.test(file) && !file.endsWith(".d.ts"),
    );
    if (forbidden.length)
      throw new Error(`${pkg.name} tarball contains forbidden files: ${forbidden.join(", ")}`);
    const manifest = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8"));
    if (manifest.license !== "Elastic-2.0")
      throw new Error(`${pkg.name} does not declare Elastic-2.0`);
    if (!files.includes("LICENSE")) throw new Error(`${pkg.name} tarball lacks LICENSE`);
    if (!files.includes("NOTICE")) throw new Error(`${pkg.name} tarball lacks NOTICE`);
    if (pkg.name === "@embody/genui") {
      for (const file of [
        "dist/standard-renderer.js",
        "dist/standard-renderer-global.js",
        "dist/THIRD-PARTY-LICENSES.json",
        "dist/THIRD-PARTY-LICENSES.txt",
      ])
        if (!files.includes(file)) throw new Error(`${pkg.name} tarball lacks ${file}`);
      const inventory = JSON.parse(
        readFileSync(join(pkg.path, "dist/THIRD-PARTY-LICENSES.json"), "utf8"),
      );
      const notices = readFileSync(join(pkg.path, "dist/THIRD-PARTY-LICENSES.txt"), "utf8");
      for (const component of inventory) {
        if (
          typeof component.license !== "string" ||
          !component.license ||
          !notices.includes(`=== ${component.component} (`)
        )
          throw new Error(
            `${pkg.name}: missing license identification/text for ${component.component}`,
          );
      }
      for (const pin of [
        "@modelcontextprotocol/ext-apps@1.7.5",
        "@modelcontextprotocol/sdk@1.30.0",
      ])
        if (!inventory.some((component) => component.component === pin))
          throw new Error(`${pkg.name}: bundled compatibility pin ${pin} missing`);
      for (const file of files.filter((file) => file.endsWith(".js.map"))) {
        const map = JSON.parse(readFileSync(join(pkg.path, file), "utf8"));
        if (map.sources?.some((source) => /(^|\/)(test|fixtures|\.env)(\/|$)/.test(source)))
          throw new Error(`${pkg.name}: fixture/secret source in ${file}`);
      }
    }
    if (!manifest.exports || (!manifest.types && !manifest.exports["."]?.types))
      throw new Error(`${pkg.name} lacks typed exports`);
    console.log(`${pkg.name}: ${files.length} intended files`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
