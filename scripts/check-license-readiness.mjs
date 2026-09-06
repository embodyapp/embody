import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const errors = [];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Until counsel-approved terms are installed, publishable packages must not imply
// that recipients receive MIT, open-source, or other unapproved rights.
const licenseInstalled = await exists(join(root, "LICENSE"));
const packageDirectories = await readdir(join(root, "packages"), { withFileTypes: true });
for (const entry of packageDirectories) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(root, "packages", entry.name, "package.json");
  if (!(await exists(manifestPath))) continue;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!licenseInstalled && manifest.license !== "UNLICENSED") {
    errors.push(`${manifestPath}: expected license UNLICENSED while approved LICENSE is absent`);
  }
  if (licenseInstalled && manifest.license === "UNLICENSED") {
    errors.push(
      `${manifestPath}: approved LICENSE exists but package metadata is still UNLICENSED`,
    );
  }
}

const claims = [
  ["README.md", /License:\s*MIT|opensource\.org\/licenses\/MIT/iu],
  [
    "docs/production/02-troubleshooting-faq.md",
    /\*\*Yes\.\*\* Embody is open-source|permissive \*\*MIT License\*\*/iu,
  ],
  ["apps/landing/index.html", /Open source &amp; MIT licensed/iu],
];
for (const [relative, prohibited] of claims) {
  const content = await readFile(join(root, relative), "utf8");
  if (prohibited.test(content))
    errors.push(`${relative}: contains a superseded MIT/open-source claim`);
}

const scaffold = await readFile(join(root, "packages/create-embody-app/src/index.ts"), "utf8");
if (!/license:\s*"UNLICENSED"/u.test(scaffold)) {
  errors.push("generated applications must declare license UNLICENSED");
}
if (/^[ ]{4}"LICENSE":/mu.test(scaffold)) {
  errors.push("generated applications must not inherit an Embody LICENSE");
}

if (errors.length > 0) {
  console.error(`License readiness check failed:\n- ${errors.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(
    licenseInstalled
      ? "License readiness metadata is consistent with the installed LICENSE."
      : "Pre-license readiness checks passed; release remains blocked pending approved terms.",
  );
}
