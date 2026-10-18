import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ArtifactManifestSchema,
  ArtifactStatusSchema,
  BUILD_RECIPE,
  BuildErrorSchema,
  BuildOutputSchema,
  BuildPolicyError,
  CapabilitiesSchema,
  DeploymentSubmissionSchema,
  auditBlocks,
  buildError,
  checkBuildInputs,
  lockfileSbom,
  redactBuildLog,
  type FrameworkPackage,
} from "../src/index.js";

const integrity = (seed: string) =>
  `sha512-${createHash("sha512").update(seed).digest("base64")}`;
const framework: FrameworkPackage[] = [
  { name: "@embody/core", version: "0.1.0", integrity: integrity("core") },
  { name: "@embody/host", version: "0.1.0", integrity: integrity("host") },
];
const packageJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "app",
    type: "module",
    scripts: { build: "tsc -p tsconfig.json" },
    dependencies: { "@embody/core": "^0.1.0", "@embody/host": "^0.1.0", zod: "^4.0.0" },
    devDependencies: { typescript: "^5.9.3" },
    ...overrides,
  });
const lockfile = (packages = "", importer = "") => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@embody/core':
        specifier: ^0.1.0
        version: 0.1.0
      '@embody/host':
        specifier: ^0.1.0
        version: 0.1.0(@types/node@22.20.1)
      zod:
        specifier: ^4.0.0
        version: 4.1.0
${importer}    devDependencies:
      typescript:
        specifier: ^5.9.3
        version: 5.9.3

packages:

  '@embody/core@0.1.0':
    resolution: {integrity: ${framework[0]!.integrity}}

  '@embody/host@0.1.0':
    resolution: {integrity: ${framework[1]!.integrity}}

  zod@4.1.0:
    resolution: {integrity: ${integrity("zod")}}

  typescript@5.9.3:
    resolution: {integrity: ${integrity("ts")}}
    engines: {node: '>=14.17'}
    hasBin: true
${packages}
snapshots:

  zod@4.1.0: {}
