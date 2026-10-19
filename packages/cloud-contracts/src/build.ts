import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  AppIdSchema,
  DeploymentIdSchema,
  DigestSchema,
  HOSTED_PROFILE,
  WorkspaceIdSchema,
} from "./profile.js";

/**
 * M11 build recipe. One pinned recipe, no customer Dockerfiles: the platform installs with a
 * frozen pnpm lockfile, runs the project's `build` script and extracts the manifest inside a
 * no-network, unprivileged, resource-limited sandbox. Everything the sandbox writes is data
 * that trusted code outside it validates. See docs/mvp/BUILDS.md.
 */
export const BUILD_RECIPE = Object.freeze({
  id: "embody-node24-pnpm-v1",
  nodeMajor: 24 as const,
  pnpmVersion: "11.25.0",
  lockfile: "pnpm-lock.yaml",
  lockfileVersion: "9.0",
  /** Compiled config the sandbox imports (scaffold `tsc` layout); evaluated nowhere else. */
  configOutput: "dist/embody.config.js",
  entrypoint: "dist/src/index.js",
  /** Whole provider build (Cloud Build `timeout`). */
  maxBuildSeconds: HOSTED_PROFILE.maxBuildSeconds,
  /** Sandbox wall clock; leaves time for fetch and assembly inside the build timeout. */
  sandboxSeconds: 420,
  maxOutputBytes: HOSTED_PROFILE.maxBuildOutputBytes,
  maxManifestBytes: 256 * 1024,
  maxLogBytes: 1024 * 1024,
  maxPackageJsonBytes: 64 * 1024,
  maxLockfileBytes: 5 * 1024 * 1024,
  maxLockedPackages: 3_000,
  sandbox: Object.freeze({
    network: "none",
    /** uid 1000, primary gid 1000, in the pinned Node base image. A bare name: the Cloud Build daemon resolves the whole `--user` string as one passwd entry when copying into the container. */
    user: "node",
    memoryBytes: 4 * 1024 * 1024 * 1024,
    pids: 512,
    cpus: 2,
    openFiles: 4_096,
  }),
  /** Framework scope served only from the recipe's bundled packages, never a public registry. */
  frameworkScope: "@embody",
  publicRegistry: "https://registry.npmjs.org/",
  /** Vulnerability policy: lockfile audit severities that block admission. */
  blockingSeverities: Object.freeze(["critical"] as const),
});

export const HOSTED_PROFILES = Object.freeze(["request-only-v1", "durable-v1"] as const);
export type HostedProfile = (typeof HOSTED_PROFILES)[number];

const ArtifactIdSchema = z.string().regex(/^art_[a-z0-9]{8,64}$/);
const target = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-z][A-Za-z0-9_-]*(\.[a-z][A-Za-z0-9_-]*)+$/);
const semver = z
  .string()
  .max(100)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
export const EventNameSchema = target;

/**
 * Untrusted build output written by the sandbox (`manifest.json`). The sandbox runs customer
 * code, so every field is a claim: trusted admission re-derives the profile from the catalog
 * and treats `preflight` only as an extra reason to reject.
 */
export const BuildOutputSchema = z.strictObject({
  format: z.literal("embody-build-output-v1"),
  recipe: z.literal(BUILD_RECIPE.id),
  nodeVersion: z.string().regex(/^v24\.\d{1,3}\.\d{1,3}$/),
  appId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  appVersion: semver,
  preflight: z.strictObject({ requestOnly: z.boolean(), durable: z.boolean() }),
  /** Event names the app declares it publishes (M21 relays only declared names). */
  publishes: z.array(EventNameSchema).max(200),
  /** `compileManifest` output; validated by the gateway with `@embody/core` appManifestSchema. */
  catalog: z.unknown(),
});
export type BuildOutput = z.infer<typeof BuildOutputSchema>;

