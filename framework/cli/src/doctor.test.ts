/**
 * Doctor tests, against REAL git repositories in a temp directory.
 *
 * The whole value of `embody doctor` is that it catches an upgrade-breaking edit
 * before you merge, so testing it against a fake git would test nothing. Each case
 * builds a bare "upstream", clones it, edits something, and checks the verdict.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runDoctor } from "./doctor.ts";

const exec = promisify(execFile);

let dir: string;
let repo: string;
let seedDir: string;

const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "embody-doctor-"));
  const origin = join(dir, "upstream.git");
  const seed = join(dir, "seed");
  seedDir = seed;
  repo = join(dir, "clone");

  // Build an upstream repo with the five buckets populated.
  await mkdir(seed, { recursive: true });
  await writeFile(join(seed, "pnpm-workspace.yaml"), "packages:\n  - 'custom/*'\n");
  for (const [path, body] of [
    ["framework/kernel/index.ts", "export const version = 1;\n"],
    ["catalog/crm/index.ts", "export const crm = true;\n"],
    ["examples/service-crm/embody.config.ts", "export default {};\n"],
    ["custom/.keep", ""],
    ["deploy/.keep", ""],
  ] as const) {
    await mkdir(join(seed, path, ".."), { recursive: true });
    await writeFile(join(seed, path), body);
  }
  await git(seed, "init", "-q", "-b", "main");
  await git(seed, "config", "user.email", "t@t");
  await git(seed, "config", "user.name", "T");
  await git(seed, "add", ".");
  await git(seed, "commit", "-qm", "base");
  await exec("git", ["clone", "-q", "--bare", seed, origin]);
  await git(seed, "remote", "add", "origin", origin);

  await exec("git", ["clone", "-q", origin, repo]);
  await git(repo, "config", "user.email", "you@acme");
  await git(repo, "config", "user.name", "You");
  await git(repo, "remote", "add", "upstream", origin);
  await git(repo, "fetch", "-q", "upstream");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Add a package under one of the user zones. */
async function addUserPackage(name: string, zone = "custom", pkgName = name) {
  await mkdir(join(repo, zone, name), { recursive: true });
  await writeFile(
    join(repo, zone, name, "package.json"),
    JSON.stringify({ name: pkgName, private: true }, null, 2),
  );
}

describe("embody doctor", () => {
  it("passes on a clean clone", async () => {
    const report = await runDoctor(repo);
    expect(report.gitChecked).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("passes when your changes stay inside custom/ and deploy/", async () => {
    await addUserPackage("hipaa-rules");
    await addUserPackage("acme", "deploy", "acme-deployment");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "our customization");

    const report = await runDoctor(repo);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("FAILS and names the file when you edit an upstream-owned directory", async () => {
    await appendFile(join(repo, "catalog/crm/index.ts"), "export const hacked = true;\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "local hack");

    const report = await runDoctor(repo);
    expect(report.ok).toBe(false);
    const error = report.findings.find((f) => f.level === "error")!;
    expect(error.message).toMatch(/upstream-owned directories/);
    expect(error.detail?.join("\n")).toContain("catalog/crm/index.ts");
  });

  it("catches an uncommitted edit too, not just committed ones", async () => {
    await appendFile(join(repo, "framework/kernel/index.ts"), "// tweak\n");
    const report = await runDoctor(repo);
    expect(report.ok).toBe(false);
    expect(report.findings[0]!.detail?.join("\n")).toContain("framework/kernel/index.ts");
  });

  it("warns when a package in your zone claims the vendor's npm scope", async () => {
    await addUserPackage("rules", "custom", "@embody/custom-rules");
    const report = await runDoctor(repo);
    const warn = report.findings.find((f) => f.level === "warn")!;
    expect(warn.message).toMatch(/@embody\/\* is the vendor's npm scope/);
    // A naming smell should not block an upgrade.
    expect(report.ok).toBe(true);
  });

  /**
   * The claim the whole boundary exists to support. Not "doctor is happy" — an actual
   * upstream release landing on top of a customized clone without a conflict.
   */
  it("lets a real upstream release merge cleanly into a customized clone", async () => {
    // You customize your instance.
    await addUserPackage("hipaa-rules");
    await addUserPackage("acme", "deploy", "acme-deployment");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "our customization");

    // Upstream ships a release touching the framework and the catalog.
    await appendFile(join(seedDir, "framework/kernel/index.ts"), "export const added = 2;\n");
    await appendFile(join(seedDir, "catalog/crm/index.ts"), "export const feature = true;\n");
    await git(seedDir, "add", ".");
    await git(seedDir, "commit", "-qm", "upstream release");
    await git(seedDir, "push", "-q", "origin", "main");

    // You upgrade.
    await git(repo, "fetch", "-q", "upstream");
    await expect(git(repo, "merge", "--no-edit", "upstream/main")).resolves.toBeDefined();

    // No conflict markers anywhere, and the tree still holds both sides.
    const { stdout: conflicts } = await git(repo, "diff", "--name-only", "--diff-filter=U");
    expect(conflicts.trim()).toBe("");
    const { stdout: files } = await git(repo, "ls-files");
    expect(files).toContain("custom/hipaa-rules/package.json");
    expect(files).toContain("framework/kernel/index.ts");

    expect((await runDoctor(repo)).ok).toBe(true);
  });

  it("says plainly that it could NOT check, rather than reporting a false pass", async () => {
    const notGit = await mkdtemp(join(tmpdir(), "embody-nogit-"));
    const report = await runDoctor(notGit);
    expect(report.gitChecked).toBe(false);
    expect(report.findings[0]!.message).toMatch(/NOT checked/);
    await rm(notGit, { recursive: true, force: true });
  });
});
