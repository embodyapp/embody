// M14 live suite (`test:mvp:cloud` suite m14): the packed CLI journey against the real
// integration topology. The M13 live topology (Cloud Build, Cloud SQL, Cloud Tasks, the Cloud Run
// deployment worker with the real release stages, and the public hosted gateway) plus the M10
// source routes on the gateway, so the user uploads through the gateway. The operator machine
// provisions the workspace, reserves the apps and issues keys (the only operator steps), then
// runs the packed CLI as a user. The provider (./gcp.mjs, or a fake in tests) does all cloud I/O;
// teardown runs on every path.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const M14_LIMITS = Object.freeze({
  /** The owner-approved one-off live budget (2026-10-24). */
  maxBudgetUsd: 6,
  buildMinuteUsd: 0.006,
  /** Cards v1, v2, v3 (cancelled), the failing build, the durable app, one spare. */
  builds: 6,
  sqlHourUsd: 0.0222,
  sqlHours: 4,
  /** Gateway, worker and candidate requests, Cloud Tasks, images, secrets, buckets, logs. */
  fixedUsd: 0.6,
  propagationMs: 8 * 60_000,
  /** Below any HTTPS round trip to the gateway: the live cold-timeout deadline. */
  coldTimeoutSeconds: 0.05,
  logIngestionMs: 90_000,
});

/** Guards for suite m14. Throws before any cloud call. */
export function m14Approval(env) {
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
  if (budget > M14_LIMITS.maxBudgetUsd)
    throw new Error(`M14 live budget is at most $${M14_LIMITS.maxBudgetUsd}`);
  if (!env.EMBODY_CLOUD_SQL_PROXY)
    throw new Error("M14 needs EMBODY_CLOUD_SQL_PROXY (Cloud SQL Auth Proxy v2) on the operator");
  return {
    project: env.EMBODY_MVP_CLOUD_PROJECT,
    prefix: env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX,
    budgetUsd: budget,
    proxy: env.EMBODY_CLOUD_SQL_PROXY,
  };
}

/** Conservative: every build at the full timeout, SQL for the whole window, fixed costs. */
export function m14Projection(builds = M14_LIMITS.builds) {
  return Number(
    (
      builds * 10 * M14_LIMITS.buildMinuteUsd +
      M14_LIMITS.sqlHours * M14_LIMITS.sqlHourUsd +
      M14_LIMITS.fixedUsd
    ).toFixed(2),
  );
}

export const M14_PROVIDER_METHODS = Object.freeze([
  "preflight",
  "enableServices",
  "projectIam",
  "setUp",
  "pushRecipe",
  "pushWorker",
  "prepareDatabase",
  "deployM13Worker",
  "deployGateway",
  "provisionApp",
  "buildMinutes",
  "wakeTasks",
  "runLogs",
  "storedObjects",
  "wait",
  "tearDown",
  "inventory",
]);

