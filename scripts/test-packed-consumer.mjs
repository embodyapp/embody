import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { once } from "node:events";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

const packages = JSON.parse(
  execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
    encoding: "utf8",
  }),
).filter(
  (entry) =>
    entry.path?.includes("/packages/") &&
    (entry.name?.startsWith("@embody/") || entry.name === "create-embody-app"),
);
const temporary = mkdtempSync(join(tmpdir(), "embody-consumer-"));
const tarballs = join(temporary, "tarballs");
const bootstrap = join(temporary, "bootstrap");
try {
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(bootstrap, { recursive: true });
  const packed = new Map();
  for (const pkg of packages) {
    const output = JSON.parse(
      execFileSync("pnpm", ["pack", "--json", "--pack-destination", tarballs], {
        cwd: pkg.path,
        encoding: "utf8",
      }),
    );
    const record = Array.isArray(output) ? output[0] : output;
    if (!record?.filename) throw new Error(`pnpm pack did not return a filename for ${pkg.name}`);
    packed.set(
      pkg.name,
      isAbsolute(record.filename) ? record.filename : resolve(pkg.path, record.filename),
    );
  }

  writeFileSync(
    join(bootstrap, "package.json"),
    JSON.stringify({ name: "embody-release-bootstrap", private: true }, null, 2),
  );
  const scaffolder = packed.get("create-embody-app");
  if (!scaffolder) throw new Error("Missing create-embody-app tarball");
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", scaffolder], {
    cwd: bootstrap,
  });
  run(
    process.execPath,
    [join(bootstrap, "node_modules/create-embody-app/dist/bin.js"), "public-smoke", "--no-install"],
    { cwd: temporary },
  );

  const app = join(temporary, "public-smoke");
  const generatedPath = join(app, "package.json");
  const generated = JSON.parse(readFileSync(generatedPath, "utf8"));
  generated.dependencies ??= {};
  generated.devDependencies ??= {};
  for (const name of packed.keys()) {
    delete generated.dependencies[name];
    delete generated.devDependencies[name];
  }
  writeFileSync(generatedPath, `${JSON.stringify(generated, null, 2)}\n`);
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: app });

  // npm Arborist cannot reliably construct one graph from multiple mutually dependent
  // tarball arguments. Install in dependency order, as a registry exposes each package.
  const installOrder = [
    "@embody/core",
    "@embody/storage",
    "@embody/auth",
    "@embody/mcp",
    "@embody/host",
    "@embody/gateway",
    "@embody/cli",
    "@embody/testing",
    "create-embody-app",
  ];
  for (const name of installOrder) {
    const tarball = packed.get(name);
    if (!tarball) throw new Error(`Missing ${name} tarball`);
    run(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        ...(name === "@embody/testing" ? ["--save-dev"] : []),
        tarball,
      ],
      { cwd: app },
    );
  }
  run("npm", ["run", "typecheck"], { cwd: app });
  run("npm", ["test"], { cwd: app });
  run("npm", ["run", "build"], { cwd: app });

  const child = spawn(process.execPath, ["dist/src/index.js"], {
    cwd: app,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const url = await new Promise((resolveUrl, reject) => {
    const timeout = setTimeout(() => reject(new Error("Generated app startup timed out")), 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", (chunk) => {
      clearTimeout(timeout);
      const value = String(chunk)
        .trim()
        .split(/\s+/u)
        .find((part) => part.startsWith("http"));
      if (value) resolveUrl(value);
      else reject(new Error(`Generated app did not print its URL: ${chunk}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Generated app exited ${code}: ${stderr}`));
    });
  });
  try {
    const health = await globalThis.fetch(new URL("/health", url));
    if (!health.ok) throw new Error(`Generated app health check returned ${health.status}`);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }

  if (generated.license !== "UNLICENSED") throw new Error("Generated app ownership changed");
  console.log("Packed external-consumer smoke passed.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
