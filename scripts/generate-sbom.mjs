import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const graph = JSON.parse(
  execFileSync("pnpm", ["list", "--recursive", "--prod", "--depth", "Infinity", "--json"], {
    encoding: "utf8",
  }),
);
const components = new Map();
const workspaceVersions = new Map(graph.map((entry) => [entry.name, entry.version]));
const visit = (entry) => {
  if (!entry || typeof entry !== "object") return;
  const name = entry.name ?? entry.from;
  const version =
    typeof entry.version === "string" && entry.version.startsWith("link:")
      ? workspaceVersions.get(name)
      : entry.version;
  if (name && version)
    components.set(`${name}@${version}`, {
      type: "library",
      name,
      version,
      purl: `pkg:npm/${name.split("/").map(encodeURIComponent).join("/")}@${encodeURIComponent(version)}`,
    });
  for (const dependency of Object.values(entry.dependencies ?? {})) visit(dependency);
};
for (const workspace of graph) visit(workspace);
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: "application", name: "embody", version: "0.0.0" },
  },
  components: [...components.values()].sort((a, b) => a.purl.localeCompare(b.purl)),
};
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/sbom.cdx.json", `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`Wrote artifacts/sbom.cdx.json (${components.size} components)`);