export const WorkflowDefinitionSchema = z.strictObject({
  target,
  version: z.string().min(1).max(100),
  steps: z
    .array(z.strictObject({ name: z.string().min(1).max(100), dependsOn: z.array(z.string()) }))
    .min(1)
    .max(50),
});
/**
 * Trusted, normalized artifact manifest (M11 manifest amendment for M19–M21): the hosted
 * profile, published event names, subscriptions and versioned workflow definitions. Derived by
 * the gateway from a validated build output; M13 binds subscriptions at promotion, M21 checks
 * producers against `publishes`, M19/M13 keep running workflow versions.
 */
export const ArtifactManifestSchema = z
  .strictObject({
    version: z.literal(1),
    profile: z.enum(HOSTED_PROFILES),
    recipe: z.literal(BUILD_RECIPE.id),
    nodeMajor: z.literal(BUILD_RECIPE.nodeMajor),
    appId: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    appVersion: semver,
    entrypoint: z.literal(BUILD_RECIPE.entrypoint),
    publishes: z.array(EventNameSchema).max(200),
    subscriptions: z.array(EventNameSchema).max(200),
    workflows: z.array(WorkflowDefinitionSchema).max(100),
    catalogDigest: DigestSchema,
  })
  .refine(
    (m) =>
      m.profile === "durable-v1" ||
      (m.publishes.length === 0 && m.subscriptions.length === 0 && m.workflows.length === 0),
    "Request-only artifacts publish, subscribe and run workflows nowhere",
  );
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

export const BuildErrorCodeSchema = z.enum([
  "SOURCE_INVALID",
  "INPUT_REJECTED",
  "LOCKFILE_REJECTED",
  "UNSUPPORTED_RUNTIME",
  "UNSUPPORTED_PROFILE",
  "CAPABILITY_MISMATCH",
  "VULNERABILITY_POLICY",
  "BUILD_FAILED",
  "BUILD_TIMEOUT",
  "OUTPUT_LIMIT",
  "MANIFEST_INVALID",
  "MANIFEST_MISMATCH",
  "IMAGE_INVALID",
  "PROVENANCE_INVALID",
  "DEPENDENCY_UNAVAILABLE",
]);
export type BuildErrorCode = z.infer<typeof BuildErrorCodeSchema>;
const buildMessages: Record<BuildErrorCode, string> = {
  SOURCE_INVALID: "Source is not a verified upload for this app.",
  INPUT_REJECTED: "package.json is not supported by the hosted build recipe.",
  LOCKFILE_REJECTED: "pnpm-lock.yaml is missing, stale or resolves packages outside the registry.",
  UNSUPPORTED_RUNTIME: "Use the platform-supported Embody framework packages and Node 24.",
  UNSUPPORTED_PROFILE: "The app does not fit the declared hosted profile.",
  CAPABILITY_MISMATCH: "Declared capabilities do not match the built app.",
  VULNERABILITY_POLICY: "Dependencies have blocking vulnerabilities; update them and redeploy.",
  BUILD_FAILED: "Build failed; inspect authorized deployment logs.",
  BUILD_TIMEOUT: "Build exceeded the time limit.",
  OUTPUT_LIMIT: "Build output exceeds the size limit.",
  MANIFEST_INVALID: "Build did not produce a valid app manifest.",
  MANIFEST_MISMATCH: "Build output does not match the build record.",
  IMAGE_INVALID: "Build did not produce the expected image.",
  PROVENANCE_INVALID: "Build record does not match the platform build recipe.",
  DEPENDENCY_UNAVAILABLE: "Build dependency unavailable; retry the deployment.",
};
/** Transient: the deployment controller (M12) may retry the build stage. */
export const RETRYABLE_BUILD_ERRORS: ReadonlySet<BuildErrorCode> = new Set([
  "DEPENDENCY_UNAVAILABLE",
]);
export const BuildErrorSchema = z
  .strictObject({ code: BuildErrorCodeSchema, message: z.string() })
  .refine((value) => value.message === buildMessages[value.code], "Only fixed messages");
