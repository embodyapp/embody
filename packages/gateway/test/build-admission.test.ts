import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileManifest, defineWorkflow, definePlugin, z } from "@embody/core";
import { BUILD_RECIPE, type DeploymentSubmission } from "@embody/cloud-contracts";
import {
  BUILD_DEADLINE_MS,
  BuildAdmission,
  CloudBuildProvider,
  MemoryBuildProvider,
  MemoryGatewayStore,
  MemorySourceObjectStore,
  GcsSourceObjectStore,
  ORPHAN_AGE_MS,
  artifactStatus,
  assembleScript,
  cleanupOrphanedImages,
  decideAdmission,
  planBuild,
  purgeArtifacts,
  sandboxScript,
  toProviderBuild,
  type BuildConfig,
  type BuildRecipeConfig,
  type SimulatedBuildResult,
} from "../src/index.js";
import { artifactStoreConformance } from "./artifact-store-conformance.js";

artifactStoreConformance("memory artifact store", () => Promise.resolve(new MemoryGatewayStore()));

const pin = (n: string) => `sha256:${createHash("sha256").update(n).digest("hex")}`;
const sha = (bytes: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const recipe: BuildRecipeConfig = {
  project: "embody-cloud",
  region: "us-central1",
  builderServiceAccount: "embody-builder@embody-cloud.iam.gserviceaccount.com",
  builderImage: `us-central1-docker.pkg.dev/embody-cloud/platform/builder@${pin("builder")}`,
  dockerImage: `gcr.io/cloud-builders/docker@${pin("docker")}`,
  runtimeImage: `docker.io/library/node:24-bookworm-slim@${pin("node")}`,
  imageRepository: "us-central1-docker.pkg.dev/embody-cloud/builds",
  outputBucket: "embody-build-outputs",
  logsBucket: "embody-build-logs",
};

const followUp = defineWorkflow(z.object({ title: z.string() }))({
  version: "0.1.0",
  steps: { remind: { handler: () => ({ ok: true }) } },
});
const requestOnlyPlugins = [
  definePlugin({
    id: "app",
    version: "0.1.0",
    entities: { card: { schema: z.object({ title: z.string() }) } },
    actions: { ping: { effect: "read", input: z.object({}), handler: () => ({ ok: true }) } },
  }),
];
const durablePlugins = [
  definePlugin({
    id: "app",
    version: "0.1.0",
    events: { "app.submitted": () => undefined },
    workflows: { followUp },
  }),
];
interface Honest {
  readonly plugins?: typeof requestOnlyPlugins;
  readonly publishes?: string[];
  readonly preflight?: { requestOnly: boolean; durable: boolean };
  readonly audit?: { critical: number; high: number; moderate: number; low: number };
  readonly status?: SimulatedBuildResult["status"];
  readonly mutate?: (output: Record<string, unknown>) => void;
  readonly log?: string;
}
/** What the real recipe would produce for an honest build of `plugins`. */
function honestBuild(config: BuildConfig, options: Honest = {}): SimulatedBuildResult {
  const prefix = config.artifacts.objects.location.replace(/^gs:\/\/[^/]+\//, "");
  const output: Record<string, unknown> = {
    format: "embody-build-output-v1",
    recipe: BUILD_RECIPE.id,
    nodeVersion: "v24.22.0",
    appId: "my-app",
    appVersion: "0.1.0",
    preflight: options.preflight ?? { requestOnly: true, durable: true },
    publishes: options.publishes ?? [],
    catalog: compileManifest(options.plugins ?? requestOnlyPlugins),
  };
  options.mutate?.(output);
  const manifest = Buffer.from(JSON.stringify(output));
  const sbom = Buffer.from('{"bomFormat":"CycloneDX"}\n');
  const source = config.steps[0]!.env.find((e) => e.startsWith("EMBODY_SOURCE_DIGEST="))!.split(
    "=",
  )[1];
  return {
    status: options.status ?? "SUCCESS",
    outputs: { [`${prefix}manifest.json`]: manifest, [`${prefix}sbom.json`]: sbom },
    stepOutputs: [
      JSON.stringify({
        recipe: BUILD_RECIPE.id,
        sourceDigest: source,
        treeDigest: pin("tree"),
        lockfileDigest: pin("lock"),
        sbomDigest: sha(sbom),
        packages: 200,
        audit: options.audit ?? { critical: 0, high: 1, moderate: 0, low: 0 },
      }),
      "",
      JSON.stringify({ manifestDigest: sha(manifest), outputBytes: 1234 }),
    ],
    images: [{ name: config.images[0]!, digest: pin(`image-${config.images[0]}`) }],
    log: options.log ?? "Step #1: building\n",
  };
}

const capabilities = {
  requestOnly: {
    profile: "request-only-v1",
    crud: true,
    boundedActions: true,
    workflows: false,
    schedules: false,
    subscriptions: false,
    appToAppRpc: false,
    persistentLocalState: false,
    genui: false,
  },
  durable: {
    profile: "durable-v1",
    crud: true,
    boundedActions: true,
    workflows: true,
    events: true,
    subscriptions: true,
    schedules: false,
    appToAppRpc: false,
    persistentLocalState: false,
    genui: false,
  },
} as const;

async function fixture(
  behaviour: (config: BuildConfig) => SimulatedBuildResult | undefined = (c) => honestBuild(c),
) {
  let now = new Date("2030-01-01T00:00:00.000Z");
  const clock = { now: () => now };
  const store = new MemoryGatewayStore();
  const objects = new MemorySourceObjectStore({ clock });
  const provider = new MemoryBuildProvider(behaviour, clock);
  await store.createWorkspace("ws_build00001");
  const { record } = await store.admitSource({
    workspaceId: "ws_build00001",
    appId: "app_build00001",
    idempotencyKey: "sha256_key_00000000001",
    digest: pin("source"),
    bytes: 100,
    actorId: "alice",
    now,
  });
  const verified = await store.updateSource(
    { ...record, state: "verified", verifiedAt: now.toISOString() },
    record.revision,
  );
  const submission = (caps: DeploymentSubmission["capabilities"] = capabilities.requestOnly) =>
    ({
      version: 1,
      workspaceId: "ws_build00001",
      appId: "app_build00001",
      idempotencyKey: "deploy_key_00000001",
      source: { uploadId: verified.uploadId, digest: pin("source"), bytes: 100 },
      expectedGeneration: 0,
      capabilities: caps,
      secretReferences: [],
    }) as unknown as DeploymentSubmission;
  const admission = new BuildAdmission({ store, provider, recipe, sources: objects, clock });
  return {
    store,
    objects,
    provider,
    admission,
    submission,
    verified,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    clock,
  };
}
async function buildOnce(f: Awaited<ReturnType<typeof fixture>>, caps = capabilities.requestOnly) {
  const submission = f.submission(caps);
  const started = await f.admission.start({
    submission,
    deploymentId: "dep_build00001",
    attempt: 1,
  });
  f.provider.completeAll();
  return f.admission.settle(started, submission);
}

describe("M11 build plan (trusted recipe, no customer Dockerfile)", () => {
  const plan = planBuild(recipe, {
    workspaceId: "ws_build00001",
    appId: "app_build00001",
    deploymentId: "dep_build00001",
    artifactId: "art_build00001",
    sourceDigest: pin("source"),
    sourceBytes: 100,
    sourceUrl: "https://storage.googleapis.com/b/o?X-Goog-Signature=abc",
  });
  it("pins every image by digest and binds the build to its identity", () => {
    expect(plan.config.steps.map((s) => s.name)).toEqual([
      recipe.builderImage,
      recipe.dockerImage,
      recipe.dockerImage,
    ]);
    expect(plan.image).toBe(
      "us-central1-docker.pkg.dev/embody-cloud/builds/ws_build00001/app_build00001:art_build00001",
    );
    expect(plan.config.serviceAccount).toBe(
      `projects/embody-cloud/serviceAccounts/${recipe.builderServiceAccount}`,
    );
    expect(plan.config.options.logging).toBe("GCS_ONLY");
    expect(plan.config.timeout).toBe(`${BUILD_RECIPE.maxBuildSeconds}s`);
    expect(plan.config.artifacts.objects.location).toBe(
      "gs://embody-build-outputs/builds/ws_build00001/app_build00001/art_build00001/",
    );
    // The source URL is only a substitution and is outside the provenance digest.
    expect(JSON.stringify(plan.config.steps)).not.toContain("X-Goog-Signature");
    const other = planBuild(recipe, {
      workspaceId: "ws_build00001",
      appId: "app_build00001",
      deploymentId: "dep_build00001",
      artifactId: "art_build00001",
      sourceDigest: pin("source"),
      sourceBytes: 100,
      sourceUrl: "https://storage.googleapis.com/other",
    });
    expect(other.configDigest).toBe(plan.configDigest);
    for (const unpinned of [
      { builderImage: "us-central1-docker.pkg.dev/embody-cloud/platform/builder:latest" },
      { runtimeImage: "node:24" },
      { dockerImage: "gcr.io/cloud-builders/docker" },
      { builderServiceAccount: "user@example.com" },
    ])
      expect(() =>
        planBuild(
          { ...recipe, ...unpinned },
          {
            workspaceId: "ws_build00001",
            appId: "app_build00001",
            deploymentId: "dep_build00001",
            artifactId: "art_build00001",
            sourceDigest: pin("source"),
            sourceBytes: 100,
            sourceUrl: "https://x",
          },
        ),
      ).toThrow(/pinned/);
  });
  it("runs customer code only in a no-network, unprivileged, bounded sandbox", () => {
    const script = sandboxScript();
    for (const flag of [
      "--network none",
      "--user node ",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      `--memory ${BUILD_RECIPE.sandbox.memoryBytes}`,
      `--memory-swap ${BUILD_RECIPE.sandbox.memoryBytes}`,
      `--pids-limit ${BUILD_RECIPE.sandbox.pids}`,
      `--cpus ${BUILD_RECIPE.sandbox.cpus}`,
      "--env-file /dev/null",
      `timeout -k 10 ${BUILD_RECIPE.sandboxSeconds}`,
    ])
      expect(script).toContain(flag);
    // Input baked into an image, output by docker cp; never a mount of the workspace or socket.
    expect(script).not.toMatch(/-v |--volume|--mount|docker\.sock|--privileged/);
    expect(script).not.toContain("docker cp -a");
    expect(script).toMatch(/COPY --chown=node:node src\/ \/app\//);
    expect(script).not.toMatch(/^RUN /m);
    const assemble = assembleScript();
    expect(assemble).toContain("--network none");
    expect(assemble).not.toMatch(/^RUN /m);
    expect(assemble).toContain("COPY --chown=node:node . /app");
    // Cloud Build substitutes `$X`: every literal dollar in a script is escaped.
    expect(plan.config.steps[1]!.args[1]).not.toMatch(/(^|[^$])\$[A-Za-z{(]/);
  });
});

describe("M11 admission decisions", () => {
  it("admits an honest request-only build by digest with provenance and SBOM", async () => {
    const f = await fixture();
    const record = await buildOnce(f);
    expect(record.state).toBe("admitted");
    expect(record.imageReference).toMatch(
      /^us-central1-docker\.pkg\.dev\/embody-cloud\/builds\/ws_build00001\/app_build00001@sha256:[a-f0-9]{64}$/,
    );
    expect(record.manifest).toMatchObject({
      profile: "request-only-v1",
      publishes: [],
      subscriptions: [],
      workflows: [],
    });
    expect(record.provenance).toMatchObject({
      builder: recipe.builderServiceAccount,
      configDigest: record.configDigest,
    });
    expect(artifactStatus(record)).toMatchObject({
      state: "admitted",
      imageDigest: record.imageDigest,
    });
    // The source URL handed to the build is a signed GET for exactly the verified object.
    const url = new URL(f.provider.submitted[0]!.substitutions._SOURCE_URL);
    expect(url.pathname).toBe(`/read/${f.verified.objectKey}`);
    const fetched = await f.objects.fetch(url.href);
    expect(fetched.status).toBe(404); // no bytes were stored in this unit fixture
    const tampered = new URL(url);
    tampered.pathname = tampered.pathname.replace("app_build00001", "app_other00001");
    expect((await f.objects.fetch(tampered.href)).status).toBe(403);
    expect((await f.objects.fetch(url.href, { method: "PUT", body: "x" })).status).toBe(403);
  });
  it("admits a durable build with its events, subscriptions and workflow versions", async () => {
    const f = await fixture((c) =>
      honestBuild(c, { plugins: durablePlugins as never, publishes: ["app.submitted"] }),
    );
    const record = await buildOnce(f, capabilities.durable as never);
    expect(record.state).toBe("admitted");
    expect(record.manifest).toMatchObject({
      profile: "durable-v1",
      publishes: ["app.submitted"],
      subscriptions: ["app.submitted"],
      workflows: [
        { target: "app.followUp", version: "0.1.0", steps: [{ name: "remind", dependsOn: [] }] },
      ],
    });
  });
  const cases: [string, (c: BuildConfig) => SimulatedBuildResult | undefined, string, unknown?][] =
    [
      [
        "failed build",
        (c) => ({ ...honestBuild(c), status: "FAILURE", images: [] }),
        "BUILD_FAILED",
      ],
      [
        "provider timeout",
        (c) => ({ ...honestBuild(c), status: "TIMEOUT", images: [] }),
        "BUILD_TIMEOUT",
      ],
      [
        "provider internal error",
        (c) => ({ ...honestBuild(c), status: "INTERNAL_ERROR" }),
        "DEPENDENCY_UNAVAILABLE",
      ],
      [
        "prepare policy rejection",
        () => ({ status: "FAILURE", stepOutputs: ['{"rejected":"LOCKFILE_REJECTED"}'] }),
        "LOCKFILE_REJECTED",
      ],
      [
        "prepare claims an unknown code",
        () => ({ status: "FAILURE", stepOutputs: ['{"rejected":"ADMITTED"}'] }),
        "BUILD_FAILED",
      ],
      [
        "output limit",
        (c) => ({
          status: "FAILURE",
          stepOutputs: [honestBuild(c).stepOutputs![0]!, "", '{"rejected":"OUTPUT_LIMIT"}'],
        }),
        "OUTPUT_LIMIT",
      ],
      [
        "blocking vulnerability",
        (c) => honestBuild(c, { audit: { critical: 1, high: 0, moderate: 0, low: 0 } }),
        "VULNERABILITY_POLICY",
      ],
      [
        "manifest substituted after the build",
        (c) => {
          const r = honestBuild(c);
          const key = Object.keys(r.outputs!).find((k) => k.endsWith("manifest.json"))!;
          return { ...r, outputs: { ...r.outputs, [key]: Buffer.from("{}") } };
        },
        "MANIFEST_MISMATCH",
      ],
      [
        "SBOM substituted after the build",
        (c) => {
          const r = honestBuild(c);
          const key = Object.keys(r.outputs!).find((k) => k.endsWith("sbom.json"))!;
          return { ...r, outputs: { ...r.outputs, [key]: Buffer.from("{}") } };
        },
        "MANIFEST_MISMATCH",
      ],
      ["missing manifest", (c) => ({ ...honestBuild(c), outputs: {} }), "MANIFEST_INVALID"],
      [
        "invalid catalog",
        (c) => honestBuild(c, { mutate: (o) => (o["catalog"] = { protocolVersion: 2 }) }),
        "MANIFEST_INVALID",
      ],
      [
        "unknown output field",
        (c) => honestBuild(c, { mutate: (o) => (o["secrets"] = ["x"]) }),
        "MANIFEST_INVALID",
      ],
      [
        "image under another name",
        (c) => ({
          ...honestBuild(c),
          images: [{ name: `${c.images[0]}-other`, digest: pin("x") }],
        }),
        "IMAGE_INVALID",
      ],
      [
        "second image",
        (c) => ({
          ...honestBuild(c),
          images: [
            ...honestBuild(c).images!,
            { name: c.images[0]!.replace("app_build00001", "app_other00001"), digest: pin("y") },
          ],
        }),
        "IMAGE_INVALID",
      ],
      [
        "tag instead of digest",
        (c) => ({ ...honestBuild(c), images: [{ name: c.images[0]!, digest: "latest" }] }),
        "IMAGE_INVALID",
      ],
      [
        "prepare output for another source",
        (c) => {
          const r = honestBuild(c);
          const prepared = JSON.parse(r.stepOutputs![0]!) as Record<string, unknown>;
          return {
            ...r,
            stepOutputs: [
              JSON.stringify({ ...prepared, sourceDigest: pin("other") }),
              "",
              r.stepOutputs![2]!,
            ],
          };
        },
        "PROVENANCE_INVALID",
      ],
      [
        "missing trusted step output",
        (c) => ({ ...honestBuild(c), stepOutputs: [] }),
        "PROVENANCE_INVALID",
      ],
      [
        "request-only app with workflows",
        (c) => honestBuild(c, { plugins: durablePlugins as never }),
        "UNSUPPORTED_PROFILE",
      ],
      [
        "request-only app that failed its preflight",
        (c) => honestBuild(c, { preflight: { requestOnly: false, durable: true } }),
        "UNSUPPORTED_PROFILE",
      ],
      [
        "request-only app that declares publishes",
        (c) => honestBuild(c, { publishes: ["app.created"] }),
        "UNSUPPORTED_PROFILE",
      ],
    ];
  for (const [name, behaviour, code] of cases)
    it(`rejects ${name} (${code}) and never exposes an image`, async () => {
      const f = await fixture(behaviour);
      const record = await buildOnce(f);
      expect(record.state).toBe("rejected");
      expect(record.error).toBe(code);
      expect(record.imageReference).toBeUndefined();
      expect(record.manifest).toBeUndefined();
      expect(artifactStatus(record).imageDigest).toBeUndefined();
      expect(f.provider.deletedPrefixes).toContain(record.outputPrefix);
      if (record.imageDigest)
        expect(f.provider.deletedImages).toContain(
          `ws_build00001/app_build00001@${record.imageDigest}`,
        );
    });
  it("deletes an image pushed by a build that failed afterwards (no reported digest)", async () => {
    const f = await fixture((c) => ({
      status: "FAILURE",
      stepOutputs: honestBuild(c).stepOutputs ?? [],
      images: [{ name: c.images[0]!, digest: pin("pushed-then-failed") }],
    }));
    const submission = f.submission();
    const started = await f.admission.start({
      submission,
      deploymentId: "dep_build00001",
      attempt: 1,
    });
    f.provider.completeAll();
    // Cloud Build reports no image for a build that failed after its push.
    const get = f.provider.get.bind(f.provider);
    f.provider.get = async (id) => ({ ...(await get(id)), images: [] });
    const record = await f.admission.settle(started, submission);
    expect(record).toMatchObject({ state: "rejected", error: "BUILD_FAILED" });
    expect(record.imageDigest).toBeUndefined();
    expect(f.provider.images.get("ws_build00001/app_build00001")).toEqual([]);
  });
  it("rejects durable capability mismatches both ways", async () => {
    for (const caps of [
      { ...capabilities.durable, workflows: false },
      { ...capabilities.durable, subscriptions: false },
      { ...capabilities.durable, events: false },
    ]) {
      const f = await fixture((c) =>
        honestBuild(c, { plugins: durablePlugins as never, publishes: ["app.submitted"] }),
      );
      expect((await buildOnce(f, caps as never)).error).toBe("CAPABILITY_MISMATCH");
    }
    const f = await fixture((c) => honestBuild(c));
    expect((await buildOnce(f, capabilities.durable as never)).error).toBe("CAPABILITY_MISMATCH");
    const g = await fixture((c) =>
      honestBuild(c, {
        plugins: durablePlugins as never,
        preflight: { requestOnly: false, durable: false },
      }),
    );
    expect((await buildOnce(g, { ...capabilities.durable, events: false } as never)).error).toBe(
      "UNSUPPORTED_PROFILE",
    );
  });
  it("rejects a build whose provider record differs from the platform plan", async () => {
    const f = await fixture();
    const submission = f.submission();
    const started = await f.admission.start({
      submission,
      deploymentId: "dep_build00001",
      attempt: 1,
    });
    f.provider.completeAll();
    const build = await f.provider.get(started.buildId!);
    for (const config of [
      {
        ...build.config,
        serviceAccount: "projects/x/serviceAccounts/other@x.iam.gserviceaccount.com",
      },
      {
        ...build.config,
        steps: build.config.steps.map((s, i) => (i === 1 ? { ...s, args: ["-c", "true"] } : s)),
      },
      {
        ...build.config,
        images: ["us-central1-docker.pkg.dev/embody-cloud/builds/ws_x/app_x:art_x"],
      },
      { ...build.config, timeout: "86400s" },
    ]) {
      const decision = await decideAdmission({
        plan: started,
        record: started,
        submission,
        build: { ...build, config },
        readOutput: (p, m) => f.provider.readOutput(p, m),
      });
      expect(decision).toMatchObject({ admitted: false, code: "PROVENANCE_INVALID" });
    }
  });
});

describe("M11 build orchestration", () => {
  it("refuses unverified, foreign or mismatched sources before allocating a build", async () => {
    const f = await fixture();
    const base = f.submission();
    for (const submission of [
      { ...base, source: { ...base.source, digest: pin("other") } },
      { ...base, source: { ...base.source, bytes: 101 } },
      { ...base, appId: "app_other00001" },
      { ...base, source: { ...base.source, uploadId: "src_missing0001" } },
    ])
      await expect(
        f.admission.start({
          submission: submission as DeploymentSubmission,
          deploymentId: "dep_build00001",
          attempt: 1,
        }),
      ).rejects.toMatchObject({ code: "SOURCE_INVALID" });
    expect(f.provider.submitted).toHaveLength(0);
    // Expired retention is not a source either.
    f.advance(8 * 86_400_000);
    await expect(
      f.admission.start({ submission: base, deploymentId: "dep_build00001", attempt: 1 }),
    ).rejects.toMatchObject({ code: "SOURCE_INVALID" });
  });
  it("is idempotent per attempt and recovers a crash between submit and record", async () => {
    const f = await fixture();
    const submission = f.submission();
    const first = await f.admission.start({
      submission,
      deploymentId: "dep_build00001",
      attempt: 1,
    });
    const again = await f.admission.start({
      submission,
      deploymentId: "dep_build00001",
      attempt: 1,
    });
    expect(again.artifactId).toBe(first.artifactId);
    expect(f.provider.submitted).toHaveLength(1);
    expect(f.provider.submitted).toHaveLength(1);
    // Crash between provider submit and recording the build ID: the next attempt finds the
    // provider build by its tag instead of submitting a second one.
    const g = await fixture();
    const sub = g.submission();
    const update = g.store.updateArtifact.bind(g.store);
    let crash = true;
    g.store.updateArtifact = (next, expected) => {
      if (crash && next.buildId) {
        crash = false;
        return Promise.reject(new Error("process died"));
      }
      return update(next, expected);
    };
    await expect(
      g.admission.start({ submission: sub, deploymentId: "dep_build00001", attempt: 1 }),
    ).rejects.toThrow("process died");
    const orphaned = await g.store.artifactForAttempt(
      "ws_build00001",
      "app_build00001",
      "dep_build00001",
      1,
    );
    expect(orphaned?.buildId).toBeUndefined();
    const recovered = await g.admission.settle(orphaned!, sub);
    expect(recovered.buildId).toBeDefined();
    expect(g.provider.submitted).toHaveLength(1);
    // The build ID is immutable once recorded.
    await expect(
      g.store.updateArtifact({ ...recovered, buildId: "other" }, recovered.revision),
    ).rejects.toThrow();
    const second = await f.admission.start({
      submission,
      deploymentId: "dep_build00001",
      attempt: 2,
    });
    expect(second.artifactId).not.toBe(first.artifactId);
    expect(f.provider.submitted).toHaveLength(2);
    await expect(
      f.admission.start({ submission, deploymentId: "dep_build00001", attempt: 4 }),
    ).rejects.toThrow();
  });
  it("settles exactly once and keeps a running build pending until its deadline", async () => {
    const f = await fixture(() => undefined);
    const submission = f.submission();
    const started = await f.admission.start({
      submission,
      deploymentId: "dep_build00001",
      attempt: 1,
    });
    f.provider.completeAll();
    expect((await f.admission.settle(started, submission)).state).toBe("building");
    f.advance(BUILD_DEADLINE_MS + 1);
    const timedOut = await f.admission.settle(started, submission);
    expect(timedOut).toMatchObject({ state: "rejected", error: "BUILD_TIMEOUT" });
    expect((await f.provider.get(started.buildId!)).status).toBe("CANCELLED");
    // A stale settle of the old revision cannot overwrite the decision.
    await expect(f.admission.settle(started, submission)).rejects.toThrow();
    expect(await f.admission.settle(timedOut, submission)).toEqual(timedOut);
  });
  it("redacts logs before an authorized reader sees them", async () => {
    const f = await fixture((c) =>
      honestBuild(c, { log: "ok\ntoken ya29.a0AfH6SMBcanarycanarycanary\n" }),
    );
    const record = await buildOnce(f);
    const log = await f.admission.log(record);
    expect(log).toContain("ok");
    expect(log).not.toContain("ya29.");
  });
  it("purges expired artifacts and orphaned images but keeps pinned and recent ones", async () => {
    const f = await fixture();
    const admitted = await buildOnce(f);
    const pinned = await f.store.updateArtifact(
      { ...admitted, pinnedBy: "rel_aaaaaaaa" },
      admitted.revision,
    );
    // Second app attempt, rejected.
    const failing = await fixture((c) => ({ ...honestBuild(c), status: "FAILURE" }));
    const rejected = await buildOnce(failing);
    expect(rejected.state).toBe("rejected");
    const later = new Date(Date.parse(admitted.retainUntil) + 1000);
    expect(
      await purgeArtifacts({ store: f.store, provider: f.provider, now: later }),
    ).toMatchObject({
      deleted: 0,
    });
    await f.store.updateArtifact({ ...pinned, pinnedBy: undefined } as never, pinned.revision);
    const result = await purgeArtifacts({ store: f.store, provider: f.provider, now: later });
    expect(result).toEqual({ deleted: 1, failed: 0, skipped: 0 });
    expect(f.provider.deletedImages).toContain(
      `ws_build00001/app_build00001@${admitted.imageDigest}`,
    );
    expect(f.provider.deletedPrefixes).toContain(
      `logs/ws_build00001/app_build00001/${admitted.artifactId}/`,
    );
    expect(
      await f.store.artifact("ws_build00001", "app_build00001", admitted.artifactId),
    ).toBeNull();
    expect(
      (
        await purgeArtifacts({
          store: failing.store,
          provider: failing.provider,
          now: new Date(Date.parse(rejected.retainUntil) + 1),
        })
      ).deleted,
    ).toBe(1);

    const orphan = await fixture();
    const kept = await buildOnce(orphan);
    orphan.provider.images
      .get("ws_build00001/app_build00001")!
      .push(
        { digest: pin("orphan-old"), createdAt: "2029-12-01T00:00:00.000Z", tags: [] },
        { digest: pin("orphan-new"), createdAt: orphan.clock.now().toISOString(), tags: [] },
      );
    const cleaned = await cleanupOrphanedImages({
      store: orphan.store,
      provider: orphan.provider,
      workspaceId: "ws_build00001",
      appId: "app_build00001",
      now: new Date(orphan.clock.now().getTime() + ORPHAN_AGE_MS / 2),
    });
    expect(cleaned).toEqual({ deleted: 1, kept: 2 });
    expect(orphan.provider.deletedImages).toEqual([
      `ws_build00001/app_build00001@${pin("orphan-old")}`,
    ]);
    expect(kept.state).toBe("admitted");
  });
});

describe("M11 provider adapters (request shape only; not provider evidence)", () => {
  it("submits to the regional Cloud Build API and maps only platform-set fields", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const provider = new CloudBuildProvider({
      recipe,
      accessToken: () => Promise.resolve("token-1"),
      fetch: (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        calls.push({ url, init: init ?? {} });
        if (url.endsWith("/builds"))
          return Promise.resolve(Response.json({ metadata: { build: { id: "0b1c2d3e-aaaa" } } }));
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    });
    const plan = planBuild(recipe, {
      workspaceId: "ws_build00001",
      appId: "app_build00001",
      deploymentId: "dep_build00001",
      artifactId: "art_build00001",
      sourceDigest: pin("source"),
      sourceBytes: 100,
      sourceUrl: "https://storage.googleapis.com/x",
    });
    expect(await provider.submit(plan.config)).toEqual({ buildId: "0b1c2d3e-aaaa" });
    expect(calls[0]!.url).toBe(
      "https://cloudbuild.googleapis.com/v1/projects/embody-cloud/locations/us-central1/builds",
    );
    expect(calls[0]!.init.redirect).toBe("error");
    await provider.deleteImage("ws_build00001/app_build00001", pin("img"));
    expect(calls[1]!.url).toBe(
      `https://artifactregistry.googleapis.com/v1/projects/embody-cloud/locations/us-central1/repositories/builds/packages/ws_build00001%2Fapp_build00001/versions/${encodeURIComponent(pin("img"))}?force=true`,
    );
    await expect(provider.deleteImage("../other", pin("img"))).rejects.toThrow();
    // Deletes are operations: a failed one is an error, not a deletion.
    const op = (done: boolean, error?: unknown) =>
      Response.json({
        name: "projects/embody-cloud/locations/us-central1/operations/op-1",
        done,
        ...(error ? { error } : {}),
      });
    const replies = [
      op(false),
      op(true, { code: 9, message: "manifest is referenced by parent manifests" }),
    ];
    const failing = new CloudBuildProvider({
      recipe,
      accessToken: () => Promise.resolve("token-1"),
      pollMs: 1,
      fetch: () => Promise.resolve(replies.shift()!),
    });
    await expect(failing.deleteImage("ws_build00001/app_build00001", pin("img"))).rejects.toThrow(
      "Image delete failed",
    );
    const ok = [op(false), op(true)];
    const succeeding = new CloudBuildProvider({
      recipe,
      accessToken: () => Promise.resolve("token-1"),
      pollMs: 1,
      fetch: () => Promise.resolve(ok.shift()!),
    });
    await expect(
      succeeding.deleteImage("ws_build00001/app_build00001", pin("img")),
    ).resolves.toBeUndefined();
    const gone = [op(true, { code: 5, message: "not found" })];
    const deleted = new CloudBuildProvider({
      recipe,
      accessToken: () => Promise.resolve("token-1"),
      fetch: () => Promise.resolve(gone.shift()!),
    });
    await expect(
      deleted.deleteImage("ws_build00001/app_build00001", pin("img")),
    ).resolves.toBeUndefined();
    await expect(provider.readOutput("../etc/passwd", 10)).rejects.toThrow();
    const record = toProviderBuild({
      id: "0b1c2d3e-aaaa",
      status: "SUCCESS",
      ...plan.config,
      steps: plan.config.steps.map((s) => ({ ...s, status: "SUCCESS", timing: {} })),
      results: {
        images: [{ name: plan.image, digest: pin("img") }],
        buildStepOutputs: [Buffer.from("{}").toString("base64"), "", ""],
      },
    });
    expect(record.stepOutputs[0]).toBe("{}");
    expect(record.config.steps[0]).not.toHaveProperty("status");
    expect(() => toProviderBuild({ id: "0b1c2d3e-aaaa", status: "DONE" })).toThrow();
  });
  it("signs builder read access with a separate read-only signer", () => {
    expect(
      () =>
        new GcsSourceObjectStore({
          bucket: "embody-sources",
          signerEmail: "signer@p.iam.gserviceaccount.com",
          readSignerEmail: "signer@p.iam.gserviceaccount.com",
        }),
    ).toThrow(/separate/);
    const store = new GcsSourceObjectStore({
      bucket: "embody-sources",
      signerEmail: "signer@p.iam.gserviceaccount.com",
      readSignerEmail: "reader@p.iam.gserviceaccount.com",
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    const key = "sources/ws_build00001/app_build00001/src_aaaaaaaa.tar.gz";
    const read = store.canonical({
      objectKey: key,
      expiresAt: new Date("2030-01-01T00:10:00.000Z"),
      method: "GET",
    });
    expect(read.canonicalRequest.startsWith("GET\n/embody-sources/sources/")).toBe(true);
    expect(read.url.searchParams.get("X-Goog-Credential")).toMatch(/^reader@/);
    expect(read.url.searchParams.get("X-Goog-SignedHeaders")).toBe("host");
    const upload = store.canonical({
      objectKey: key,
      bytes: 1,
      contentType: "application/gzip",
      expiresAt: new Date("2030-01-01T00:10:00.000Z"),
    });
    expect(upload.url.searchParams.get("X-Goog-Credential")).toMatch(/^signer@/);
    expect(() =>
      store.canonical({
        objectKey: key,
        expiresAt: new Date("2030-01-01T01:00:00.000Z"),
        method: "GET",
      }),
    ).toThrow();
    const noReader = new GcsSourceObjectStore({
      bucket: "embody-sources",
      signerEmail: "signer@p.iam.gserviceaccount.com",
    });
    expect(() =>
      noReader.canonical({
        objectKey: key,
        expiresAt: new Date(Date.now() + 60_000),
        method: "GET",
      }),
    ).toThrow(/not configured/);
  });
});
