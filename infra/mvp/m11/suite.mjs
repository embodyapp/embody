// M11 acceptance cases, shared by the local Docker run (test:m11) and the live Cloud Build suite
// (test:mvp:cloud suite m11). The caller supplies the build provider, a source store that can
// issue read access, the built gateway/contracts modules and a `runnable` check that runs an
// admitted image. Pure evaluators decide each case from recorded facts.
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { M11_FIXTURES, createFixture } from "./fixtures.mjs";

const { Buffer } = globalThis;
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const DAY = 86_400_000;

export const PROBE_EXPECTATIONS = Object.freeze({
  metadataIp: "blocked",
  metadataHost: "blocked",
  publicRegistry: "blocked",
  storageApi: "blocked",
  cloudRunApi: "blocked",
  otherSource: "blocked",
  dockerSocket: false,
  workspaceVisible: false,
  builderOutputsVisible: false,
  canWriteRecipe: false,
  uid: 1000,
});
/** Probe report → checks. More processes than the sandbox allows must not start. */
export function evaluateProbe(report, pidsLimit) {
  if (!report || typeof report !== "object") return { pass: false, checks: { reported: false } };
  const checks = { reported: true };
  for (const [key, expected] of Object.entries(PROBE_EXPECTATIONS))
    checks[key] = report[key] === expected;
  checks.noPlatformEnv = Array.isArray(report.platformEnv) && report.platformEnv.length === 0;
  checks.processesBounded =
    Number.isInteger(report.processesStarted) && report.processesStarted < pidsLimit;
  return { pass: Object.values(checks).every(Boolean), checks };
}
export function probeReport(log) {
  const line = log.split("\n").find((l) => l.includes("EMBODY_PROBE {"));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(line.indexOf("EMBODY_PROBE ") + "EMBODY_PROBE ".length));
  } catch {
    return null;
  }
}
export const CANARIES = Object.freeze([
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7canary0000000",
  "ya29.a0canarycanarycanarycanary0000",
  "deadbeefcanary",
]);
export function evaluateRedaction(raw, redacted) {
  const checks = {
    injected: CANARIES.every((canary) => raw.includes(canary)),
    redacted: CANARIES.every((canary) => !redacted.includes(canary)),
    marked: redacted.includes("[REDACTED]"),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
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
  durable: (overrides = {}) => ({
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
    ...overrides,
  }),
};

/**
 * deps: { gateway, contracts, createApp, provider, sources (createReadAccess + putRaw/write),
 *   store, recipe, registryUrl, scratch, runnable(record) → {pass,...}, wait(ms), pidsLimit,
 *   putSource(objectKey, bytes), foreignSourceUrl(objectKey) }
 */
export async function runM11Cases(deps) {
  const { gateway: g, contracts: c } = deps;
  const run = randomBytes(3).toString("hex");
  const workspaceId = `ws_m11${run}`;
  await deps.store.createWorkspace(workspaceId);
  const admission = new g.BuildAdmission({
    store: deps.store,
    provider: deps.provider,
    recipe: deps.recipe,
    sources: deps.sources,
  });
  const cases = {};
  const record = async (name, fn) => {
    try {
      const result = await fn();
      cases[name] = { pass: result.pass === true, ...result };
    } catch (error) {
      cases[name] = { pass: false, error: String(error?.message ?? error).slice(0, 200) };
    }
  };

  // Admit each fixture as a verified M10 source of its own app.
  const sources = {};
  let index = 0;
  const admitSource = async (kind, packed) => {
    const appId = `app_m11${run}${String(index++).padStart(2, "0")}`;
    const { record: pending } = await deps.store.admitSource({
      workspaceId,
      appId,
      idempotencyKey: `sha256_${packed.digest.slice(7, 40)}`,
      digest: packed.digest,
      bytes: packed.bytes,
      actorId: "m11-suite",
      now: new Date(),
    });
    await deps.putSource(pending.objectKey, packed.archive);
    const summary = await c.inspectSourceArchive(packed.archive);
    const verified = await deps.store.updateSource(
      {
        ...pending,
        state: "verified",
        verifiedAt: new Date().toISOString(),
        files: summary.files,
        expandedBytes: summary.expandedBytes,
        treeDigest: summary.treeDigest,
      },
      pending.revision,
    );
    sources[kind] = { appId, packed, source: verified };
    return sources[kind];
  };
  const submission = (entry, caps) => ({
    version: 1,
    workspaceId,
    appId: entry.appId,
    idempotencyKey: `m11-${run}-${entry.appId}`,
    source: {
      uploadId: entry.source.uploadId,
      digest: entry.packed.digest,
      bytes: entry.packed.bytes,
    },
    expectedGeneration: 0,
    capabilities: caps,
    secretReferences: [],
  });

  // Fixtures. The probe embeds a live read URL for ANOTHER app's source (the clean scaffold).
  const fixturesRoot = join(deps.scratch, `fixtures-${run}`);
  await mkdir(fixturesRoot, { recursive: true });
  const fixtureDeps = {
    createApp: deps.createApp,
    packSource: c.packSource,
    registryUrl: deps.registryUrl,
  };
  const kinds = deps.kinds ?? Object.keys(M11_FIXTURES);
  await admitSource(
    "request-only",
    await createFixture("request-only", join(fixturesRoot, "request-only"), fixtureDeps),
  );
  const foreign = await deps.sources.createReadAccess({
    objectKey: sources["request-only"].source.objectKey,
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });
  for (const kind of kinds) {
    if (kind === "request-only") continue;
    await admitSource(
      kind,
      await createFixture(kind, join(fixturesRoot, kind), {
        ...fixtureDeps,
        foreignSourceUrl: deps.mapForeignUrl ? deps.mapForeignUrl(foreign.url) : foreign.url,
      }),
    );
  }

  // Builds: one per fixture, plus two profile-policy builds of the durable source.
  const jobs = kinds.map((kind) => ({
    name: kind,
    entry: sources[kind],
    caps:
      M11_FIXTURES[kind].profile === "durable" ? capabilities.durable() : capabilities.requestOnly,
    expect: M11_FIXTURES[kind].expect,
  }));
  if (sources.durable) {
    jobs.push({
      name: "durable-as-request-only",
      entry: sources.durable,
      caps: capabilities.requestOnly,
      expect: "UNSUPPORTED_PROFILE",
    });
    jobs.push({
      name: "durable-undeclared-workflows",
      entry: sources.durable,
      caps: capabilities.durable({ workflows: false }),
      expect: "CAPABILITY_MISMATCH",
    });
  }
  const results = {};
  let deployment = 0;
  for (const job of jobs) {
    job.submission = submission(job.entry, job.caps);
    job.deploymentId = `dep_m11${run}${String(deployment++).padStart(2, "0")}`;
    job.record = await admission.start({
      submission: job.submission,
      deploymentId: job.deploymentId,
      attempt: 1,
    });
  }
  const started = Date.now();
  const deadline = started + (deps.buildWaitMs ?? 40 * 60_000);
  while (jobs.some((job) => job.record.state === "building") && Date.now() < deadline) {
    await deps.wait(deps.pollMs ?? 10_000);
    for (const job of jobs)
      if (job.record.state === "building")
        job.record = await admission.settle(job.record, job.submission);
  }
  for (const job of jobs) {
    const outcome = job.record.state === "admitted" ? "admitted" : job.record.error;
    results[job.name] = {
      state: job.record.state,
      error: job.record.error ?? null,
      expect: job.expect,
      imageDigest: job.record.imageDigest ?? null,
      // Unexpected outcomes carry the redacted log tail for diagnosis.
      ...(outcome !== job.expect
        ? { logTail: (await admission.log(job.record)).split("\n").slice(-40).join("\n") }
        : {}),
    };
    if (deps.debugDir && outcome !== job.expect) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(deps.debugDir, `${job.name}.log`), await admission.log(job.record));
    }
  }
  const job = (name) => jobs.find((j) => j.name === name);
  const decided = (name) =>
    job(name) &&
    (job(name).expect === "admitted"
      ? job(name).record.state === "admitted"
      : job(name).record.state === "rejected" && job(name).record.error === job(name).expect);

  await record("M11.idempotent-start", async () => {
    const first = jobs[0];
    const before = deps.provider.submitted.length;
    const again = await admission.start({
      submission: first.submission,
      deploymentId: first.deploymentId,
      attempt: 1,
    });
    return {
      pass:
        again.artifactId === first.record.artifactId && deps.provider.submitted.length === before,
      submittedBefore: before,
      submittedAfter: deps.provider.submitted.length,
    };
  });

  for (const [name, profile] of [
    ["request-only", "request-only-v1"],
    ["durable", "durable-v1"],
  ]) {
    if (!job(name)) continue;
    await record(`M11.c.scaffold-${name}`, async () => {
      const r = job(name).record;
      const checks = {
        admitted: r.state === "admitted",
        digestReference: /@sha256:[a-f0-9]{64}$/.test(r.imageReference ?? ""),
        profile: r.manifest?.profile === profile,
        boundToSource: r.sourceDigest === job(name).entry.packed.digest,
        provenance: r.provenance?.configDigest === r.configDigest && Boolean(r.provenance?.buildId),
        sbom: /^sha256:/.test(r.sbomDigest ?? ""),
        ...(name === "durable"
          ? {
              publishes: JSON.stringify(r.manifest?.publishes) === '["app.submitted"]',
              subscriptions: JSON.stringify(r.manifest?.subscriptions) === '["app.submitted"]',
              workflows:
                r.manifest?.workflows.length === 1 &&
                r.manifest.workflows[0].target === "app.followUp" &&
                r.manifest.workflows[0].version === "0.1.0",
            }
          : {}),
      };
      const runnable = checks.admitted ? await deps.runnable(r) : { pass: false };
      checks.runnable = runnable.pass === true;
      return { pass: Object.values(checks).every(Boolean), checks, runnable, manifest: r.manifest };
    });
  }

  if (job("canary"))
    await record("M11.c.log-redaction", async () => {
      const r = job("canary").record;
      const raw = (await deps.provider.readLog(r.buildId, r.logsBucket, 4 * 1024 * 1024)) ?? "";
      const redacted = await admission.log(r);
      return { ...evaluateRedaction(raw, redacted), admitted: r.state === "admitted" };
    });

  if (job("probe"))
    await record("M11.a.sandbox-probe", async () => {
      const r = job("probe").record;
      const raw = (await deps.provider.readLog(r.buildId, r.logsBucket, 4 * 1024 * 1024)) ?? "";
      const report = probeReport(raw);
      const evaluation = evaluateProbe(report, deps.pidsLimit);
      return { ...evaluation, report, admitted: r.state === "admitted" };
    });

  await record("M11.a.resource-bounds", async () => {
    const checks = {};
    for (const name of ["memory-hog", "oversized"]) if (job(name)) checks[name] = decided(name);
    return {
      pass: Object.keys(checks).length > 0 && Object.values(checks).every(Boolean),
      checks,
      results,
    };
  });

  await record("M11.b.inputs-and-failures", async () => {
    const checks = {};
    for (const name of [
      "failing-build",
      "stale-lockfile",
      "tarball-lockfile",
      "missing-lockfile",
      "foreign-framework",
      "unsupported-package-manager",
      "durable-as-request-only",
      "durable-undeclared-workflows",
      "oversized-manifest",
    ])
      if (job(name)) checks[name] = decided(name);
    return { pass: Object.keys(checks).length > 0 && Object.values(checks).every(Boolean), checks };
  });

  // Substitution: replay admission on a real successful build with one input tampered.
  if (job("durable")?.record.state === "admitted")
    await record("M11.b.substitution", async () => {
      const r = job("durable").record;
      const build = await deps.provider.get(r.buildId);
      const read = (path, max) => deps.provider.readOutput(path, max);
      const decide = (over) =>
        g.decideAdmission({
          plan: r,
          record: r,
          submission: job("durable").submission,
          build,
          readOutput: read,
          ...over,
        });
      const tamperedManifest = async (path, max) => {
        const bytes = await read(path, max);
        if (!path.endsWith("manifest.json") || !bytes) return bytes;
        const text = Buffer.from(bytes).toString("utf8").replace('"app.submitted"', '"app.forged"');
        return Buffer.from(text);
      };
      const outcomes = {
        honest: await decide({}),
        manifest: await decide({ readOutput: tamperedManifest }),
        image: await decide({
          build: { ...build, images: [{ name: `${r.image}x`, digest: build.images[0]?.digest }] },
        }),
        extraImage: await decide({
          build: {
            ...build,
            images: [
              ...build.images,
              {
                name: r.image.replace(r.appId, "app_other0000"),
                digest: `sha256:${"0".repeat(64)}`,
              },
            ],
          },
        }),
        config: await decide({
          build: {
            ...build,
            config: {
              ...build.config,
              serviceAccount: "projects/x/serviceAccounts/attacker@x.iam.gserviceaccount.com",
            },
          },
        }),
        source: await decide({ record: { sourceDigest: sha("other") } }),
      };
      const codes = Object.fromEntries(
        Object.entries(outcomes).map(([k, v]) => [k, v.admitted ? "admitted" : v.code]),
      );
      const checks = {
        honest: codes.honest === "admitted",
        manifest: codes.manifest === "MANIFEST_MISMATCH",
        image: codes.image === "IMAGE_INVALID",
        extraImage: codes.extraImage === "IMAGE_INVALID",
        config: codes.config === "PROVENANCE_INVALID",
        source: codes.source === "PROVENANCE_INVALID",
      };
      return { pass: Object.values(checks).every(Boolean), checks, codes };
    });

  await record("M11.b.never-promotable", async () => {
    const rejected = jobs.filter((j) => j.record.state === "rejected");
    const leftovers = [];
    for (const j of rejected) {
      const images = await deps.provider.listImages(`${workspaceId}/${j.entry.appId}`);
      const known = new Set(
        jobs
          .filter((x) => x.entry.appId === j.entry.appId && x.record.state === "admitted")
          .map((x) => x.record.imageDigest),
      );
      for (const image of images) if (!known.has(image.digest)) leftovers.push(j.name);
    }
    const checks = {
      noReference: rejected.every((j) => !j.record.imageReference && !j.record.manifest),
      statusHasNoImage: rejected.every((j) => g.artifactStatus(j.record).imageDigest === undefined),
      rejectedImagesDeleted: leftovers.length === 0,
      allDecided: jobs.every((j) => j.record.state !== "building"),
    };
    return { pass: Object.values(checks).every(Boolean), checks, leftovers };
  });

  // Tags are mutable and never deployed. Repointing an admitted artifact's tag at another image
  // (what a stolen builder token could do) changes neither its record nor a fresh decision.
  if (
    deps.retag &&
    job("durable")?.record.state === "admitted" &&
    job("request-only")?.record.state === "admitted"
  )
    await record("M11.b.retag", async () => {
      const durable = job("durable");
      const other = job("request-only").record;
      await deps.retag(durable.record.image, other.imageReference);
      const decision = await g.decideAdmission({
        plan: durable.record,
        record: durable.record,
        submission: durable.submission,
        build: await deps.provider.get(durable.record.buildId),
        readOutput: (path, max) => deps.provider.readOutput(path, max),
      });
      const checks = {
        referenceUnchanged: durable.record.imageReference.endsWith(
          `@${durable.record.imageDigest}`,
        ),
        redecidedSameDigest:
          decision.admitted === true && decision.imageDigest === durable.record.imageDigest,
      };
      return { pass: Object.values(checks).every(Boolean), checks };
    });

  await record("M11.step5.retention", async () => {
    const future = new Date(Date.now() + 91 * DAY);
    const purged = await g.purgeArtifacts({
      store: deps.store,
      provider: deps.provider,
      now: future,
      limit: 1000,
    });
    const remaining = [];
    for (const j of jobs)
      if (await deps.store.artifact(workspaceId, j.entry.appId, j.record.artifactId))
        remaining.push(j.name);
    const images = [];
    for (const kind of Object.keys(sources))
      for (const image of await deps.provider.listImages(`${workspaceId}/${sources[kind].appId}`))
        images.push({ ...image, path: `${workspaceId}/${sources[kind].appId}` });
    const checks = {
      purgedAll: purged.failed === 0 && remaining.length === 0,
      imagesGone: images.length === 0,
    };
    // Diagnostics: retry one leftover image directly to record the provider's reason.
    let deleteError;
    if (images.length)
      try {
        await deps.provider.deleteImage(images[0].path, images[0].digest);
      } catch (error) {
        deleteError = String(error?.message ?? error).slice(0, 120);
      }
    return {
      pass: Object.values(checks).every(Boolean),
      checks,
      purged,
      remaining,
      leftoverImages: images.map((i) => ({ tags: i.tags })),
      deleteError,
    };
  });

  // Zero skips by construction: every case the run should record must be present.
  const expected = [
    "M11.idempotent-start",
    "M11.c.scaffold-request-only",
    "M11.c.scaffold-durable",
    "M11.c.log-redaction",
    "M11.a.sandbox-probe",
    "M11.a.resource-bounds",
    "M11.b.inputs-and-failures",
    "M11.b.substitution",
    "M11.b.never-promotable",
    "M11.step5.retention",
    ...(deps.retag ? ["M11.b.retag"] : []),
  ];
  for (const name of expected)
    if (!(name in cases)) cases[name] = { pass: false, error: "case not recorded" };
  const pass = Object.values(cases).every((value) => value.pass === true);
  return {
    pass,
    run,
    cases,
    results,
    buildSeconds: Math.round((Date.now() - started) / 1000),
    builds: jobs.length,
  };
}