export function buildError(code: BuildErrorCode) {
  return { code, message: buildMessages[code] };
}
export class BuildPolicyError extends Error {
  public constructor(
    public readonly code: BuildErrorCode,
    /** Operator-facing detail: file or field names, never file content. */
    public readonly detail: string,
  ) {
    super(buildMessages[code]);
    this.name = "BuildPolicyError";
  }
}

/** Public artifact status (deployment logs/status views); no provider names or URLs. */
export const ArtifactStatusSchema = z
  .strictObject({
    version: z.literal(1),
    workspaceId: WorkspaceIdSchema,
    appId: AppIdSchema,
    deploymentId: DeploymentIdSchema,
    artifactId: ArtifactIdSchema,
    attempt: z.number().int().min(1).max(HOSTED_PROFILE.maxStageAttempts),
    state: z.enum(["building", "admitted", "rejected"]),
    sourceDigest: DigestSchema,
    imageDigest: DigestSchema.optional(),
    manifest: ArtifactManifestSchema.optional(),
    error: BuildErrorSchema.optional(),
  })
  .refine(
    (s) => (s.state === "rejected") === (s.error !== undefined),
    "Only rejections carry errors",
  )
  .refine(
    (s) => (s.state === "admitted") === (s.imageDigest !== undefined && s.manifest !== undefined),
    "Admitted artifacts carry their image digest and manifest",
  );
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

// ---------------------------------------------------------------------------------------------
// Build input policy. Runs as trusted code before any customer code: package.json and the
// lockfile are parsed as data, never executed.

export interface FrameworkPackage {
  readonly name: string;
  readonly version: string;
  /** `sha512-…` integrity of the bundled tarball the recipe serves. */
  readonly integrity: string;
}
export interface LockedPackage {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
}
export interface BuildInputs {
  readonly packageJsonDigest: string;
  readonly lockfileDigest: string;
  readonly packages: readonly LockedPackage[];
}

const SPEC_FORBIDDEN = /[:/\\]|^\s*[.~]|^\s*$/;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const FORBIDDEN_PACKAGE_FIELDS = [
  "devEngines",
  "workspaces",
  "pnpm",
  "bundleDependencies",
  "bundledDependencies",
  "overrides",
  "resolutions",
  "patchedDependencies",
];
const FORBIDDEN_LOCK_FIELDS = ["overrides", "patchedDependencies", "pnpmfileChecksum", "catalogs"];
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const PACKAGE_KEY =
  /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)$/;
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
interface Doc {
  [key: string]: unknown;
  type?: unknown;
  scripts?: unknown;
  build?: unknown;
  packageManager?: unknown;
  dependencies?: unknown;
  lockfileVersion?: unknown;
  importers?: unknown;
  packages?: unknown;
  version?: unknown;
  specifier?: unknown;
  resolution?: unknown;
  integrity?: unknown;
}
const isRecord = (value: unknown): value is Doc =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks package.json and pnpm-lock.yaml against the recipe. Every locked package must come
 * from the registry with sha512 integrity (no tarball URLs, git, directories or links), and the
 * framework scope must resolve exactly to the recipe's bundled packages.
 */