export async function runM14Suite(env, provider, deps) {
  const approval = m14Approval(env);
  for (const method of M14_PROVIDER_METHODS)
    if (typeof provider[method] !== "function") throw new Error(`Provider lacks ${method}`);
  const projection = m14Projection();
  if (projection > approval.budgetUsd)
    throw new Error("M14 projection exceeds the approved budget; no resources created");
  const runId = randomBytes(3).toString("hex");
  const canary = `EMBODY_M14_SOURCE_SECRET_${randomBytes(8).toString("hex")}`;
  const started = new Date().toISOString();
  const cases = {};
  const pre = await provider.preflight(approval);
  const enabled = pre?.disabledServices ?? [];
  const iamOriginal = await provider.projectIam();
  if (enabled.length) {
    await provider.enableServices(enabled);
    await provider.wait(60_000);
  }
  const iamBefore = await provider.projectIam();
  let context;
  let teardown = { pass: false };
  let store;
  let registry;
  let edge;
  let journey;
  const deployments = new Set();
  const workspaceId = `ws_m14${runId}`;
  const appIds = { cards: `app_m14cards${runId}`, flow: `app_m14flow${runId}` };
  const names = { cards: "m14-cards", flow: "m14-flow" };
  const scratch = await mkdtemp(join(tmpdir(), "embody-m14-live-"));
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
    const image = await provider.pushWorker(context);
    const db = await provider.prepareDatabase(context, approval);
    const signing = await deps.signingKey(`m14-${runId}`);
    const gateway = await provider.deployGateway(context, { image, signing });
    await provider.deployM13Worker(context, { image, recipe, gateway });
    await provider.wait(M14_LIMITS.propagationMs);
    store = new deps.gateway.PostgresGatewayStore(db.runtimeUrl);

    // --- Operator provisioning: the only operator steps; the journey below is CLI-only.
    await store.createWorkspace(workspaceId);
    for (const [key, appId] of Object.entries(appIds)) {
      await store.putApp(
        {
          workspaceId,
          appId,
          name: names[key],
          registration: null,
          activeRelease: null,
          state: "unavailable",
        },
        null,
      );
      await provider.provisionApp(context, workspaceId, appId, key === "flow");
    }
    const issue = async (role, scopes = []) => {
      const issued = deps.gateway.newCredential({
        workspaceId,
        principal: {
          orgId: workspaceId,
          actorId: "m14-user",
          actorType: "human",
          roles: [],
          scopes,
        },
        grants: Object.values(appIds).map((appId) => ({ workspaceId, appId, role })),
        expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
      });
      const record = await store.putCredential(issued.credential, null);
      return { token: issued.token, record };
    };
    const deployer = await issue("deployer");
    // The gateway authorizes `<app name>:*`; the app's kernel its plugin targets (`app:*`).
    const caller = await issue("app-caller", [`${names.cards}:*`, `${names.flow}:*`, "app:*"]);
    const stale = await issue("deployer");
    await store.putCredential({ ...stale.record, revoked: true }, stale.record.revision);
    cases.setUp = { pass: true, gateway: "public Cloud Run gateway with M10 source routes" };

    // --- The user's machine: packed CLI, protected profiles, scaffolded projects.
    const { cliBin, createBin } = await deps.consumer.installPackedConsumer({
      dir: join(scratch, "consumer"),
      framework,
      frameworkDir: join(recipeDir, "framework"),
      root: deps.root,
      packDir: recipeDir,
    });
    edge = await deps.consumer.startEdgeProxy(gateway.url);
    const home = join(scratch, "home");
    const configFile = await deps.consumer.writeProfiles(home, {
      deployer: { baseUrl: `${gateway.url}/w/${workspaceId}`, token: deployer.token },
      caller: { baseUrl: gateway.url, workspace: workspaceId, token: caller.token },
      edge: { baseUrl: `${edge.url}/w/${workspaceId}`, token: caller.token },
      stale: { baseUrl: `${gateway.url}/w/${workspaceId}/`, token: stale.token },
    });
    const projects = await deps.consumer.createProjects({
      dir: join(scratch, "projects"),
      createBin,
      registryUrl: registry.url,
      names,
      canary,
    });
    const run = deps.consumer.cliRunner({
      cliBin,
      cwd: scratch,
      home,
      configFile,
      cache: join(scratch, "cache"),
    });
    // Every deployment the user started, for the measured build cost.
    const cli = async (args, options) => {
      const result = await run(args, options);
      for (const id of `${result.out}\n${result.err}`.match(/dep_[a-z0-9]{8,64}/g) ?? [])
        deployments.add(id);
      return result;
    };
    const flowNames = deps.gateway.appResourceNames(
      context.platformPrefix,
      workspaceId,
      appIds.flow,
    );
    journey = await deps.runM14Journey({
      cli,
      names,
      appIds,
      workspace: workspaceId,
      root: gateway.url,
      scratch,
      projects,
      profiles: { deployer: "deployer", caller: "caller", edge: "edge", stale: "stale" },
      pause: async () => undefined,
      resume: async () => undefined,
      coldTimeoutSeconds: M14_LIMITS.coldTimeoutSeconds,
      tasks: () => provider.wakeTasks(context, flowNames),
      mcpClient: deps.consumer.mcpClientFactory(deps.require),
      secrets: [deployer.token, caller.token, stale.token, canary],
      scan: async () => {
        // Logs reach Cloud Logging with a delay: wait, then read the run's entries.
        await provider.wait(M14_LIMITS.logIngestionMs);
        const logs = await provider.runLogs(context, started);
        const parts = [logs.text];
        for (const object of await provider.storedObjects(context))
          parts.push(
            object.bucket === "source"
              ? gunzipSync(object.bytes).toString("latin1")
              : object.bytes.toString("utf8"),
          );
        return parts.join("\n");
      },
    });
    Object.assign(cases, journey.cases);
  } catch (error) {
    if (!cases.setUp)
      cases.setUp = { pass: false, error: String(error?.message ?? error).slice(0, 300) };
    else cases.journey = { pass: false, error: String(error?.message ?? error).slice(0, 300) };
  } finally {
    // Cloud Build IDs of every attempt of every deployment, for the measured cost.
    const buildIds = [];
    for (const deploymentId of deployments)
      for (const appId of Object.values(appIds))
        for (let attempt = 1; attempt <= 3; attempt++) {
          const artifact = await store
            ?.artifactForAttempt(workspaceId, appId, deploymentId, attempt)
            .catch(() => null);
          if (artifact?.buildId) buildIds.push(artifact.buildId);
        }
    cases.buildIds = buildIds;
    await store?.close().catch(() => undefined);
    await registry?.close?.().catch(() => undefined);
    await edge?.close().catch(() => undefined);
    teardown = await Promise.resolve()
      .then(() => provider.tearDown(approval, runId, context))
      .catch((error) => ({ pass: false, error: String(error?.message ?? error).slice(0, 200) }));
    await rm(scratch, { recursive: true, force: true });
  }
  const buildIds = cases.buildIds;
  delete cases.buildIds;
  // IAM and Cloud Run lists lag deletions by up to a minute: re-check before calling a leftover.
  let leftovers = await provider.inventory(approval, runId);
  for (let check = 0; check < 3 && leftovers.length > 0; check++) {
    await provider.wait(60_000);
    leftovers = await provider.inventory(approval, runId);
  }
  const iamAfter = await provider.projectIam();
  cases.cleanup = {
    pass:
      teardown.pass === true &&
      leftovers.length === 0 &&
      JSON.stringify(iamAfter) === JSON.stringify(iamBefore),
    leftovers,
    removed: teardown.removed?.length ?? 0,
    projectIamUnchanged: JSON.stringify(iamAfter) === JSON.stringify(iamBefore),
    servicesEnabled: enabled,
    iamOriginalUnchanged: JSON.stringify(iamAfter) === JSON.stringify(iamOriginal),
  };
  for (const name of ["setUp", ...deps.cases, "cleanup"])
    if (!(name in cases)) cases[name] = { pass: false, error: "case not recorded" };
  const buildMinutes = await Promise.resolve()
    .then(() => provider.buildMinutes(buildIds))
    .catch(() => M14_LIMITS.builds * 10);
  const estimatedUsd = Number(
    (
      buildMinutes * M14_LIMITS.buildMinuteUsd +
      M14_LIMITS.sqlHours * M14_LIMITS.sqlHourUsd +
      M14_LIMITS.fixedUsd
    ).toFixed(2),
  );
  const pass =
    Object.values(cases).every((v) => v.pass === true) && estimatedUsd <= approval.budgetUsd;
  return {
    pass,
    runId,
    projectionUsd: projection,
    estimatedUsd,
    builds: buildIds.length,
    buildMinutes,
    deployments: deployments.size,
    cases,
  };
}
