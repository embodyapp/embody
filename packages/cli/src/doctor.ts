/**
 * `embody doctor` — the checks that catch the failures an app cannot see itself.
 *
 * This used to police a directory boundary, because embody was distributed as a repo
 * you cloned and upgraded with `git merge upstream/main`. Under npm distribution the
 * runtime lives in node_modules, there is no boundary to drift across, and that check
 * has nothing left to say.
 *
 * What replaces it is the failure mode a plugin ecosystem actually has. A plugin
 * registers hooks against the `@embody/plugin-sdk` it resolved. If an app ends up with
 * two copies of the SDK, the plugin registers against a different registry than the one
 * the kernel boots — and then it installs cleanly, logs nothing, and silently never
 * fires. Nothing in a stack trace points at it, because nothing throws.
 *
 * Everything here is advisory: it reports findings and sets an exit code, and never
 * touches the working tree.
 */
import { readFile, readdir, access, realpath } from "node:fs/promises";
import { join } from "node:path";

export interface Finding {
  level: "error" | "warn";
  message: string;
  detail?: string[];
}

export interface DoctorReport {
  findings: Finding[];
  /** How many checks actually ran, so a report can say what it did NOT look at. */
  checksRun: string[];
  ok: boolean;
}

/** The one package every plugin must share exactly one copy of. */
const SDK = "@embody/plugin-sdk";

interface Manifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  keywords?: string[];
}

async function readManifest(path: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/**
 * Every distinct on-disk copy of a package reachable from `root`.
 *
 * Resolved through realpath because pnpm's node_modules is a forest of symlinks into
 * a content-addressed store: the same physical package appears at many paths, and only
 * two different real directories mean two different module instances.
 */
async function copiesOf(root: string, pkgName: string): Promise<Map<string, string>> {
  const found = new Map<string, string>(); // realpath -> version
  const seen = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    if (!entries.includes("node_modules")) return;

    const nm = join(dir, "node_modules");
    const candidate = join(nm, pkgName, "package.json");
    try {
      await access(candidate);
      const real = await realpath(join(nm, pkgName));
      if (!found.has(real)) {
        const m = await readManifest(candidate);
        found.set(real, m?.version ?? "unknown");
      }
    } catch {
      /* not installed at this level */
    }

    // Descend into installed packages, which may carry their own nested copies.
    let nested: string[];
    try {
      nested = await readdir(nm);
    } catch {
      return;
    }
    for (const entry of nested) {
      if (entry === ".bin" || entry === ".pnpm") continue;
      const sub = join(nm, entry);
      let real: string;
      try {
        real = await realpath(sub);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      if (entry.startsWith("@")) {
        let scoped: string[];
        try {
          scoped = await readdir(sub);
        } catch {
          continue;
        }
        for (const s of scoped) await walk(join(sub, s), depth + 1);
      } else {
        await walk(sub, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return found;
}

/** The check that nothing else can perform: is there exactly one SDK instance? */
async function checkSingleSdkInstance(root: string): Promise<Finding[]> {
  const copies = await copiesOf(root, SDK);
  if (copies.size <= 1) return [];
  return [
    {
      level: "error",
      message: `${copies.size} separate copies of ${SDK} are installed.`,
      detail: [
        ...[...copies].map(([path, version]) => `  ${version}  ${path}`),
        "",
        "A plugin registers its hooks against the SDK instance it resolved. With more",
        "than one, a plugin can register against a registry the kernel never boots — so",
        "it loads without error and its rules silently never run.",
        "",
        `Fix: make sure every plugin declares ${SDK} as a peerDependency (not a`,
        "dependency), and that their ranges overlap so the installer can dedupe them.",
      ],
    },
  ];
}

/** A plugin that depends on the SDK rather than peering it is what causes the above. */
async function checkPluginDependencyShape(root: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const nm = join(root, "node_modules");
  const roots: string[] = [];
  for (const scope of ["@embody", ""]) {
    const dir = scope ? join(nm, scope) : nm;
    try {
      for (const entry of await readdir(dir)) {
        if (entry.startsWith(".") || entry.startsWith("@")) continue;
        roots.push(join(dir, entry));
      }
    } catch {
      /* nothing installed under this scope */
    }
  }

  for (const dir of roots) {
    const m = await readManifest(join(dir, "package.json"));
    if (!m?.name || !(m.keywords ?? []).includes("embody-plugin")) continue;
    if (m.dependencies?.[SDK]) {
      findings.push({
        level: "warn",
        message: `${m.name} declares ${SDK} as a dependency.`,
        detail: [
          `It must be a peerDependency, or the installer may give ${m.name} its own`,
          "copy of the SDK and its hooks will never reach your kernel.",
        ],
      });
    }
  }
  return findings;
}

/** Two plugins owning the same Postgres schema will overwrite each other's tables. */
function checkSchemaCollisions(
  plugins: { id: string; schema?: string }[],
): Finding[] {
  const bySchema = new Map<string, string[]>();
  for (const p of plugins) {
    if (!p.schema) continue;
    bySchema.set(p.schema, [...(bySchema.get(p.schema) ?? []), p.id]);
  }
  return [...bySchema]
    .filter(([, ids]) => ids.length > 1)
    .map(([schema, ids]) => ({
      level: "error" as const,
      message: `Plugins ${ids.join(", ")} all claim the Postgres schema "${schema}".`,
      detail: [
        "Each plugin owns its schema outright and migrates it independently, so two",
        "claiming the same one will overwrite each other's tables.",
      ],
    }));
}

export interface DoctorOptions {
  /** Path to the app's config. Skipped entirely when absent. */
  configPath?: string;
  /** Injected so this module needs no dependency on the host. */
  loadPlugins?: (
    configPath: string,
  ) => Promise<{ id: string; schema?: string }[]>;
}

export async function runDoctor(
  root: string,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const findings: Finding[] = [];
  const checksRun: string[] = [];

  findings.push(...(await checkSingleSdkInstance(root)));
  checksRun.push("one shared @embody/plugin-sdk instance");

  findings.push(...(await checkPluginDependencyShape(root)));
  checksRun.push("plugins peer-depend on the SDK");

  if (options.configPath && options.loadPlugins) {
    try {
      const plugins = await options.loadPlugins(options.configPath);
      checksRun.push(`config loads (${plugins.length} plugins)`);
      findings.push(...checkSchemaCollisions(plugins));
      checksRun.push("no two plugins claim one schema");
    } catch (err) {
      findings.push({
        level: "error",
        message: `Could not load ${options.configPath}.`,
        detail: [String(err instanceof Error ? err.message : err)],
      });
    }
  }

  return {
    findings,
    checksRun,
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
  if (report.findings.length === 0) {
    lines.push("✓ No problems found.");
    lines.push(...report.checksRun.map((c) => `  checked: ${c}`));
  }
  return { text: lines.join("\n") + "\n", code: report.ok ? 0 : 1 };
}
