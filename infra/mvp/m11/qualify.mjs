// M11 live suite (`test:mvp:cloud` suite m11): the shared acceptance cases on the Cloud Build
// default pool with a dedicated builder identity, plus builder IAM inspection and the admitted
// image run as a Cloud Run job under a no-role runtime identity. The provider (./gcp.mjs, or a
// fake in tests) does all cloud I/O; teardown runs on every path once anything may exist.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runM11Cases } from "./suite.mjs";

export const M11_LIMITS = Object.freeze({
  /** Proposed one-off live budget; usable only with the owner's explicit approval. */
  maxBudgetUsd: 5,
  /** Cloud Build default pool, e2-standard-2, us-central1 (pricing captured 2026-10-18). */
  buildMinuteUsd: 0.006,
  /** Builds, recipe image and base copy for a day, Cloud Run job seconds, GCS and egress. */
  fixedUsd: 0.25,
  buildWaitMs: 45 * 60_000,
  propagationMs: 8 * 60_000,
});

/** Guards for suite m11. Throws before any cloud call. */
export function m11Approval(env) {
  const budget = Number(env.EMBODY_MVP_CLOUD_BUDGET_USD);
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(env.EMBODY_MVP_CLOUD_PROJECT ?? "") ||
    !/^embody-test-[a-z0-9-]{1,3}$/u.test(env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX ?? "") ||
    !Number.isFinite(budget) ||
    budget <= 0 ||
    env.EMBODY_MVP_CLOUD_BUDGET_APPROVED !== "true"
  )
    throw new Error(
      "Cloud gate requires an explicit test project, embody-test resource prefix and approved positive budget",
    );
  if (budget > M11_LIMITS.maxBudgetUsd)
    throw new Error(`M11 live budget is at most $${M11_LIMITS.maxBudgetUsd}`);
  return {
    project: env.EMBODY_MVP_CLOUD_PROJECT,
    prefix: env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX,
    budgetUsd: budget,
  };
}

/** Conservative projection: every build at the full 600 s timeout, plus fixed costs. */
export function m11Projection(builds) {
  return Number((builds * 10 * M11_LIMITS.buildMinuteUsd + M11_LIMITS.fixedUsd).toFixed(2));
}

export const M11_PROVIDER_METHODS = Object.freeze([
  "preflight",
  "enableServices",
  "setUp",
  "pushRecipe",
  "buildProvider",
  "sources",
  "putSource",
  "builderBindings",
  "retag",
  "runImage",
  "projectIam",
  "buildMinutes",
  "wait",
  "tearDown",
  "inventory",
]);

/** Exactly the builder's intended bindings; anything else (or missing) fails. */
export function evaluateBuilderBindings(bindings) {
  const expected = [
    "buildsRepo:roles/artifactregistry.writer",
    "logsBucket:roles/storage.legacyBucketReader",
    "logsBucket:roles/storage.objectUser",
    "outputBucket:roles/storage.legacyBucketReader",
    "outputBucket:roles/storage.objectCreator",
    "recipeRepo:roles/artifactregistry.reader",
  ];
  const checks = {
    exact: JSON.stringify([...bindings].sort()) === JSON.stringify(expected),
    noProjectRole: !bindings.some((b) => b.startsWith("project:")),
    noSourceAccess: !bindings.some((b) => b.startsWith("sourceBucket:")),
    noImpersonation: !bindings.some(
      (b) => b.startsWith("builderSelf:") || b.startsWith("runtimeSa:"),
    ),
  };
  return { pass: Object.values(checks).every(Boolean), checks, bindings };
}