export function checkBuildInputs(input: {
  readonly packageJson: string;
  readonly lockfile: string | undefined;
  readonly framework: readonly FrameworkPackage[];
}): BuildInputs {
  const reject = (code: BuildErrorCode, detail: string): never => {
    throw new BuildPolicyError(code, detail);
  };
  if (Buffer.byteLength(input.packageJson) > BUILD_RECIPE.maxPackageJsonBytes)
    reject("INPUT_REJECTED", "package.json too large");
  let pkg: unknown;
  try {
    pkg = JSON.parse(input.packageJson);
  } catch {
    reject("INPUT_REJECTED", "package.json is not JSON");
  }
  if (!isRecord(pkg)) return reject("INPUT_REJECTED", "package.json is not an object");
  for (const field of FORBIDDEN_PACKAGE_FIELDS)
    if (field in pkg) reject("INPUT_REJECTED", `package.json field ${field} is not supported`);
  if (pkg.type !== "module") reject("INPUT_REJECTED", 'package.json must set "type": "module"');
  if (!isRecord(pkg.scripts) || typeof pkg.scripts.build !== "string")
    reject("INPUT_REJECTED", "package.json needs a build script");
  if (pkg.packageManager !== undefined && pkg.packageManager !== `pnpm@${BUILD_RECIPE.pnpmVersion}`)
    reject("UNSUPPORTED_RUNTIME", `packageManager must be pnpm@${BUILD_RECIPE.pnpmVersion}`);
  const declared = new Map<string, string>();
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (deps === undefined) continue;
    if (!isRecord(deps)) return reject("INPUT_REJECTED", `${field} is not an object`);
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string" || SPEC_FORBIDDEN.test(spec) || spec.length > 100)
        reject("INPUT_REJECTED", `${field}.${name} must be a registry version range`);
      if (field !== "peerDependencies") declared.set(name, spec as string);
    }
  }
  const frameworkByName = new Map(input.framework.map((p) => [p.name, p]));
  for (const required of [
    `${BUILD_RECIPE.frameworkScope}/core`,
    `${BUILD_RECIPE.frameworkScope}/host`,
  ])
    if (!isRecord(pkg.dependencies) || !(required in pkg.dependencies))
      reject("UNSUPPORTED_RUNTIME", `dependencies must include ${required}`);

  if (input.lockfile === undefined) return reject("LOCKFILE_REJECTED", "pnpm-lock.yaml missing");
  if (Buffer.byteLength(input.lockfile) > BUILD_RECIPE.maxLockfileBytes)
    reject("LOCKFILE_REJECTED", "pnpm-lock.yaml too large");
  let lock: unknown;
  try {
    // No aliases or custom tags: the lockfile is plain data.
    lock = parseYaml(input.lockfile, { maxAliasCount: 0, customTags: [], uniqueKeys: true });
  } catch {
    reject("LOCKFILE_REJECTED", "pnpm-lock.yaml is not valid YAML");
  }
  if (!isRecord(lock)) return reject("LOCKFILE_REJECTED", "pnpm-lock.yaml is not a mapping");
  if (String(lock.lockfileVersion) !== BUILD_RECIPE.lockfileVersion)
    reject("LOCKFILE_REJECTED", `lockfileVersion must be ${BUILD_RECIPE.lockfileVersion}`);
  for (const field of FORBIDDEN_LOCK_FIELDS)
    if (field in lock) reject("LOCKFILE_REJECTED", `lockfile field ${field} is not supported`);
  const importers = lock.importers;
  if (!isRecord(importers) || Object.keys(importers).join() !== ".")
    return reject("LOCKFILE_REJECTED", "lockfile must have exactly one importer");
  const root = importers["."];
  if (!isRecord(root)) return reject("LOCKFILE_REJECTED", "lockfile importer is invalid");
  const imported = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = root[field];
    if (deps === undefined) continue;
    if (!isRecord(deps)) return reject("LOCKFILE_REJECTED", `importer ${field} invalid`);
    for (const [name, entry] of Object.entries(deps)) {
      if (!isRecord(entry) || typeof entry.version !== "string")
        reject("LOCKFILE_REJECTED", `importer ${name} invalid`);
      // Peer suffixes such as `4.1.11(@types/node@22.20.1)` are not part of the version.
      const resolved = (entry as { version: string }).version.split("(")[0]!;
      if (!/^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(resolved))
        reject("LOCKFILE_REJECTED", `${name} is not a registry package`);
      if (declared.get(name) !== (entry as { specifier?: unknown }).specifier)
        reject("LOCKFILE_REJECTED", `lockfile is stale for ${name}`);
      imported.add(name);
    }
  }
  for (const name of declared.keys())
    if (!imported.has(name)) reject("LOCKFILE_REJECTED", `lockfile is stale for ${name}`);
  const packages = lock.packages ?? {};
  if (!isRecord(packages)) return reject("LOCKFILE_REJECTED", "lockfile packages invalid");
  const keys = Object.keys(packages);
  if (keys.length > BUILD_RECIPE.maxLockedPackages)
    reject("LOCKFILE_REJECTED", "too many locked packages");
  const locked: LockedPackage[] = [];
  for (const key of keys) {
    const match = PACKAGE_KEY.exec(key);
    if (!match)
      return reject("LOCKFILE_REJECTED", `${key.slice(0, 120)} is not a registry package`);
    const entry = packages[key];
    if (!isRecord(entry) || !isRecord(entry.resolution))
      return reject("LOCKFILE_REJECTED", `${key} has no resolution`);
    const resolution = entry.resolution;
    if (
      Object.keys(resolution).join() !== "integrity" ||
      typeof resolution.integrity !== "string" ||
      !INTEGRITY.test(resolution.integrity)
    )
      reject("LOCKFILE_REJECTED", `${key} must resolve from the registry with sha512 integrity`);
    const [, name, version] = match as unknown as [string, string, string];
    const integrity = resolution.integrity as string;
    if (name.startsWith(`${BUILD_RECIPE.frameworkScope}/`)) {
      const bundled = frameworkByName.get(name);
      if (!bundled || bundled.version !== version || bundled.integrity !== integrity)
        reject("UNSUPPORTED_RUNTIME", `${name}@${version} is not the platform framework build`);
    }
    locked.push({ name, version, integrity });
  }
  locked.sort((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
  return {
    packageJsonDigest: sha(input.packageJson),
    lockfileDigest: sha(input.lockfile),
    packages: locked,
  };
}

/** Deterministic CycloneDX 1.5 SBOM of the locked dependency set (lockfile data only). */
export function lockfileSbom(
  inputs: BuildInputs,
  subject: { readonly appId: string; readonly sourceDigest: string },
): string {
  const components = inputs.packages.map((p) => ({
    type: "library",
    name: p.name,
    version: p.version,
    purl: `pkg:npm/${p.name.replace("@", "%40")}@${p.version}`,
    hashes: [
      {
        alg: "SHA-512",
        content: Buffer.from(p.integrity.slice("sha512-".length), "base64").toString("hex"),
      },
    ],
  }));
  return `${JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: { type: "application", name: subject.appId, version: subject.sourceDigest },
      tools: [{ name: BUILD_RECIPE.id }],
    },
    components,
  })}\n`;
}

export interface AuditSummary {
  readonly critical: number;
  readonly high: number;
  readonly moderate: number;
  readonly low: number;
}
/** Vulnerability policy over a lockfile audit summary; scanning is not proof of safety. */
export function auditBlocks(summary: AuditSummary): boolean {
  return BUILD_RECIPE.blockingSeverities.some((severity) => summary[severity] > 0);
}

// ---------------------------------------------------------------------------------------------
// Log redaction. Build logs contain customer output; they are bounded and redacted before any
// authorized reader sees them (M15 serves them). Redaction is defense in depth: builds receive
// no platform secrets.

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(X-Goog-Signature|X-Goog-Credential|sig|signature|token|access_token|password|secret)=[^\s&"']+/gi,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^\s"']+/gi,
  /https:\/\/storage\.googleapis\.com\/[^\s"']*X-Goog-[^\s"']*/g,
];
/**
 * Bounds a build log to `maxLogBytes` and replaces known secret values (`canaries`: values the
 * platform knows, such as a signed source URL) and secret-shaped strings with `[REDACTED]`.
 */
export function redactBuildLog(log: string, canaries: readonly string[] = []): string {
  // Known values are replaced before truncation, so a value cut by the bound cannot leak a prefix.
  let text = log;
  for (const canary of canaries) {
    if (canary.length < 8) continue;
    text = text.split(canary).join("[REDACTED]");
    const encoded = encodeURIComponent(canary);
    if (encoded !== canary) text = text.split(encoded).join("[REDACTED]");
  }
  text = Buffer.from(text).subarray(0, BUILD_RECIPE.maxLogBytes).toString("utf8");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  return Buffer.byteLength(log) > BUILD_RECIPE.maxLogBytes ? `${text}\n[TRUNCATED]\n` : text;
}
