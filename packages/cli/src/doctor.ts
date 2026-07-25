/**
 * `embody doctor` — the check that turns the ownership boundary from a convention
 * into something mechanical.
 *
 * embody's promise is that you customize your instance and still take upstream
 * upgrades. That holds for exactly one reason: your changes live in directories
 * upstream never writes to. The moment you edit a file under framework/, catalog/ or
 * examples/, the next `git merge upstream/main` has a conflict to resolve, and the
 * promise quietly stops being true.
 *
 * So this reports what you have changed outside your own zones — before you upgrade,
 * not during. It is advisory: it prints findings and sets an exit code, and never
 * touches your working tree.
 */
import { execFile } from "node:child_process";
import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Directories that come from upstream and are replaced wholesale on upgrade. */
export const UPSTREAM_ZONES = ["framework/", "catalog/", "examples/"] as const;
/** Directories you own. Upstream never writes here. */
export const USER_ZONES = ["custom/", "deploy/"] as const;

export interface Finding {
  level: "error" | "warn";
  message: string;
  detail?: string[];
}

export interface DoctorReport {
  findings: Finding[];
  /** False when git is unavailable, so the drift check could not run at all. */
  gitChecked: boolean;
  ok: boolean;
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd: root });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Pick the ref representing upstream. Prefers a real `upstream` remote, falls back to
 * `origin`, so both the fork-and-track and clone-directly workflows work.
 */
async function upstreamRef(root: string): Promise<string | null> {
  for (const ref of ["upstream/main", "upstream/master", "origin/main", "origin/master"]) {
    if ((await git(root, ["rev-parse", "--verify", "--quiet", ref])) !== null) return ref;
  }
  return null;
}

function inZone(path: string, zones: readonly string[]): boolean {
  return zones.some((z) => path.startsWith(z));
}

/** Which files differ from upstream, including uncommitted work. */
async function changedFiles(root: string, ref: string): Promise<string[]> {
  const committed = (await git(root, ["diff", "--name-only", `${ref}...HEAD`])) ?? "";
  const working = (await git(root, ["status", "--porcelain"])) ?? "";
  const fromStatus = working
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  return [...new Set([...committed.split("\n"), ...fromStatus].filter(Boolean))];
}

/** Packages in your zones must not claim the vendor's npm scope. */
async function checkUserPackageNames(root: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const zone of USER_ZONES) {
    const dir = join(root, zone);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pkgPath = join(dir, entry, "package.json");
      try {
        await access(pkgPath);
      } catch {
        continue;
      }
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { name?: string };
      if (pkg.name?.startsWith("@embody/")) {
        findings.push({
          level: "warn",
          message: `${zone}${entry} is named "${pkg.name}" — @embody/* is the vendor's npm scope, not yours.`,
          detail: [`Rename it to something unscoped, e.g. "${entry}", in ${zone}${entry}/package.json.`],
        });
      }
    }
  }
  return findings;
}

export async function runDoctor(root: string): Promise<DoctorReport> {
  const findings: Finding[] = [];

  const ref = await upstreamRef(root);
  const gitChecked = ref !== null;

  if (!gitChecked) {
    findings.push({
      level: "warn",
      message: "Could not determine an upstream ref, so upgrade safety was NOT checked.",
      detail: [
        "This needs a git repository with an upstream remote:",
        "  git remote add upstream <embody repo url> && git fetch upstream",
      ],
    });
  } else {
    const changed = await changedFiles(root, ref);
    const drifted = changed.filter((f) => inZone(f, UPSTREAM_ZONES));
    if (drifted.length) {
      findings.push({
        level: "error",
        message: `${drifted.length} file(s) modified in upstream-owned directories — these will conflict on upgrade.`,
        detail: [
          ...drifted.map((f) => `  ${f}`),
          "",
          "Move the change into custom/ (a plugin) or deploy/ (your deployment).",
          "If it genuinely belongs upstream, contribute it there instead of carrying a local edit.",
        ],
      });
    }
  }

  findings.push(...(await checkUserPackageNames(root)));

  return {
    findings,
    gitChecked,
    ok: !findings.some((f) => f.level === "error"),
  };
}

/** Render a report for a terminal. Returns the process exit code. */
export function formatReport(report: DoctorReport): { text: string; code: number } {
  const lines: string[] = [];
  for (const f of report.findings) {
    lines.push(`${f.level === "error" ? "✗" : "!"} ${f.message}`);
    if (f.detail) lines.push(...f.detail);
    lines.push("");
  }
  if (report.ok && report.gitChecked && report.findings.length === 0) {
    lines.push("✓ All changes are confined to custom/ and deploy/.");
    lines.push("  `git merge upstream/main` should apply cleanly.");
  } else if (report.ok) {
    lines.push("✓ No upgrade-blocking problems found.");
  }
  return { text: lines.join("\n") + "\n", code: report.ok ? 0 : 1 };
}