/** Script run inside the admitted image by the Cloud Run job (no-role runtime identity). */
export const RUNTIME_PROBE = [
  "const { createHash } = await import('node:crypto');",
  "const core = await import('@embody/core'); const host = await import('@embody/host');",
  "const c = (await import('/app/dist/embody.config.js')).default;",
  "const m = core.compileManifest(c.plugins, { app: host.appMetadataOf(c) });",
  "const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => JSON.stringify(k) + ':' + canon(x)).join(',') + '}' : JSON.stringify(v);",
  "const catalog = 'sha256:' + createHash('sha256').update(canon(m)).digest('hex');",
  "const t = await (await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } })).json();",
  "const call = async (url, method = 'GET', body) => (await fetch(url, { method, headers: { authorization: 'Bearer ' + t.access_token, 'content-type': 'application/json' }, body })).status;",
  "const e = process.env;",
  "const denied = {",
  "  sourceRead: await call('https://storage.googleapis.com/storage/v1/b/' + e.M11_SOURCE_BUCKET + '/o'),",
  "  outputWrite: await call('https://storage.googleapis.com/upload/storage/v1/b/' + e.M11_OUTPUT_BUCKET + '/o?uploadType=media&name=probe', 'POST', '{}'),",
  "  buildCreate: await call('https://cloudbuild.googleapis.com/v1/projects/' + e.M11_PROJECT + '/locations/us-central1/builds', 'POST', '{\"steps\":[{\"name\":\"busybox\"}]}'),",
  "  deploy: await call('https://run.googleapis.com/v2/projects/' + e.M11_PROJECT + '/locations/us-central1/services?serviceId=m11-probe', 'POST', '{}'),",
  "  secrets: await call('https://secretmanager.googleapis.com/v1/projects/' + e.M11_PROJECT + '/secrets'),",
  "  signAsBuilder: await call('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + e.M11_BUILDER + ':generateAccessToken', 'POST', '{\"scope\":[\"https://www.googleapis.com/auth/cloud-platform\"]}'),",
  "};",
  "const ok = /^v24\\./.test(process.version) && process.getuid() === 1000 && catalog === e.M11_CATALOG && Object.values(denied).every((s) => s === 403);",
  "console.log('EMBODY_RUNTIME ' + JSON.stringify({ node: process.version, catalogMatches: catalog === e.M11_CATALOG, denied }));",
  "process.exit(ok ? 0 : 1);",
].join("\n");

/**
 * Ordered live run. deps: { gateway, contracts, createApp, stageRecipe, startFrameworkRegistry }.
 */
