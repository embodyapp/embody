import { access, readFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(root, "skills/embody/SKILL.md");
const requiredReferences = [
  "entities-actions-and-services.md",
  "safety-auth-and-errors.md",
  "events-and-workflows.md",
  "testing.md",
  "gateway-cli-and-mcp.md",
];

const failures = [];
const files = [skillPath];
for (const name of requiredReferences) files.push(join(root, "skills/embody/references", name));

for (const file of files) {
  try {
    await access(file);
  } catch {
    failures.push(`Missing required skill file: ${relative(root, file)}`);
  }
}

const skill = await readFile(skillPath, "utf8");
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];
if (!frontmatter) failures.push("SKILL.md must begin with YAML frontmatter");
for (const field of ["name", "description", "license", "compatibility", "metadata"])
  if (!new RegExp(`^${field}:`, "m").test(frontmatter ?? ""))
    failures.push(`SKILL.md frontmatter is missing ${field}`);
if (!/^name: embody$/m.test(frontmatter ?? "")) failures.push("Skill name must remain embody");

for (const name of requiredReferences)
  if (!skill.includes(`references/${name}`))
    failures.push(`SKILL.md does not route readers to references/${name}`);

for (const file of files) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    continue;
  }
  if ((content.match(/```/g) ?? []).length % 2 !== 0)
    failures.push(`${relative(root, file)} has unbalanced code fences`);
  if (/harness\.asActor\s*\(/.test(content))
    failures.push(`${relative(root, file)} uses removed harness.asActor()`);

  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    const withoutFragment = target.split("#", 1)[0];
    const destination = normalize(resolve(dirname(file), withoutFragment));
    try {
      await access(destination);
    } catch {
      failures.push(`${relative(root, file)} has a broken link to ${relative(root, destination)}`);
    }
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${files.length} Embody skill files.`);
}
