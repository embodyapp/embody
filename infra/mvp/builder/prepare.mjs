// Trusted prepare step (first build step, recipe image, has network, never runs customer code).
// Fetches exactly the verified source, re-validates and extracts it, applies the input/lockfile
// policy, fetches dependencies WITHOUT running any lifecycle script, audits the lockfile and
// writes the SBOM. Its step output is read by gateway admission as a trusted record.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chown, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startFrameworkRegistry } from "./registry.mjs";

const { AbortSignal, clearTimeout, fetch, setTimeout } = globalThis;

const contracts = await import(
  pathToFileURL(
    process.env.EMBODY_CONTRACTS_MODULE ??
      "/embody/tools/node_modules/@embody/cloud-contracts/dist/index.js",
  ).href
);
const { BUILD_RECIPE, BuildPolicyError, checkBuildInputs, extractSourceArchive, lockfileSbom } =
  contracts;
const W = process.env.EMBODY_WORKSPACE ?? "/workspace";
const OUT = process.env.BUILDER_OUTPUT ?? "/builder/outputs";
const FRAMEWORK_DIR = process.env.EMBODY_FRAMEWORK_DIR ?? "/embody/framework";
const env = process.env;

async function stepOutput(value) {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "output"), JSON.stringify(value));
}
async function reject(code, detail) {
  // Names fields/files only, never file content or the source URL.
  console.log(`embody: rejected ${code}: ${detail}`);
  await stepOutput({ rejected: code });
  process.exit(1);
}
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-8_000_000)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-64_000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
async function chownTree(path) {
  const info = await lstat(path);
  await chown(path, 1000, 1000).catch(() => undefined);
  if (info.isDirectory())
    for (const entry of await readdir(path)) await chownTree(join(path, entry));
}

for (const name of [
  "EMBODY_SOURCE_URL",
  "EMBODY_SOURCE_DIGEST",
  "EMBODY_SOURCE_BYTES",
  "EMBODY_APP_ID",
])
  if (!env[name]) await reject("SOURCE_INVALID", `${name} missing`);
const expectedBytes = Number(env.EMBODY_SOURCE_BYTES);
if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > 10 * 1024 * 1024)
  await reject("SOURCE_INVALID", "source size");

// 1. Source: exactly the verified bytes.
let archive;
try {
  const response = await fetch(env.EMBODY_SOURCE_URL, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    await reject(
      response.status >= 500 ? "DEPENDENCY_UNAVAILABLE" : "SOURCE_INVALID",
      `source fetch ${response.status}`,
    );
  archive = new Uint8Array(await response.arrayBuffer());
} catch {
  await reject("DEPENDENCY_UNAVAILABLE", "source fetch failed");
}
if (archive.byteLength !== expectedBytes || sha(archive) !== env.EMBODY_SOURCE_DIGEST)
  await reject("SOURCE_INVALID", "source digest mismatch");
const src = join(W, "src");
let summary;
try {
  summary = await extractSourceArchive(archive, src);
} catch {
  await reject("SOURCE_INVALID", "source archive invalid");
}

// 2. Input and lockfile policy (data only).
const framework = JSON.parse(await readFile(join(FRAMEWORK_DIR, "framework.json"), "utf8"));
let inputs;
try {
  const packageJson = await readFile(join(src, "package.json"), "utf8");
  const lockfile = await readFile(join(src, BUILD_RECIPE.lockfile), "utf8").catch(() => undefined);
  inputs = checkBuildInputs({ packageJson, lockfile, framework });
} catch (error) {
  if (error instanceof BuildPolicyError) await reject(error.code, error.detail);
  throw error;
}

// 3. Dependencies into a store, with no lifecycle scripts and no customer config.
const registry = await startFrameworkRegistry(FRAMEWORK_DIR, framework);
const home = join(W, "prepare-home");
await mkdir(home, { recursive: true });
const pnpmEnv = { PATH: env.PATH, HOME: home, CI: "true", COREPACK_ENABLE_STRICT: "0" };
const pnpmArgs = [
  "--store-dir",
  join(W, "store"),
  `--config.registry=${BUILD_RECIPE.publicRegistry}`,
  `--config.@embody:registry=${registry.url}`,
  "--config.ignore-pnpmfile=true",
  "--config.ignore-scripts=true",
];
try {
  const fetched = await run("pnpm", ["fetch", "--frozen-lockfile", ...pnpmArgs], {
    cwd: src,
    env: pnpmEnv,
    timeoutMs: 100_000,
  });
  if (fetched.code !== 0) {
    console.log(fetched.stderr.slice(-4000).replace(/https?:\/\/127\.0\.0\.1:\d+/g, "<framework>"));
    await reject(
      /ERR_PNPM_(LOCKFILE|OUTDATED|TARBALL_INTEGRITY|BAD_TARBALL)/.test(
        fetched.stdout + fetched.stderr,
      )
        ? "LOCKFILE_REJECTED"
        : "DEPENDENCY_UNAVAILABLE",
      "dependency fetch failed",
    );
  }
  // 4. Vulnerability policy over the locked set (public advisory database).
  const audit = await run("pnpm", ["audit", "--json", ...pnpmArgs], {
    cwd: src,
    env: pnpmEnv,
    timeoutMs: 60_000,
  });
  let counts;
  try {
    const parsed = JSON.parse(audit.stdout);
    const v = parsed?.metadata?.vulnerabilities ?? {};
    counts = {
      critical: Number(v.critical ?? 0),
      high: Number(v.high ?? 0),
      moderate: Number(v.moderate ?? 0),
      low: Number(v.low ?? 0),
    };
    if (!Object.values(counts).every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error();
  } catch {
    await reject("DEPENDENCY_UNAVAILABLE", "dependency audit unavailable");
  }
  if (contracts.auditBlocks(counts)) {
    console.log(`embody: audit ${JSON.stringify(counts)}`);
    await reject("VULNERABILITY_POLICY", "blocking advisories");
  }
  // pnpm fetch may create a virtual store; the sandbox installs from the store itself.
  await rm(join(src, "node_modules"), { recursive: true, force: true });
  const sbom = lockfileSbom(inputs, {
    appId: env.EMBODY_APP_ID,
    sourceDigest: env.EMBODY_SOURCE_DIGEST,
  });
  await mkdir(join(W, "inputs"), { recursive: true });
  await writeFile(join(W, "inputs", "sbom.json"), sbom);
  await chownTree(src);
  await chownTree(join(W, "store"));
  await stepOutput({
    recipe: BUILD_RECIPE.id,
    sourceDigest: env.EMBODY_SOURCE_DIGEST,
    treeDigest: summary.treeDigest,
    lockfileDigest: inputs.lockfileDigest,
    sbomDigest: sha(sbom),
    packages: inputs.packages.length,
    audit: counts,
  });
  console.log(
    `embody: prepared ${inputs.packages.length} locked packages; audit ${JSON.stringify(counts)}`,
  );
} finally {
  await registry.close();
}