`;
const reason = (fn: () => unknown) => {
  try {
    fn();
    return "accepted";
  } catch (error) {
    return error instanceof BuildPolicyError ? error.code : String(error);
  }
};
const check = (pkg = packageJson(), lock: string | undefined = lockfile()) =>
  checkBuildInputs({ packageJson: pkg, lockfile: lock, framework });

describe("M11 build input policy (trusted, data only)", () => {
  it("accepts a registry-only lockfile bound to the bundled framework", () => {
    const inputs = check();
    expect(inputs.packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      "@embody/core@0.1.0",
      "@embody/host@0.1.0",
      "typescript@5.9.3",
      "zod@4.1.0",
    ]);
    expect(inputs.lockfileDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  it("rejects unsupported package.json fields, scripts and dependency sources", () => {
    expect(reason(() => check(packageJson({ type: "commonjs" })))).toBe("INPUT_REJECTED");
    expect(reason(() => check(packageJson({ scripts: {} })))).toBe("INPUT_REJECTED");
    for (const field of ["workspaces", "pnpm", "bundleDependencies", "overrides", "resolutions"])
      expect(reason(() => check(packageJson({ [field]: {} })))).toBe("INPUT_REJECTED");
    for (const spec of [
      "file:../x",
      "link:../x",
      "git+https://example.com/x.git",
      "github:a/b",
      "https://example.com/x.tgz",
      "workspace:*",
      "npm:other@1",
      "./local",
      "",
    ])
      expect(
        reason(() =>
          check(packageJson({ dependencies: { "@embody/core": "^0.1.0", "@embody/host": "^0.1.0", x: spec } })),
        ),
      ).toBe("INPUT_REJECTED");
    expect(reason(() => check("{"))).toBe("INPUT_REJECTED");
    expect(reason(() => check("x".repeat(BUILD_RECIPE.maxPackageJsonBytes + 1)))).toBe(
      "INPUT_REJECTED",
    );
  });
  it("requires the pinned package manager and the framework runtime", () => {
    expect(reason(() => check(packageJson({ packageManager: "pnpm@9.0.0" })))).toBe(
      "UNSUPPORTED_RUNTIME",
    );
    expect(reason(() => check(packageJson({ packageManager: "npm@11.0.0" })))).toBe(
      "UNSUPPORTED_RUNTIME",
    );
    expect(reason(() => check(packageJson({ packageManager: `pnpm@${BUILD_RECIPE.pnpmVersion}` })))).toBe(
      "accepted",
    );
    expect(
      reason(() => check(packageJson({ dependencies: { "@embody/core": "^0.1.0" } }))),
    ).toBe("UNSUPPORTED_RUNTIME");
  });
  it("rejects missing, stale, non-registry and foreign-framework lockfiles", () => {
    expect(
      reason(() => checkBuildInputs({ packageJson: packageJson(), lockfile: undefined, framework })),
    ).toBe("LOCKFILE_REJECTED");
    expect(reason(() => check(packageJson(), "lockfileVersion: '6.0'\n"))).toBe(
      "LOCKFILE_REJECTED",
    );
    expect(reason(() => check(packageJson(), "a: &x 1\nb: *x\n"))).toBe("LOCKFILE_REJECTED");
    // Declared dependency missing from the lockfile, and a changed specifier.
    expect(
      reason(() =>
        check(packageJson({ devDependencies: { typescript: "^5.9.3", vitest: "^4.0.0" } })),
      ),
    ).toBe("LOCKFILE_REJECTED");
    expect(reason(() => check(packageJson({ devDependencies: { typescript: "^5.8.0" } })))).toBe(
      "LOCKFILE_REJECTED",
    );
    const tarball = lockfile().replace(
      `resolution: {integrity: ${integrity("zod")}}`,
      "resolution: {tarball: https://attacker.example/zod.tgz}",
    );
    expect(reason(() => check(packageJson(), tarball))).toBe("LOCKFILE_REJECTED");
    const git = lockfile(
      "\n  evil@1.0.0:\n    resolution: {type: git, repo: https://x.example/e.git, commit: abc}\n",
    );
    expect(reason(() => check(packageJson(), git))).toBe("LOCKFILE_REJECTED");
    const linked = lockfile().replace("version: 4.1.0\n", "version: link:../zod\n");
    expect(reason(() => check(packageJson(), linked))).toBe("LOCKFILE_REJECTED");
    const directory = lockfile("\n  local@file:../local:\n    resolution: {directory: ../local}\n");
    expect(reason(() => check(packageJson(), directory))).toBe("LOCKFILE_REJECTED");
    const weak = lockfile().replace(integrity("zod"), "sha1-abcdefabcdefabcdefabcdefabcdefabcdefabcd");
    expect(reason(() => check(packageJson(), weak))).toBe("LOCKFILE_REJECTED");
    expect(reason(() => check(packageJson(), `overrides:\n  zod: 4.0.0\n${lockfile()}`))).toBe(
      "LOCKFILE_REJECTED",
    );
    const extraImporter = lockfile().replace(
      "packages:\n",
      "  other:\n    dependencies: {}\n\npackages:\n",
    );
    expect(reason(() => check(packageJson(), extraImporter))).toBe("LOCKFILE_REJECTED");
    const foreign = lockfile().replace(framework[0]!.integrity, integrity("forged-core"));
    expect(reason(() => check(packageJson(), foreign))).toBe("UNSUPPORTED_RUNTIME");
    const otherVersion = lockfile("\n  '@embody/storage@9.9.9':\n    resolution: {integrity: " + integrity("s") + "}\n");
    expect(reason(() => check(packageJson(), otherVersion))).toBe("UNSUPPORTED_RUNTIME");
  });
  it("produces a deterministic CycloneDX SBOM from lockfile data", () => {
    const inputs = check();
    const sbom = lockfileSbom(inputs, { appId: "app", sourceDigest: `sha256:${"a".repeat(64)}` });
    expect(lockfileSbom(inputs, { appId: "app", sourceDigest: `sha256:${"a".repeat(64)}` })).toBe(sbom);
    const parsed = JSON.parse(sbom) as { bomFormat: string; components: { purl: string }[] };
    expect(parsed.bomFormat).toBe("CycloneDX");
    expect(parsed.components.map((c) => c.purl)).toContain("pkg:npm/%40embody/core@0.1.0");
  });
  it("blocks critical advisories only", () => {
    expect(auditBlocks({ critical: 1, high: 0, moderate: 0, low: 0 })).toBe(true);
    expect(auditBlocks({ critical: 0, high: 9, moderate: 9, low: 9 })).toBe(false);
  });
});

describe("M11 manifest and capability contracts", () => {
  const manifest = {
    version: 1,
    profile: "durable-v1",
    recipe: BUILD_RECIPE.id,
    nodeMajor: 24,
    appId: "my-app",
    appVersion: "0.1.0",
    entrypoint: BUILD_RECIPE.entrypoint,
    publishes: ["app.submitted"],
    subscriptions: ["app.submitted"],
    workflows: [{ target: "app.followUp", version: "0.1.0", steps: [{ name: "remind", dependsOn: [] }] }],
    catalogDigest: `sha256:${"b".repeat(64)}`,
  };
  it("carries profile, events, subscriptions and versioned workflows", () => {
    expect(ArtifactManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      ArtifactManifestSchema.safeParse({ ...manifest, profile: "request-only-v1" }).success,
    ).toBe(false);
    expect(
      ArtifactManifestSchema.safeParse({
        ...manifest,
        profile: "request-only-v1",
        publishes: [],
        subscriptions: [],
        workflows: [],
      }).success,
    ).toBe(true);
    expect(ArtifactManifestSchema.safeParse({ ...manifest, nodeMajor: 22 }).success).toBe(false);
    expect(ArtifactManifestSchema.safeParse({ ...manifest, extra: true }).success).toBe(false);
  });
  it("accepts the durable profile and still rejects excluded capabilities", () => {
    const durable = {
      profile: "durable-v1",
      crud: true,
      boundedActions: true,
      workflows: true,
      events: false,
      subscriptions: true,
      schedules: false,
      appToAppRpc: false,
      persistentLocalState: false,
      genui: false,
    };
    expect(CapabilitiesSchema.parse(durable)).toEqual(durable);
    for (const key of ["schedules", "appToAppRpc", "persistentLocalState", "genui"])
      expect(CapabilitiesSchema.safeParse({ ...durable, [key]: true }).success).toBe(false);
    expect(CapabilitiesSchema.safeParse({ ...durable, profile: "durable-v2" }).success).toBe(false);
    expect(
      DeploymentSubmissionSchema.safeParse({
        version: 1,
        workspaceId: "ws_aaaaaaaa",
        appId: "app_aaaaaaaa",
        idempotencyKey: "submission_key_01",
        source: { uploadId: "src_aaaaaaaa", digest: `sha256:${"c".repeat(64)}`, bytes: 10 },
        expectedGeneration: 0,
        capabilities: durable,
        secretReferences: [],
      }).success,
    ).toBe(true);
  });
  it("bounds the untrusted build output", () => {
    const output = {
      format: "embody-build-output-v1",
      recipe: BUILD_RECIPE.id,
      nodeVersion: "v24.22.0",
      appId: "my-app",
      appVersion: "0.1.0",
      preflight: { requestOnly: true, durable: true },
      publishes: [],
      catalog: {},
    };
    expect(BuildOutputSchema.safeParse(output).success).toBe(true);
    expect(BuildOutputSchema.safeParse({ ...output, nodeVersion: "v22.1.0" }).success).toBe(false);
    expect(BuildOutputSchema.safeParse({ ...output, publishes: ["Bad Name"] }).success).toBe(false);
    expect(
      BuildOutputSchema.safeParse({ ...output, publishes: Array(201).fill("app.x") }).success,
    ).toBe(false);
    expect(BuildOutputSchema.safeParse({ ...output, secret: "x" }).success).toBe(false);
  });
  it("only exposes fixed error messages and consistent artifact status", () => {
    expect(BuildErrorSchema.parse(buildError("LOCKFILE_REJECTED"))).toEqual(
      buildError("LOCKFILE_REJECTED"),
    );
    expect(
      BuildErrorSchema.safeParse({ code: "BUILD_FAILED", message: "npm ERR! token=abc" }).success,
    ).toBe(false);
    const base = {
      version: 1,
      workspaceId: "ws_aaaaaaaa",
      appId: "app_aaaaaaaa",
      deploymentId: "dep_aaaaaaaa",
      artifactId: "art_aaaaaaaa",
      attempt: 1,
      sourceDigest: `sha256:${"d".repeat(64)}`,
    };
    expect(ArtifactStatusSchema.safeParse({ ...base, state: "building" }).success).toBe(true);
    expect(ArtifactStatusSchema.safeParse({ ...base, state: "admitted" }).success).toBe(false);
    expect(
      ArtifactStatusSchema.safeParse({ ...base, state: "rejected", error: buildError("BUILD_FAILED") })
        .success,
    ).toBe(true);
  });
});

describe("M11 build log redaction", () => {
  it("bounds logs and removes known values and secret-shaped strings", () => {
    const pem = ["-----BEGIN", "PRIVATE KEY-----\nMIIEcanary\n-----END PRIVATE KEY-----"].join(" ");
    const log = [
      pem,
      "token ya29.a0AfH6SMBcanarycanarycanary",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "https://storage.googleapis.com/b/o?X-Goog-Algorithm=x&X-Goog-Signature=deadbeef",
      "postgresql://user:pass@db/app",
      "AKIAABCDEFGHIJKLMNOP",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "known-platform-value-123",
      "ordinary line",
    ].join("\n");
    const redacted = redactBuildLog(log, ["known-platform-value-123"]);
    for (const secret of [
      "MIIEcanary",
      "ya29.a0AfH6",
      "abcdefghijklmnopqrstuvwxyz",
      "deadbeef",
      "user:pass",
      "AKIAABCDEFGHIJKLMNOP",
      "ghp_",
      "known-platform-value-123",
    ])
      expect(redacted).not.toContain(secret);
    expect(redacted).toContain("ordinary line");
    const long = redactBuildLog("x".repeat(BUILD_RECIPE.maxLogBytes + 10));
    expect(long.endsWith("[TRUNCATED]\n")).toBe(true);
    expect(Buffer.byteLength(long)).toBeLessThan(BUILD_RECIPE.maxLogBytes + 64);
  });
});