export async function runM11Suite(env, provider, deps) {
  const approval = m11Approval(env);
  for (const method of M11_PROVIDER_METHODS)
    if (typeof provider[method] !== "function") throw new Error(`Provider lacks ${method}`);
  const projection = m11Projection(16);
  if (projection > approval.budgetUsd)
    throw new Error("M11 projection exceeds the approved budget; no resources created");
  const runId = randomBytes(3).toString("hex");
  const cases = {};
  const record = async (name, fn) => {
    try {
      const result = await fn();
      cases[name] = { pass: result.pass === true, ...result };
    } catch (error) {
      cases[name] = { pass: false, error: String(error?.message ?? error).slice(0, 200) };
    }
  };
  const pre = await provider.preflight(approval);
  const enabled = pre?.disabledServices ?? [];
  // Enabling an API can add Google service-agent bindings to project IAM (M09 saw this). They are
  // recorded as the enablement delta; the run itself must leave project IAM unchanged.
  const iamOriginal = await provider.projectIam();
  if (enabled.length) {
    await provider.enableServices(enabled);
    await provider.wait(60_000);
  }
  const iamBefore = await provider.projectIam();
  const enablementDelta = JSON.parse(iamBefore)
    .filter((b) => !JSON.parse(iamOriginal).includes(b))
    .map((b) => `${b.split("|")[0]} ${b.split("|")[1].replace(/[^,@]+@/g, "*@")}`);
  let context;
  let teardown = { pass: false };
  let suite;
  let builds;
  const scratch = await mkdtemp(join(tmpdir(), "embody-m11-live-"));
  let registry;
  try {
    context = await provider.setUp(approval, runId);
    const recipeDir = join(scratch, "recipe");
    const framework = await deps.stageRecipe(recipeDir);
    const images = await provider.pushRecipe(context, recipeDir);
    const recipe = {
      project: approval.project,
      region: "us-central1",
      builderServiceAccount: context.builder.email,
      builderImage: images.builderImage,
      dockerImage: deps.cloudBuildersDocker,
      runtimeImage: images.runtimeImage,
      imageRepository: `us-central1-docker.pkg.dev/${approval.project}/${context.buildsRepo}`,
      outputBucket: context.outputBucket,
      logsBucket: context.logsBucket,
    };
    registry = await deps.startFrameworkRegistry(join(recipeDir, "framework"), framework);
    const cloudBuild = provider.buildProvider(recipe);
    builds = [];
    const counted = new Proxy(cloudBuild, {
      get(target, key) {
        if (key === "submitted") return builds;
        if (key === "submit")
          return async (config) => {
            const result = await target.submit(config);
            builds.push(result.buildId);
            return result;
          };
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await record("M11.a.builder-iam", async () =>
      evaluateBuilderBindings(await provider.builderBindings(context)),
    );
    // A fresh read signer's tokenCreator grant propagates slowly (M10 saw minutes).
    const sources = provider.sources(context);
    await record("propagation", async () => {
      const started = Date.now();
      let attempts = 0;
      for (;;) {
        attempts += 1;
        try {
          await sources.createReadAccess({
            objectKey: `sources/ws_m11warm000/app_m11warm000/src_m11warm000.tar.gz`,
            expiresAt: new Date(Date.now() + 60_000),
          });
          return { pass: true, attempts, seconds: Math.round((Date.now() - started) / 1000) };
        } catch {
          if (Date.now() - started > M11_LIMITS.propagationMs) return { pass: false, attempts };
          await provider.wait(15_000);
        }
      }
    });
    if (!cases.propagation.pass) throw new Error("Read signer IAM did not propagate");
    suite = await runM11Cases({
      gateway: deps.gateway,
      contracts: deps.contracts,
      createApp: deps.createApp,
      provider: counted,
      sources,
      store: new deps.gateway.MemoryGatewayStore(),
      recipe,
      registryUrl: registry.url,
      scratch,
      pidsLimit: deps.contracts.BUILD_RECIPE.sandbox.pids,
      putSource: (key, bytes) => provider.putSource(context, key, bytes),
      wait: (ms) => provider.wait(ms),
      pollMs: 15_000,
      buildWaitMs: M11_LIMITS.buildWaitMs,
      retag: (image, source) => provider.retag(context, image, source),
      runnable: async (artifact) => {
        const result = await provider.runImage(context, artifact.imageReference, {
          script: RUNTIME_PROBE,
          vars: {
            M11_CATALOG: artifact.manifest.catalogDigest,
            M11_PROJECT: approval.project,
            M11_SOURCE_BUCKET: context.sourceBucket,
            M11_OUTPUT_BUCKET: context.outputBucket,
            M11_BUILDER: context.builder.email,
          },
        });
        return { pass: result.succeeded === 1 && result.failed === 0, ...result };
      },
    });
    Object.assign(cases, suite.cases);
  } catch (error) {
    cases.setUp = { pass: false, error: String(error?.message ?? error).slice(0, 200) };
  } finally {
    await registry?.close();
    try {
      teardown = await provider.tearDown(approval, runId, context);
    } catch (error) {
      teardown = { pass: false, error: String(error?.message ?? error).slice(0, 200) };
    }
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  let leftovers = await provider.inventory(approval, runId);
  for (let attempt = 0; leftovers.length && attempt < 12; attempt++) {
    await provider.wait(15_000);
    leftovers = await provider.inventory(approval, runId);
  }
  const iamAfter = await provider.projectIam();
  cases.cleanup = {
    pass: teardown.pass === true && leftovers.length === 0 && iamBefore === iamAfter,
    teardown,
    leftovers,
    projectIamUnchanged: iamBefore === iamAfter,
  };
  const minutes = builds?.length
    ? await provider.buildMinutes(builds).catch(() => builds.length * 10)
    : 0;
  const estimatedUsd = Number(
    (minutes * M11_LIMITS.buildMinuteUsd + M11_LIMITS.fixedUsd).toFixed(2),
  );
  const pass =
    Object.values(cases).every((v) => v.pass === true) && estimatedUsd <= approval.budgetUsd;
  return {
    pass,
    runId,
    cases,
    results: suite?.results,
    builds: builds?.length ?? 0,
    buildMinutes: Number(minutes.toFixed(1)),
    enabledServices: enabled,
    // Role names only; members of Google-managed agents are not customer data.
    enablementDelta,
    projectionUsd: projection,
    estimatedUsd,
    budgetUsd: approval.budgetUsd,
  };
}
