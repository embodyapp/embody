import { createHash, randomBytes } from "node:crypto";
import { ConflictError, appManifestSchema } from "@embody/core";
import {
  ArtifactManifestSchema,
  BUILD_RECIPE,
  BuildOutputSchema,
  DigestSchema,
  HOSTED_PROFILE,
  auditBlocks,
  buildError,
  redactBuildLog,
  type ArtifactManifest,
  type ArtifactStatus,
  type BuildErrorCode,
  type DeploymentSubmission,
} from "@embody/cloud-contracts";
import { verifySubmissionSource, type SourceRecord, type SourceStore } from "./source-admission.js";
import type { SourceObjectStore } from "./source-storage.js";

// ---------------------------------------------------------------------------------------------
// Recipe configuration and build plan. Trusted code generates the whole provider build; no step,
// script or Dockerfile comes from customer source.

/** Platform build settings. Every image is pinned by digest; nothing is resolved by tag. */
export interface BuildRecipeConfig {
  readonly project: string;
  readonly region: string;
  /** Dedicated builder identity: image push and output writes only. */
  readonly builderServiceAccount: string;
  /** Platform-built recipe image (prepare, sandbox entry, manifest extractor). */
  readonly builderImage: string;
  /** Docker CLI image for the sandbox and assembly steps. */
  readonly dockerImage: string;
  /** Runtime base image for the produced app image. */
  readonly runtimeImage: string;
  /** Docker repository for app images, e.g. `us-central1-docker.pkg.dev/p/repo`. */
  readonly imageRepository: string;
  /** Private bucket for build outputs (manifest, SBOM); the builder may only create objects. */
  readonly outputBucket: string;
  /**
   * Private bucket for provider build logs. Separate from outputs because Cloud Build rewrites
   * the log object while a build runs, so the builder needs object update/delete there.
   */
  readonly logsBucket: string;
}
const PINNED = /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)+(:[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
export function assertRecipeConfig(config: BuildRecipeConfig): void {
  const ok =
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.project) &&
    /^[a-z]+-[a-z]+\d$/.test(config.region) &&
    /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(config.builderServiceAccount) &&
    PINNED.test(config.builderImage) &&
    PINNED.test(config.dockerImage) &&
    PINNED.test(config.runtimeImage) &&
    /^[a-z0-9-]+-docker\.pkg\.dev\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/[a-z][a-z0-9-]{0,62}$/.test(
      config.imageRepository,
    ) &&
    /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(config.outputBucket) &&
    /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(config.logsBucket) &&
    config.logsBucket !== config.outputBucket;
  if (!ok) throw new TypeError("Invalid build recipe configuration (images must be pinned)");
}

export interface BuildStep {
  readonly id: string;
  readonly name: string;
  readonly entrypoint: string;
  readonly args: readonly string[];
  readonly env: readonly string[];
  readonly timeout: string;
}
/** Cloud Build `Build` resource fields set by the platform. */
export interface BuildConfig {
  readonly steps: readonly BuildStep[];
  readonly images: readonly string[];
  readonly artifacts: { readonly objects: { readonly location: string; readonly paths: string[] } };
  readonly serviceAccount: string;
  readonly logsBucket: string;
  readonly options: { readonly logging: "GCS_ONLY"; readonly substitutionOption: "MUST_MATCH" };
  readonly timeout: string;
  readonly tags: readonly string[];
  readonly substitutions: { readonly _SOURCE_URL: string };
}
export interface BuildPlan {
  readonly artifactId: string;
  /** Provider tag used to find a build after a crash between submit and record. */
  readonly tag: string;
  /** Tagged image name pushed by the provider; admission binds the reported digest to it. */
  readonly image: string;
  readonly outputPrefix: string;
  readonly config: BuildConfig;
  /** Digest of everything the platform controls (all of the config except the source URL). */
  readonly configDigest: string;
}

/** Cloud Build substitutes `$NAME`; scripts escape every literal `$` as `$$`. */
// split/join, not replaceAll: in a replacement string "$$" means a single "$".
const escapeDollars = (script: string) => script.split("$").join("$$");
const MAX_TAR_BYTES = BUILD_RECIPE.maxOutputBytes + 16 * 1024 * 1024;

/**
 * Sandbox step: runs customer code (install, build, manifest extraction) in a container with no
 * network (so no metadata server, registry or provider APIs), no capabilities, a non-root user,
 * bounded memory/CPU/processes/files and a wall clock. Input is baked into a per-build image by a
 * platform Dockerfile (COPY only) and output leaves by `docker cp`; the sandbox never sees the
 * workspace, the step's environment or the Docker socket.
 */
export function sandboxScript(): string {
  const s = BUILD_RECIPE.sandbox;
  return `set -eu
W="\${EMBODY_WORKSPACE:-/workspace}"
N="embody-sandbox-\${EMBODY_ARTIFACT_ID}"
I="embody-input-\${EMBODY_ARTIFACT_ID}"
docker rm -f "$N" >/dev/null 2>&1 || true
# Input image: the recipe image plus source and dependency store, owned by the sandbox user.
# Platform Dockerfile, no RUN, no network: nothing from the source executes here.
mkdir -p "$W/sandbox-input"
mv "$W/src" "$W/sandbox-input/src"
mv "$W/store" "$W/sandbox-input/store"
cat > "$W/sandbox-input/Dockerfile" <<'EMBODY_INPUT'
ARG BUILDER_IMAGE
FROM \${BUILDER_IMAGE}
COPY --chown=node:node src/ /app/
COPY --chown=node:node store/ /store/
EMBODY_INPUT
printf 'Dockerfile\n' > "$W/sandbox-input/.dockerignore"
docker build --network none -q --build-arg BUILDER_IMAGE="$EMBODY_BUILDER_IMAGE" -t "$I" "$W/sandbox-input" >/dev/null
docker create --name "$N" --network none --user ${s.user} --cap-drop ALL \\
  --security-opt no-new-privileges --memory ${s.memoryBytes} --memory-swap ${s.memoryBytes} \\
  --pids-limit ${s.pids} --cpus ${s.cpus} --ulimit nofile=${s.openFiles}:${s.openFiles} --ulimit core=0 \\
  --env-file /dev/null --workdir /app --entrypoint /embody/sandbox.sh "$I" >/dev/null
mkdir -p "$W/sandbox"
# Log bounded to ${BUILD_RECIPE.maxLogBytes} bytes; the rest is drained, never stored.
{ if timeout -k 10 ${BUILD_RECIPE.sandboxSeconds} docker start -a "$N" 2>&1; then st=0; else st=$?; fi; echo "$st" > "$W/sandbox/status"; } | { head -c ${BUILD_RECIPE.maxLogBytes}; cat >/dev/null; }
status=$(cat "$W/sandbox/status")
echo "embody: sandbox exit $status"
docker kill "$N" >/dev/null 2>&1 || true
if [ "$status" != 0 ]; then
  docker rm -f "$N" >/dev/null 2>&1 || true
  docker rmi -f "$I" >/dev/null 2>&1 || true
  echo "embody: sandbox failed (status $status)"
  exit 1
fi
docker cp "$N:/app" - | { head -c ${MAX_TAR_BYTES} > "$W/sandbox/app.tar"; cat >/dev/null; }
docker cp "$N:/out/manifest.json" - 2>/dev/null | { head -c ${BUILD_RECIPE.maxManifestBytes * 2} > "$W/sandbox/manifest.tar"; cat >/dev/null; } || true
docker rm -f "$N" >/dev/null
docker rmi -f "$I" >/dev/null 2>&1 || true
`;
}

/**
 * Assembly step (trusted): bounds the output, copies the sandbox's tree into the pinned runtime
 * image with a platform Dockerfile that has no RUN instruction (customer output is never
 * executed here), and reports the manifest digest through the provider's step output.
 */
export function assembleScript(): string {
  return `set -eu
W="\${EMBODY_WORKSPACE:-/workspace}"
OUT="\${BUILDER_OUTPUT:-/builder/outputs}"
bytes=$(stat -c %s "$W/sandbox/app.tar")
if [ "$bytes" -gt ${BUILD_RECIPE.maxOutputBytes} ]; then echo "embody: build output exceeds limit"; printf '{"rejected":"OUTPUT_LIMIT"}' > "$OUT/output"; exit 1; fi
mkdir -p "$W/assemble/context" "$W/admit"
tar -xo -C "$W/assemble/context" -f "$W/sandbox/app.tar"
: > "$W/admit/manifest.json"
{ tar -xO -f "$W/sandbox/manifest.tar" manifest.json 2>/dev/null || true; } | head -c ${BUILD_RECIPE.maxManifestBytes + 1} > "$W/admit/manifest.json"
cp "$W/inputs/sbom.json" "$W/admit/sbom.json"
cat > "$W/assemble/Dockerfile" <<'EMBODY_DOCKERFILE'
ARG RUNTIME_IMAGE
FROM \${RUNTIME_IMAGE}
COPY --chown=node:node . /app
WORKDIR /app
USER node
ENV NODE_ENV=production
CMD ["node", "${BUILD_RECIPE.entrypoint}"]
EMBODY_DOCKERFILE
docker build --network none --no-cache -q -f "$W/assemble/Dockerfile" \\
  --build-arg RUNTIME_IMAGE="$EMBODY_RUNTIME_IMAGE" \\
  --label org.embody.workspace="$EMBODY_WORKSPACE_ID" --label org.embody.app="$EMBODY_APP_ID" \\
  --label org.embody.deployment="$EMBODY_DEPLOYMENT_ID" --label org.embody.artifact="$EMBODY_ARTIFACT_ID" \\
  --label org.embody.source="$EMBODY_SOURCE_DIGEST" --label org.embody.recipe=${BUILD_RECIPE.id} \\
  -t "$EMBODY_IMAGE" "$W/assemble/context/app" >/dev/null
digest=$(sha256sum "$W/admit/manifest.json" | cut -d' ' -f1)
printf '{"manifestDigest":"sha256:%s","outputBytes":%s}' "$digest" "$bytes" > "$OUT/output"
`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const sha256 = (data: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;
const SOURCE_URL_ENV = "EMBODY_SOURCE_URL=";
/**
 * Cloud Build reports steps as executed: substitutions applied, so `$$` reads back as `$` and
 * `$_SOURCE_URL` as the signed URL. Both forms map to the same canonical text; the source URL
 * (a per-attempt capability) is never part of the digest.
 */
export function executedForm(value: string, form: "planned" | "executed"): string {
  if (value.startsWith(SOURCE_URL_ENV)) return `${SOURCE_URL_ENV}<source>`;
  return form === "planned" ? value.split("$$").join("$") : value;
}
/**
 * Digest over the platform-controlled fields. The plan is digested in its `planned` form, the
 * provider's record in its `executed` form; they agree only if the build ran the exact plan.
 */
export function buildConfigDigest(
  config: Omit<BuildConfig, "substitutions">,
  form: "planned" | "executed" = "executed",
): string {
  return sha256(
    canonical({
      steps: config.steps.map((s) => ({
        id: s.id,
        name: s.name,
        entrypoint: s.entrypoint,
        args: s.args.map((a) => executedForm(a, form)),
        env: s.env.map((e) => executedForm(e, form)),
        timeout: s.timeout,
      })),
      images: config.images,
      artifacts: config.artifacts,
      serviceAccount: config.serviceAccount,
      logsBucket: config.logsBucket,
      logging: config.options.logging,
      timeout: config.timeout,
    }),
  );
}

export interface BuildPlanInput {
  readonly workspaceId: string;
  readonly appId: string;
  readonly deploymentId: string;
  readonly artifactId: string;
  readonly sourceDigest: string;
  readonly sourceBytes: number;
  /** Short-lived read capability for exactly the verified source object. */
  readonly sourceUrl: string;
}
export function planBuild(recipe: BuildRecipeConfig, input: BuildPlanInput): BuildPlan {
  assertRecipeConfig(recipe);
  if (
    !/^ws_[a-z0-9]{8,64}$/.test(input.workspaceId) ||
    !/^app_[a-z0-9]{8,64}$/.test(input.appId) ||
    !/^dep_[a-z0-9]{8,64}$/.test(input.deploymentId) ||
    !/^art_[a-z0-9]{8,64}$/.test(input.artifactId) ||
    !DigestSchema.safeParse(input.sourceDigest).success ||
    !Number.isSafeInteger(input.sourceBytes) ||
    !/^https:\/\//.test(input.sourceUrl)
  )
    throw new TypeError("Invalid build plan input");
  const path = `${input.workspaceId}/${input.appId}`;
  const image = `${recipe.imageRepository}/${path}:${input.artifactId}`;
  const outputPrefix = `builds/${path}/${input.artifactId}/`;
  const env = (...pairs: [string, string][]) => pairs.map(([k, v]) => `${k}=${v}`);
  const common: [string, string][] = [
    ["EMBODY_WORKSPACE_ID", input.workspaceId],
    ["EMBODY_APP_ID", input.appId],
    ["EMBODY_DEPLOYMENT_ID", input.deploymentId],
    ["EMBODY_ARTIFACT_ID", input.artifactId],
    ["EMBODY_SOURCE_DIGEST", input.sourceDigest],
  ];
  const config: Omit<BuildConfig, "substitutions"> = {
    steps: [
      {
        id: "prepare",
        name: recipe.builderImage,
        entrypoint: "node",
        args: ["/embody/prepare.mjs"],
        env: env(
          ...common,
          ["EMBODY_SOURCE_BYTES", String(input.sourceBytes)],
          ["EMBODY_SOURCE_URL", "$_SOURCE_URL"],
        ),
        timeout: "150s",
      },
      {
        id: "sandbox",
        name: recipe.dockerImage,
        entrypoint: "sh",
        args: ["-c", escapeDollars(sandboxScript())],
        env: env(...common, ["EMBODY_BUILDER_IMAGE", recipe.builderImage]),
        timeout: `${BUILD_RECIPE.sandboxSeconds + 30}s`,
      },
      {
        id: "assemble",
        name: recipe.dockerImage,
        entrypoint: "sh",
        args: ["-c", escapeDollars(assembleScript())],
        env: env(...common, ["EMBODY_RUNTIME_IMAGE", recipe.runtimeImage], ["EMBODY_IMAGE", image]),
        timeout: "120s",
      },
    ],
    images: [image],
    artifacts: {
      objects: {
        location: `gs://${recipe.outputBucket}/${outputPrefix}`,
        paths: ["admit/manifest.json", "admit/sbom.json"],
      },
    },
    serviceAccount: `projects/${recipe.project}/serviceAccounts/${recipe.builderServiceAccount}`,
    logsBucket: `gs://${recipe.logsBucket}/logs/${path}/${input.artifactId}`,
    options: { logging: "GCS_ONLY", substitutionOption: "MUST_MATCH" },
    timeout: `${BUILD_RECIPE.maxBuildSeconds}s`,
    tags: ["embody-build", `embody-${input.artifactId.replace("_", "-")}`],
  };
  return {
    artifactId: input.artifactId,
    tag: `embody-${input.artifactId.replace("_", "-")}`,
    image,
    outputPrefix,
    config: { ...config, substitutions: { _SOURCE_URL: input.sourceUrl } },
    configDigest: buildConfigDigest(config, "planned"),
  };
}

// ---------------------------------------------------------------------------------------------
// Provider port. The Cloud Build adapter lives in ./cloud-build.ts; tests use a fake.

export type ProviderBuildStatus =
  | "QUEUED"
  | "PENDING"
  | "WORKING"
  | "SUCCESS"
  | "FAILURE"
  | "INTERNAL_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "EXPIRED";
/** What the provider reports about a build. Trusted: written by the provider, not the build. */
export interface ProviderBuild {
  readonly id: string;
  readonly status: ProviderBuildStatus;
  readonly config: Omit<BuildConfig, "substitutions">;
  readonly images: readonly { readonly name: string; readonly digest: string }[];
  /** Per-step `$BUILDER_OUTPUT/output` contents, by step index. */
  readonly stepOutputs: readonly string[];
  readonly startTime?: string;
  readonly finishTime?: string;
}
export interface BuildProvider {
  submit(config: BuildConfig): Promise<{ buildId: string }>;
  /** A build carrying `tag`, if one exists (crash recovery). */
  find(tag: string): Promise<string | null>;
  get(buildId: string): Promise<ProviderBuild>;
  cancel(buildId: string): Promise<void>;
  /** Reads `<outputBucket>/<path>`; null when absent; fails above `maxBytes`. */
  readOutput(path: string, maxBytes: number): Promise<Uint8Array | null>;
  deleteOutputs(prefix: string): Promise<void>;
  /** Reads the provider log written under the build's `logsBucket` location. */
  readLog(buildId: string, logsBucket: string, maxBytes: number): Promise<string | null>;
  /** Deletes every log object under a build's `logsBucket` location. */
  deleteLogs(logsBucket: string): Promise<void>;
  /** Idempotent; deletes one image version by digest under `<repository>/<ws>/<app>`. */
  deleteImage(path: string, digest: string): Promise<void>;
  listImages(
    path: string,
  ): Promise<readonly { readonly digest: string; readonly createdAt: string }[]>;
}
export class BuildProviderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BuildProviderError";
  }
}

// ---------------------------------------------------------------------------------------------
// Artifact records.

export interface ArtifactRecord {
  readonly workspaceId: string;
  readonly appId: string;
  readonly deploymentId: string;
  readonly attempt: number;
  readonly artifactId: string;
  readonly sourceUploadId: string;
  readonly sourceDigest: string;
  readonly state: "building" | "admitted" | "rejected";
  readonly recipe: string;
  readonly configDigest: string;
  readonly image: string;
  readonly outputPrefix: string;
  readonly logsBucket: string;
  readonly buildId?: string;
  /** Digest-addressed image reference (`<repo>/<ws>/<app>@sha256:…`); the only deployable form. */
  readonly imageReference?: string;
  readonly imageDigest?: string;
  readonly manifest?: ArtifactManifest;
  readonly manifestDigest?: string;
  readonly sbomDigest?: string;
  readonly audit?: { critical: number; high: number; moderate: number; low: number };
  readonly provenance?: {
    readonly builder: string;
    readonly buildId: string;
    readonly configDigest: string;
    readonly startTime?: string;
    readonly finishTime?: string;
  };
  readonly error?: BuildErrorCode;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly retainUntil: string;
  /** Set by M13 when a release references the artifact; pinned artifacts are never purged. */
  readonly pinnedBy?: string;
  /** Retention fence (CAS) before provider deletes; a purging record is invisible. */
  readonly purging?: boolean;
  readonly revision: number;
}
export type ArtifactWrite = Omit<ArtifactRecord, "revision">;
/** Atomic artifact persistence; implemented by the memory and PostgreSQL gateway stores. */
export interface ArtifactStore {
  /** Unique per (workspace, app, deployment, attempt); ConflictError when it exists. */
  createArtifact(record: ArtifactWrite): Promise<ArtifactRecord>;
  /** Never returns a purging record. */
  artifact(workspaceId: string, appId: string, artifactId: string): Promise<ArtifactRecord | null>;
  artifactForAttempt(
    workspaceId: string,
    appId: string,
    deploymentId: string,
    attempt: number,
  ): Promise<ArtifactRecord | null>;
  /** CAS on revision; identity fields are immutable; refuses purging records. */
  updateArtifact(next: ArtifactRecord, expectedRevision: number): Promise<ArtifactRecord>;
  /** Expired unpinned records, including purging tombstones. */
  expiredArtifacts(now: Date, limit: number): Promise<ArtifactRecord[]>;
  /** Image digests of every record (any state) of the app, for orphan detection. */
  artifactDigests(workspaceId: string, appId: string): Promise<ReadonlySet<string>>;
  deleteArtifact(record: ArtifactRecord): Promise<boolean>;
}
export function sameArtifactIdentity(a: ArtifactRecord, b: ArtifactRecord): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.appId === b.appId &&
    a.deploymentId === b.deploymentId &&
    a.attempt === b.attempt &&
    a.artifactId === b.artifactId &&
    a.sourceUploadId === b.sourceUploadId &&
    a.sourceDigest === b.sourceDigest &&
    a.configDigest === b.configDigest &&
    a.image === b.image &&
    (a.buildId === undefined || a.buildId === b.buildId) &&
    (a.imageDigest === undefined || a.imageDigest === b.imageDigest)
  );
}

