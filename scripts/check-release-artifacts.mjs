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
    if (!manifest.exports || (!manifest.types && !manifest.exports["."]?.types))
      throw new Error(`${pkg.name} lacks typed exports`);
    console.log(`${pkg.name}: ${files.length} intended files`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