export function artifactStatus(record: ArtifactRecord): ArtifactStatus {
  return {
    version: 1,
    workspaceId: record.workspaceId as ArtifactStatus["workspaceId"],
    appId: record.appId as ArtifactStatus["appId"],
    deploymentId: record.deploymentId as ArtifactStatus["deploymentId"],
    artifactId: record.artifactId,
    attempt: record.attempt,
    state: record.state,
    sourceDigest: record.sourceDigest,
    ...(record.state === "admitted"
      ? { imageDigest: record.imageDigest!, manifest: record.manifest! }
      : {}),
    ...(record.state === "rejected" ? { error: buildError(record.error ?? "BUILD_FAILED") } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Admission decision (trusted). Inputs are the platform plan, the provider's record and the
// bytes of the build output objects. Nothing here imports or runs customer code.

interface PrepareOutput {
  readonly recipe: string;
  readonly sourceDigest: string;
  readonly treeDigest: string;
  readonly lockfileDigest: string;
  readonly sbomDigest: string;
  readonly packages: number;
  readonly audit: { critical: number; high: number; moderate: number; low: number };
}
function parseJson(text: string | undefined): unknown {
  if (text === undefined || text.length === 0 || text.length > 4096) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
function prepareOutput(text: string | undefined): PrepareOutput | BuildErrorCode | undefined {
  const value = parseJson(text) as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object") return undefined;
  if (typeof value["rejected"] === "string") {
    const code = value["rejected"];
    const allowed: BuildErrorCode[] = [
      "SOURCE_INVALID",
      "INPUT_REJECTED",
      "LOCKFILE_REJECTED",
      "UNSUPPORTED_RUNTIME",
      "VULNERABILITY_POLICY",
      "DEPENDENCY_UNAVAILABLE",
    ];
    return allowed.includes(code as BuildErrorCode) ? (code as BuildErrorCode) : "BUILD_FAILED";
  }
  const audit = value["audit"] as Record<string, unknown> | undefined;
  if (
    value["recipe"] !== BUILD_RECIPE.id ||
    !DigestSchema.safeParse(value["sourceDigest"]).success ||
    !DigestSchema.safeParse(value["treeDigest"]).success ||
    !DigestSchema.safeParse(value["lockfileDigest"]).success ||
    !DigestSchema.safeParse(value["sbomDigest"]).success ||
    !isCount(value["packages"]) ||
    !audit ||
    !["critical", "high", "moderate", "low"].every((k) => isCount(audit[k]))
  )
    return undefined;
  return value as unknown as PrepareOutput;
}

export type AdmissionDecision =
  | {
      readonly admitted: true;
      readonly imageDigest: string;
      readonly imageReference: string;
      readonly manifest: ArtifactManifest;
      readonly manifestDigest: string;
      readonly sbomDigest: string;
      readonly audit: PrepareOutput["audit"];
    }
  | { readonly admitted: false; readonly code: BuildErrorCode; readonly imageDigest?: string };

/**
 * Admission. Order matters: provenance (the record is the platform's own build from the exact
 * plan), then the trusted step outputs, then the image the provider pushed, then the untrusted
 * manifest bound to its digest, then profile and capability policy.
 */
export async function decideAdmission(input: {
  readonly plan: Pick<BuildPlan, "image" | "configDigest" | "outputPrefix">;
  readonly record: Pick<ArtifactRecord, "sourceDigest">;
  readonly submission: Pick<DeploymentSubmission, "capabilities">;
  readonly build: ProviderBuild;
  readonly readOutput: (path: string, maxBytes: number) => Promise<Uint8Array | null>;
}): Promise<AdmissionDecision> {
  const { build, plan } = input;
  const pushed = build.images.find((image) => image.name === plan.image);
  const pushedDigest =
    pushed && /^sha256:[a-f0-9]{64}$/.test(pushed.digest) ? pushed.digest : undefined;
  const reject = (code: BuildErrorCode): AdmissionDecision => ({
    admitted: false,
    code,
    ...(pushedDigest ? { imageDigest: pushedDigest } : {}),
  });
  if (buildConfigDigest(build.config, "executed") !== plan.configDigest)
    return reject("PROVENANCE_INVALID");
  const prepared = prepareOutput(build.stepOutputs[0]);
  if (build.status === "TIMEOUT") return reject("BUILD_TIMEOUT");
  if (build.status === "INTERNAL_ERROR") return reject("DEPENDENCY_UNAVAILABLE");
  if (build.status !== "SUCCESS") {
    if (typeof prepared === "string") return reject(prepared);
    const assembled = parseJson(build.stepOutputs[2]) as { rejected?: unknown } | undefined;
    if (assembled?.rejected === "OUTPUT_LIMIT") return reject("OUTPUT_LIMIT");
    return reject("BUILD_FAILED");
  }
  if (!prepared || typeof prepared === "string") return reject("PROVENANCE_INVALID");
  if (prepared.sourceDigest !== input.record.sourceDigest) return reject("PROVENANCE_INVALID");
  if (auditBlocks(prepared.audit)) return reject("VULNERABILITY_POLICY");
  if (build.images.length !== 1 || !pushedDigest) return reject("IMAGE_INVALID");
  const assembled = parseJson(build.stepOutputs[2]) as
    { manifestDigest?: unknown; outputBytes?: unknown } | undefined;
  if (
    !assembled ||
    !DigestSchema.safeParse(assembled.manifestDigest).success ||
    !isCount(assembled.outputBytes)
  )
    return reject("PROVENANCE_INVALID");
  if ((assembled.outputBytes as number) > BUILD_RECIPE.maxOutputBytes)
    return reject("OUTPUT_LIMIT");

  const manifestBytes = await input.readOutput(
    `${plan.outputPrefix}manifest.json`,
    BUILD_RECIPE.maxManifestBytes,
  );
  if (!manifestBytes || manifestBytes.byteLength === 0) return reject("MANIFEST_INVALID");
  if (sha256(manifestBytes) !== assembled.manifestDigest) return reject("MANIFEST_MISMATCH");
  const sbomBytes = await input.readOutput(`${plan.outputPrefix}sbom.json`, 16 * 1024 * 1024);
  if (!sbomBytes || sha256(sbomBytes) !== prepared.sbomDigest) return reject("MANIFEST_MISMATCH");

  let output;
  let catalog;
  try {
    output = BuildOutputSchema.parse(JSON.parse(Buffer.from(manifestBytes).toString("utf8")));
    catalog = appManifestSchema.parse(output.catalog);
  } catch {
    return reject("MANIFEST_INVALID");
  }
  const workflows = Object.entries(catalog.workflows ?? {})
    .map(([target, workflow]) => ({
      target,
      version: workflow.version,
      steps: workflow.steps.map((step) => ({ name: step.name, dependsOn: [...step.dependsOn] })),
    }))
    .sort((a, b) => (a.target < b.target ? -1 : 1));
  const subscriptions = [...catalog.eventSubscriptions].sort();
  const publishes = [...new Set(output.publishes)].sort();
  const capabilities = input.submission.capabilities;
  if (capabilities.profile === "request-only-v1") {
    if (
      !output.preflight.requestOnly ||
      workflows.length > 0 ||
      subscriptions.length > 0 ||
      publishes.length > 0
    )
      return reject("UNSUPPORTED_PROFILE");
  } else {
    if (!output.preflight.durable || workflows.some((w) => w.steps.length > 50))
      return reject("UNSUPPORTED_PROFILE");
    if (
      capabilities.workflows !== workflows.length > 0 ||
      capabilities.subscriptions !== subscriptions.length > 0 ||
      capabilities.events !== publishes.length > 0
    )
      return reject("CAPABILITY_MISMATCH");
  }
  const manifest = ArtifactManifestSchema.safeParse({
    version: 1,
    profile: capabilities.profile,
    recipe: BUILD_RECIPE.id,
    nodeMajor: BUILD_RECIPE.nodeMajor,
    appId: output.appId,
    appVersion: output.appVersion,
    entrypoint: BUILD_RECIPE.entrypoint,
    publishes,
    subscriptions,
    workflows,
    catalogDigest: sha256(canonical(catalog)),
  });
  if (!manifest.success) return reject("MANIFEST_INVALID");
  const repository = plan.image.slice(0, plan.image.lastIndexOf(":"));
  return {
    admitted: true,
    imageDigest: pushedDigest,
    imageReference: `${repository}@${pushedDigest}`,
    manifest: manifest.data,
    manifestDigest: assembled.manifestDigest,
    sbomDigest: prepared.sbomDigest,
    audit: prepared.audit,
  };
}

// ---------------------------------------------------------------------------------------------
// Orchestration for the deployment controller (M12 calls these from durable jobs).

/** Source objects that can issue short-lived read access for the builder (GCS signed GET). */
export interface SourceReadAccess {
  createReadAccess(request: { objectKey: string; expiresAt: Date }): Promise<{ url: string }>;
}
export interface BuildAdmissionOptions {
  readonly store: ArtifactStore & Pick<SourceStore, "source">;
  readonly provider: BuildProvider;
  readonly recipe: BuildRecipeConfig;
  readonly sources: SourceReadAccess & Partial<Pick<SourceObjectStore, "stat">>;
  readonly clock?: { now(): Date };
}
const DAY = 86_400_000;
/** Read capability lifetime; the prepare step fetches the source first. */
export const SOURCE_READ_SECONDS = 600;
/** A build still running this long after creation is cancelled and rejected. */
export const BUILD_DEADLINE_MS = (BUILD_RECIPE.maxBuildSeconds + 600) * 1000;
/** Images under an app path with no artifact record are orphans once older than this. */
export const ORPHAN_AGE_MS = BUILD_DEADLINE_MS + 3_600_000;

export class BuildAdmissionError extends Error {
  public constructor(public readonly code: BuildErrorCode) {
    super(buildError(code).message);
    this.name = "BuildAdmissionError";
  }
}
const newArtifactId = () => `art_${randomBytes(12).toString("hex")}`;

export class BuildAdmission {
  private readonly clock: { now(): Date };
  public constructor(private readonly options: BuildAdmissionOptions) {
    assertRecipeConfig(options.recipe);
    this.clock = options.clock ?? { now: () => new Date() };
  }

  /**
   * Starts (or resumes) the build for one deployment stage attempt. Idempotent: a repeated call
   * returns the existing record and never submits a second build for the same attempt.
   */
  public async start(input: {
    readonly submission: DeploymentSubmission;
    readonly deploymentId: string;
    readonly attempt: number;
  }): Promise<ArtifactRecord> {
    const { submission } = input;
    if (
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 1 ||
      input.attempt > HOSTED_PROFILE.maxStageAttempts
    )
      throw new BuildAdmissionError("BUILD_FAILED");
    const now = this.clock.now();
    let source: SourceRecord;
    try {
      source = await verifySubmissionSource(this.options.store, submission, now);
    } catch {
      throw new BuildAdmissionError("SOURCE_INVALID");
    }
    const existing = await this.options.store.artifactForAttempt(
      submission.workspaceId,
      submission.appId,
      input.deploymentId,
      input.attempt,
    );
    let record = existing;
    if (!record) {
      const artifactId = newArtifactId();
      const plan = this.plan(submission, input.deploymentId, artifactId, source, "https://pending");
      try {
        record = await this.options.store.createArtifact({
          workspaceId: submission.workspaceId,
          appId: submission.appId,
          deploymentId: input.deploymentId,
          attempt: input.attempt,
          artifactId,
          sourceUploadId: source.uploadId,
          sourceDigest: source.digest,
          state: "building",
          recipe: BUILD_RECIPE.id,
          configDigest: plan.configDigest,
          image: plan.image,
          outputPrefix: plan.outputPrefix,
          logsBucket: plan.config.logsBucket,
          createdAt: now.toISOString(),
          retainUntil: new Date(
            now.getTime() + HOSTED_PROFILE.deploymentRetentionDays * DAY,
          ).toISOString(),
        });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        record = await this.options.store.artifactForAttempt(
          submission.workspaceId,
          submission.appId,
          input.deploymentId,
          input.attempt,
        );
        if (!record) throw error;
      }
    }
    return this.ensureSubmitted(record, submission, source);
  }

  private plan(
    submission: DeploymentSubmission,
    deploymentId: string,
    artifactId: string,
    source: SourceRecord,
    sourceUrl: string,
  ): BuildPlan {
    return planBuild(this.options.recipe, {
      workspaceId: submission.workspaceId,
      appId: submission.appId,
      deploymentId,
      artifactId,
      sourceDigest: source.digest,
      sourceBytes: source.bytes,
      sourceUrl,
    });
  }

  private async ensureSubmitted(
    record: ArtifactRecord,
    submission: DeploymentSubmission,
    source: SourceRecord,
  ): Promise<ArtifactRecord> {
    if (record.buildId || record.state !== "building") return record;
    const plan = this.plan(
      submission,
      record.deploymentId,
      record.artifactId,
      source,
      "https://pending",
    );
    // Crash between submit and record: the provider tag finds the earlier build.
    let buildId = await this.options.provider.find(plan.tag);
    if (!buildId) {
      const access = await this.options.sources.createReadAccess({
        objectKey: source.objectKey,
        expiresAt: new Date(this.clock.now().getTime() + SOURCE_READ_SECONDS * 1000),
      });
      const real = this.plan(
        submission,
        record.deploymentId,
        record.artifactId,
        source,
        access.url,
      );
      if (real.configDigest !== record.configDigest)
        throw new BuildAdmissionError("PROVENANCE_INVALID");
      buildId = (await this.options.provider.submit(real.config)).buildId;
    }
    return this.options.store.updateArtifact({ ...record, buildId }, record.revision);
  }

  /**
   * One reconciliation step: a running build stays `building`; a finished one is admitted or
   * rejected exactly once (CAS), and a rejected build's image and outputs are deleted.
   */
  public async settle(
    record: ArtifactRecord,
    submission: DeploymentSubmission,
  ): Promise<ArtifactRecord> {
    if (record.state !== "building") return record;
    if (
      record.workspaceId !== submission.workspaceId ||
      record.appId !== submission.appId ||
      record.sourceUploadId !== submission.source.uploadId ||
      record.sourceDigest !== submission.source.digest
    )
      throw new BuildAdmissionError("SOURCE_INVALID");
    if (!record.buildId) {
      const source = await this.options.store.source(
        record.workspaceId,
        record.appId,
        record.sourceUploadId,
      );
      if (!source) return this.reject(record, "SOURCE_INVALID");
      return this.ensureSubmitted(record, submission, source);
    }
    const now = this.clock.now();
    const build = await this.options.provider.get(record.buildId);
    const terminal = !["QUEUED", "PENDING", "WORKING"].includes(build.status);
    if (!terminal) {
      if (now.getTime() - Date.parse(record.createdAt) <= BUILD_DEADLINE_MS) return record;
      await this.options.provider.cancel(record.buildId);
      return this.reject(record, "BUILD_TIMEOUT", build.images[0]?.digest);
    }
    const decision = await decideAdmission({
      plan: record,
      record,
      submission,
      build,
      readOutput: (path, maxBytes) => this.options.provider.readOutput(path, maxBytes),
    });
    if (!decision.admitted) return this.reject(record, decision.code, decision.imageDigest);
    const finished = now.toISOString();
    return this.options.store.updateArtifact(
      {
        ...record,
        state: "admitted",
        imageDigest: decision.imageDigest,
        imageReference: decision.imageReference,
        manifest: decision.manifest,
        manifestDigest: decision.manifestDigest,
        sbomDigest: decision.sbomDigest,
        audit: decision.audit,
        provenance: {
          builder: this.options.recipe.builderServiceAccount,
          buildId: build.id,
          configDigest: record.configDigest,
          ...(build.startTime ? { startTime: build.startTime } : {}),
          ...(build.finishTime ? { finishTime: build.finishTime } : {}),
        },
        finishedAt: finished,
        retainUntil: new Date(
          now.getTime() + HOSTED_PROFILE.inactiveReleaseRetentionDays * DAY,
        ).toISOString(),
      },
      record.revision,
    );
  }

  private async reject(
    record: ArtifactRecord,
    code: BuildErrorCode,
    imageDigest?: string,
  ): Promise<ArtifactRecord> {
    const now = this.clock.now();
    const rejected = await this.options.store.updateArtifact(
      {
        ...record,
        state: "rejected",
        error: code,
        ...(imageDigest && /^sha256:[a-f0-9]{64}$/.test(imageDigest) ? { imageDigest } : {}),
        finishedAt: now.toISOString(),
        retainUntil: new Date(now.getTime() + HOSTED_PROFILE.logRetentionDays * DAY).toISOString(),
      },
      record.revision,
    );
    // Best effort: anything left is removed by purgeArtifacts / cleanupOrphanedImages.
    await removeBuildOutputs(this.options.provider, rejected).catch(() => undefined);
    return rejected;
  }

  /** Bounded, redacted build log for an authorized reader (M15 serves it). */
  public async log(record: ArtifactRecord, canaries: readonly string[] = []): Promise<string> {
    if (!record.buildId) return "";
    const text = await this.options.provider.readLog(
      record.buildId,
      record.logsBucket,
      BUILD_RECIPE.maxLogBytes * 2,
    );
    return redactBuildLog(text ?? "", canaries);
  }
}

/** Image and manifest/SBOM objects; logs stay until the record's retention ends. */
async function removeBuildOutputs(
  provider: BuildProvider,
  record: Pick<ArtifactRecord, "workspaceId" | "appId" | "imageDigest" | "outputPrefix">,
): Promise<void> {
  if (record.imageDigest)
    await provider.deleteImage(`${record.workspaceId}/${record.appId}`, record.imageDigest);
  await provider.deleteOutputs(record.outputPrefix);
}

/**
 * Retention sweep (M16 schedules it). Like source purges: fence by CAS, delete the image,
 * outputs and logs, then the tombstone. Pinned artifacts (active or rollback releases) stay.
 */
export async function purgeArtifacts(options: {
  readonly store: Pick<ArtifactStore, "expiredArtifacts" | "updateArtifact" | "deleteArtifact">;
  readonly provider: BuildProvider;
  readonly now?: Date;
  readonly limit?: number;
}): Promise<{ deleted: number; failed: number; skipped: number }> {
  const now = options.now ?? new Date();
  const records = await options.store.expiredArtifacts(now, options.limit ?? 100);
  let deleted = 0;
  let failed = 0;
  let skipped = 0;
  for (const record of records) {
    try {
      let fenced = record;
      if (!record.purging) {
        if (record.state === "building" && !record.finishedAt) {
          skipped += 1;
          continue;
        }
        try {
          fenced = await options.store.updateArtifact(
            { ...record, purging: true },
            record.revision,
          );
        } catch (error) {
          if (error instanceof ConflictError) {
            skipped += 1;
            continue;
          }
          throw error;
        }
      }
      await removeBuildOutputs(options.provider, fenced);
      await options.provider.deleteLogs(fenced.logsBucket);
      if (await options.store.deleteArtifact(fenced)) deleted += 1;
      else skipped += 1;
    } catch {
      failed += 1;
    }
  }
  return { deleted, failed, skipped };
}

/**
 * Deletes images under an app path that no artifact record references (a crash after push but
 * before the record, or a tampered push), once older than any build could be.
 */
export async function cleanupOrphanedImages(options: {
  readonly store: Pick<ArtifactStore, "artifactDigests">;
  readonly provider: BuildProvider;
  readonly workspaceId: string;
  readonly appId: string;
  readonly now?: Date;
}): Promise<{ deleted: number; kept: number }> {
  const now = (options.now ?? new Date()).getTime();
  const path = `${options.workspaceId}/${options.appId}`;
  const known = await options.store.artifactDigests(options.workspaceId, options.appId);
  let deleted = 0;
  let kept = 0;
  for (const image of await options.provider.listImages(path)) {
    if (known.has(image.digest) || now - Date.parse(image.createdAt) < ORPHAN_AGE_MS) {
      kept += 1;
      continue;
    }
    await options.provider.deleteImage(path, image.digest);
    deleted += 1;
  }
  return { deleted, kept };
}
