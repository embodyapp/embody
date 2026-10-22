// M13 live suite (`test:mvp:cloud` suite m13): provision, migrate, promote and roll back on real
// infrastructure. The M12 topology (Cloud Tasks, Cloud Build, Cloud SQL, a Cloud Run deployment
// worker) plus a real hosted gateway on Cloud Run (its own identity, the public JWKS hosted apps
// verify against, private invocation of candidates) and the real M13 release stages in the
// worker: real candidates, runtime identities, database secrets, per-app databases and framework
// migrations through a provisioner role. The operator machine only acts as a client of the
// gateway and reads data checksums through the provisioner. The provider (./gcp.mjs, or a fake in
// tests) does all cloud I/O; teardown runs on every path.
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const { AbortSignal, URL } = globalThis;

export const M13_LIMITS = Object.freeze({
  /** Proposed one-off live budget; usable only with the owner's explicit approval. */
  maxBudgetUsd: 6,
  buildMinuteUsd: 0.006,
  /** v1, v2, the boot-crash release, two racing deployments and two durable releases. */
  builds: 7,
  sqlHourUsd: 0.0222,
  sqlHours: 4,
  /** Worker, gateway and candidate requests, Cloud Tasks, images, secrets, buckets, logs. */
  fixedUsd: 0.6,
  deploymentWaitMs: 40 * 60_000,
  pollMs: 15_000,
  /** The replaced candidate's drain plus margin before the sweep must remove it. */
  drainWaitMs: 11 * 60_000,
  propagationMs: 8 * 60_000,
});
export const M13_CASES = Object.freeze([
  "setUp",
  "M13.live.iam",
  "M13.a.first-deploy",
  "M13.a.update-switch",
  "M13.b.failed-readiness",
  "M13.b.destructive-migration",
  "M13.c.promotion-race",
  "M13.d.rollback",
  "M13.e.durable-wake",
  "cleanup",
]);

/** Guards for suite m13. Throws before any cloud call. */
export function m13Approval(env) {
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
  if (budget > M13_LIMITS.maxBudgetUsd)
    throw new Error(`M13 live budget is at most $${M13_LIMITS.maxBudgetUsd}`);
  if (!env.EMBODY_CLOUD_SQL_PROXY)
    throw new Error("M13 needs EMBODY_CLOUD_SQL_PROXY (Cloud SQL Auth Proxy v2) on the operator");
  return {
    project: env.EMBODY_MVP_CLOUD_PROJECT,
    prefix: env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX,
    budgetUsd: budget,
    proxy: env.EMBODY_CLOUD_SQL_PROXY,
  };
}

/** Conservative: every build at the full timeout, SQL for the whole window, fixed costs. */
export function m13Projection(builds = M13_LIMITS.builds) {
  return Number(
    (
      builds * 10 * M13_LIMITS.buildMinuteUsd +
      M13_LIMITS.sqlHours * M13_LIMITS.sqlHourUsd +
      M13_LIMITS.fixedUsd
    ).toFixed(2),
  );
}

export const M13_PROVIDER_METHODS = Object.freeze([
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
  "putSource",
  "releaseBindings",
  "candidates",
  "reconcile",
  "buildMinutes",
  "wait",
  "tearDown",
  "inventory",
]);

/**
 * Exact grants (RELEASES identity table): the worker adds only the M13 custom role, the
 * role-restricted project IAM admin and `actAs` on runtimes; each runtime holds only the Cloud
 * SQL client role and its secret; candidates are invokable only by the gateway, the worker and
 * the app's own wake invoker; every worker role that touches a resource is prefix-conditioned.
 */
export function evaluateReleaseBindings(bindings) {
  const worker = bindings.filter((b) => b.startsWith("worker|")).map((b) => b.slice(7));
  const runtimes = bindings.filter((b) => b.startsWith("runtime|")).map((b) => b.slice(8));
  const candidates = bindings.filter((b) => b.startsWith("candidate|")).map((b) => b.slice(10));
  const gateway = bindings.filter((b) => b.startsWith("gateway|")).map((b) => b.slice(8));
  const checks = {
    workerBaseRole: worker.includes("project:custom/base"),
    // Secret Manager honours prefix conditions: the app-secret role must carry one (review B3).
    workerSecretsConditioned:
      worker.includes("project:custom/secrets?prefixed") &&
      !worker.includes("project:custom/secrets"),
    // No IAM-admin or project-wide actAs: identity grants are resource-level, from provisioning.
    workerNoIamAdmin: !worker.some((b) =>
      /projectIamAdmin|serviceAccountAdmin|securityAdmin/.test(b),
    ),
    workerNoProjectActAs: !worker.some((b) => b.startsWith("project:roles/iam.serviceAccount")),
    workerActsAsRuntimesOnly:
      worker.includes("runtimeSa:roles/iam.serviceAccountUser") &&
      worker
        .filter((b) => !b.startsWith("project:"))
        .every(
          (b) =>
            b === "runtimeSa:roles/iam.serviceAccountUser" ||
            b === "invokerSa:roles/iam.serviceAccountTokenCreator",
        ),
    runtimesOnlySqlClientAndOwnSecret:
      runtimes.length > 0 &&
      runtimes.every(
        (b) =>
          b === "project:roles/cloudsql.client" ||
          b === "secret:roles/secretmanager.secretAccessor",
      ),
    candidatesInvokedByGatewayAndWorkerOnly:
      candidates.length > 0 &&
      candidates.every(
        (b) =>
          b === "run.invoker:gateway" ||
          b === "run.invoker:worker" ||
          b === "run.invoker:wake-invoker",
      ),
    gatewayHasNoReleaseAuthority: !gateway.some((b) =>
      /run\.admin|custom\/|projectIamAdmin/.test(b),
    ),
    noOwnerOrEditor: !bindings.some((b) => /roles\/(owner|editor)$/.test(b)),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

/**
 * Catalog observations taken during an update: every observation is the old or the new release's
 * pair (generation and manifest together), the generation never goes back, and the switch is seen.
 */
export function evaluateSwitch(observations, before, after) {
  const known = (o) =>
    (o.generation === before.generation &&
      o.pong === before.pong &&
      o.endpoint === before.endpoint) ||
    (o.generation === after.generation && o.pong === after.pong && o.endpoint === after.endpoint);
  const checks = {
    observed: observations.length >= 3,
    onlyKnownPairs: observations.every(known),
    monotonic: observations.every(
      (o, i) => i === 0 || o.generation >= observations[i - 1].generation,
    ),
    sawOld: observations.some((o) => o.generation === before.generation),
    sawNew: observations.some((o) => o.generation === after.generation),
    callsSucceeded: observations.every((o) => o.call === 200),
  };
  return { pass: Object.values(checks).every(Boolean), checks, observations: observations.length };
}

/** A rollback restores the previous manifest on a fresh candidate with the data unchanged. */
export function evaluateRollback(facts) {
  const checks = {
    active: facts.state === "active",
    newRelease:
      facts.releaseId !== facts.targetReleaseId && facts.rollbackOf === facts.targetReleaseId,
    previousManifest: facts.pong === false,
    freshCandidate: facts.endpoint !== facts.targetEndpoint,
    dataUnchanged: facts.checksumBefore === facts.checksumAfter,
    callAfter: facts.call === 200,
    activeRefused: facts.toActive === 409 && facts.toActiveCode === "ROLLBACK_INCOMPATIBLE",
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

/** Provider build IDs recorded on the artifacts of every attempt of these deployments. */
async function collectBuildIds(store, deployments) {
  const ids = [];
  for (const { workspaceId, appId, deploymentId } of deployments)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const artifact = await store.artifactForAttempt(workspaceId, appId, deploymentId, attempt);
      if (artifact?.buildId) ids.push(artifact.buildId);
    }
  return ids;
}

export async function runM13Suite(env, provider, deps) {
  const approval = m13Approval(env);
  for (const method of M13_PROVIDER_METHODS)
    if (typeof provider[method] !== "function") throw new Error(`Provider lacks ${method}`);
  const projection = m13Projection();
  if (projection > approval.budgetUsd)
    throw new Error("M13 projection exceeds the approved budget; no resources created");
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
  /** `{ workspaceId, appId, deploymentId }` of every deployment the run started. */
  const builds = [];
  let buildIds = [];
  const scratch = await mkdtemp(join(tmpdir(), "embody-m13-live-"));
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
    const signing = await deps.signingKey(`m13-${runId}`);
    const gateway = await provider.deployGateway(context, { image, signing });
    await provider.deployM13Worker(context, { image, recipe, gateway });
    cases.setUp = { pass: true };
    await provider.wait(M13_LIMITS.propagationMs);
    await record("M13.live.iam", async () =>
      evaluateReleaseBindings(await provider.releaseBindings(context)),
    );
    store = new deps.gateway.PostgresGatewayStore(db.runtimeUrl);

    // Fixtures: v1 (ping), v2 (adds pong) and a release whose container exits at boot.
    const pack = async (kind, customize, profile = "request-only") =>
      deps.createFixture(profile, join(scratch, kind), {
        createApp: deps.createApp,
        packSource: deps.contracts.packSource,
        registryUrl: registry.url,
        customize,
      });
    const addPong = async (directory) => {
      const config = join(directory, "embody.config.ts");
      const text = await readFile(config, "utf8");
      await writeFile(
        config,
        text.replace(
          "ping: {",
          'pong: { effect: "read", input: z.object({}), handler: () => ({ ok: "v2" }) },\n      ping: {',
        ),
      );
    };
    const shortDelay = async (directory) => {
      const config = join(directory, "embody.config.ts");
      const text = await readFile(config, "utf8");
      if (!text.includes("delayMs: 60 * 60_000")) throw new Error("durable scaffold changed");
      await writeFile(config, text.replace("delayMs: 60 * 60_000", "delayMs: 12 * 60_000"));
    };
    const crashAtBoot = async (directory) => {
      const entry = join(directory, "src/index.ts");
      await writeFile(entry, `process.exit(1);\n${await readFile(entry, "utf8")}`);
    };
    const fixtures = {
      v1: await pack("v1"),
      v2: await pack("v2", addPong),
      crash: await pack("crash", crashAtBoot),
      // Durable: the scaffold's delayed workflow step is due 12 minutes after it starts, so the
      // wake it schedules outlives the drain of the release that scheduled it (review B1).
      durableA: await pack("durableA", shortDelay, "durable"),
      durableB: await pack(
        "durableB",
        async (directory) => {
          await shortDelay(directory);
          await addPong(directory);
        },
        "durable",
      ),
    };
    const summaries = Object.fromEntries(
      await Promise.all(
        Object.entries(fixtures).map(async ([key, packed]) => [
          key,
          await deps.contracts.inspectSourceArchive(packed.archive),
        ]),
      ),
    );

    let seq = 0;
    /** A reserved app (no registration), a deployer/app-caller credential, a workspace. */
    const seed = async (name = "m11-request-only") => {
      const workspaceId = `ws_m13${runId}${String(seq).padStart(2, "0")}`;
      const appId = `app_m13${runId}${String(seq).padStart(2, "0")}`;
      seq += 1;
      // The scaffold's own app name; the platform name must equal it (token audience).
      await store.createWorkspace(workspaceId);
      await store.putApp(
        { workspaceId, appId, name, registration: null, activeRelease: null, state: "unavailable" },
        null,
      );
      const issued = deps.gateway.newCredential({
        workspaceId,
        principal: {
          orgId: workspaceId,
          actorId: "m13-operator",
          actorType: "human",
          roles: [],
          scopes: [`${name}:*`],
        },
        grants: [
          { workspaceId, appId, role: "deployer" },
          { workspaceId, appId, role: "app-caller" },
        ],
        expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
      });
      await store.putCredential(issued.credential, null);
      // App provisioning: a trusted admin step at reservation (the operator here), never the worker.
      await provider.provisionApp(context, workspaceId, appId, name === "m11-durable");
      return { workspaceId, appId, name, token: issued.token, uploads: 0 };
    };
    /** Uploads `kind` as a verified source of the seeded app. */
    const upload = async (seeded, kind) => {
      const packed = fixtures[kind];
      seeded.uploads += 1;
      const { record: pending } = await store.admitSource({
        workspaceId: seeded.workspaceId,
        appId: seeded.appId,
        idempotencyKey: `m13_source_${runId}_${seeded.appId.slice(-4)}_${seeded.uploads}`,
        digest: packed.digest,
        bytes: packed.bytes,
        actorId: "m13-operator",
        now: new Date(),
      });
      if (pending.state !== "verified") {
        await provider.putSource(context, pending.objectKey, packed.archive);
        await store.updateSource(
          {
            ...pending,
            state: "verified",
            verifiedAt: new Date().toISOString(),
            files: summaries[kind].files,
            expandedBytes: summaries[kind].expandedBytes,
            treeDigest: summaries[kind].treeDigest,
          },
          pending.revision,
        );
      }
      return { uploadId: pending.uploadId, digest: packed.digest, bytes: packed.bytes };
    };
    /** One HTTPS request to the deployed gateway. */
    const http = async (seeded, method, path, payload) => {
      const response = await (deps.fetch ?? globalThis.fetch)(`${gateway.url}${path}`, {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${seeded.token}`,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(90_000),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const manage = (seeded, method, path, payload) =>
      http(
        seeded,
        method,
        `/v1/workspaces/${seeded.workspaceId}/apps/${seeded.appId}${path}`,
        payload,
      );
    const generationOf = async (seeded) => (await manage(seeded, "GET", "")).body.generation;
    const submit = async (seeded, kind, key) =>
      manage(seeded, "POST", "/deployments", {
        version: 1,
        workspaceId: seeded.workspaceId,
        appId: seeded.appId,
        idempotencyKey: key,
        source: await upload(seeded, kind),
        expectedGeneration: await generationOf(seeded),
        capabilities: kind.startsWith("durable") ? deps.durable : deps.requestOnly,
        secretReferences: [],
      });
    const settle = async (seeded, deploymentId) => {
      const started = Date.now();
      // A missing ID (an earlier step failed) or a non-200 answer ends the wait at once: a failing
      // run must fail fast, not poll a nonexistent deployment for the whole deployment window.
      if (typeof deploymentId !== "string") return { state: "missing" };
      for (;;) {
        const response = await manage(seeded, "GET", `/deployments/${deploymentId}`);
        if (response.status !== 200 && response.status < 500)
          return { state: "unavailable", status: response.status };
        const status = response.body;
        if (["active", "failed", "cancelled"].includes(status.state)) return status;
        if (Date.now() - started > M13_LIMITS.deploymentWaitMs) return status;
        await delay(M13_LIMITS.pollMs);
      }
    };
    const deploy = async (seeded, kind) => {
      const accepted = await submit(
        seeded,
        kind,
        `m13-${runId}-${seeded.appId.slice(-4)}-${kind}-${seeded.uploads}`,
      );
      if (accepted.status !== 202) throw new Error(`deploy ${kind}: ${accepted.status}`);
      const final = await settle(seeded, accepted.body.deploymentId);
      builds.push({ ...seeded, deploymentId: accepted.body.deploymentId });
      return final;
    };
    const call = (seeded, target, payload = {}) =>
      http(
        seeded,
        "POST",
        `/w/${seeded.workspaceId}/api/execute/${seeded.name}/${target}`,
        payload,
      );
    const catalog = async (seeded) => {
      const response = await http(seeded, "GET", `/w/${seeded.workspaceId}/api/catalog`);
      const entry = (Array.isArray(response.body) ? response.body : []).find(
        (e) => e.catalogAppId === seeded.appId,
      );
      return entry
        ? {
            generation: entry.promotionGeneration,
            endpoint: entry.endpoint,
            pong: "app.pong" in entry.manifest.actions,
          }
        : null;
    };
    const checksum = (seeded) => db.appChecksum(context, seeded.workspaceId, seeded.appId);

    const a = await seed();
    let first;
    await record("M13.a.first-deploy", async () => {
      const hiddenBefore = (await catalog(a)) === null;
      first = await deploy(a, "v1");
      const created = await call(a, "app.card.create", { data: { title: "m13" } });
      const listed = await call(a, "app.card.list", {});
      const now = await catalog(a);
      const checks = {
        hiddenBefore,
        active: first.state === "active",
        registered:
          !!now && now.pong === false && /\.run\.app$/.test(new URL(now.endpoint).hostname),
        created: created.status === 200,
        listed: listed.status === 200 && JSON.stringify(listed.body).includes('"title":"m13"'),
      };
      return { pass: Object.values(checks).every(Boolean), checks };
    });

    let second;
    await record("M13.a.update-switch", async () => {
      const before = await catalog(a);
      const checksumBefore = await checksum(a);
      const accepted = await submit(a, "v2", `m13-${runId}-update`);
      const observations = [];
      let final;
      for (const started = Date.now(); ;) {
        const seen = await catalog(a);
        const ping = await call(a, "app.ping", {});
        observations.push({ ...seen, call: ping.status });
        final = (await manage(a, "GET", `/deployments/${accepted.body.deploymentId}`)).body;
        if (["active", "failed", "cancelled"].includes(final.state)) break;
        if (Date.now() - started > M13_LIMITS.deploymentWaitMs) break;
        await delay(5_000);
      }
      builds.push({ ...a, deploymentId: accepted.body.deploymentId });
      second = final;
      const after = await catalog(a);
      observations.push({ ...after, call: (await call(a, "app.pong", {})).status });
      const switched = evaluateSwitch(observations, before, after);
      // After the drain, the sweep (run on the operator reconcile) removes the old candidate.
      await provider.wait(M13_LIMITS.drainWaitMs);
      await provider.reconcile(context);
      const live = await provider.candidates(context, a.workspaceId);
      const checks = {
        active: final.state === "active",
        switched: switched.pass,
        dataUnchanged: checksumBefore === (await checksum(a)),
        oldCandidateRemoved: !live.some((c) => c.endpoint === before.endpoint),
        newCandidateKept: live.some((c) => c.endpoint === after.endpoint),
      };
      return { pass: Object.values(checks).every(Boolean), checks, switch: switched.checks };
    });

    await record("M13.b.failed-readiness", async () => {
      const before = await catalog(a);
      const checksumBefore = await checksum(a);
      const failed = await deploy(a, "crash");
      const after = await catalog(a);
      const live = await provider.candidates(context, a.workspaceId);
      const checks = {
        failedCheck: failed.state === "failed" && failed.error?.code === "CHECK_FAILED",
        routeUnchanged: JSON.stringify(after) === JSON.stringify(before),
        oldRouteServes: (await call(a, "app.pong", {})).status === 200,
        dataUnchanged: checksumBefore === (await checksum(a)),
        failedCandidateRemoved: live.length === 1,
      };
      return { pass: Object.values(checks).every(Boolean), checks };
    });

    await record("M13.b.destructive-migration", async () => {
      const result = await db.destructiveProbe(context, a.workspaceId, a.appId);
      const checks = {
        refused: result.refused === "MIGRATION_REJECTED",
        ledgerUnchanged: JSON.stringify(result.ledgerBefore) === JSON.stringify(result.ledgerAfter),
        dataUnchanged: result.checksumBefore === result.checksumAfter,
      };
      return { pass: Object.values(checks).every(Boolean), checks };
    });

    await record("M13.c.promotion-race", async () => {
      const b = await seed();
      await deploy(b, "v1");
      const generation = await generationOf(b);
      const [x, y] = await Promise.all([
        submit(b, "v2", `m13-${runId}-race-x`),
        submit(b, "v2", `m13-${runId}-race-y`),
      ]);
      const [fx, fy] = await Promise.all([
        settle(b, x.body.deploymentId),
        settle(b, y.body.deploymentId),
      ]);
      builds.push(
        { ...b, deploymentId: x.body.deploymentId },
        { ...b, deploymentId: y.body.deploymentId },
      );
      const states = [fx.state, fy.state].sort();
      const loser = fx.state === "failed" ? fx : fy;
      const checks = {
        oneWinner: JSON.stringify(states) === JSON.stringify(["active", "failed"]),
        loserStale: loser.error?.code === "STALE_GENERATION",
        oneGenerationStep: (await generationOf(b)) === generation + 1,
      };
      return { pass: Object.values(checks).every(Boolean), checks };
    });

    await record("M13.d.rollback", async () => {
      const targetEndpoint = (await store.release(a.workspaceId, a.appId, first.releaseId))
        ?.registration?.endpoint;
      const checksumBefore = await checksum(a);
      const toActive = await manage(a, "POST", "/rollback", {
        version: 1,
        workspaceId: a.workspaceId,
        appId: a.appId,
        operation: "rollback",
        expectedGeneration: await generationOf(a),
        releaseId: second.releaseId,
      });
      const accepted = await manage(a, "POST", "/rollback", {
        version: 1,
        workspaceId: a.workspaceId,
        appId: a.appId,
        operation: "rollback",
        expectedGeneration: await generationOf(a),
        releaseId: first.releaseId,
      });
      const final = await settle(a, accepted.body.deploymentId);
      const now = await catalog(a);
      const deployment = await store.deployment(a.workspaceId, a.appId, accepted.body.deploymentId);
      return evaluateRollback({
        state: final.state,
        releaseId: final.releaseId,
        targetReleaseId: first.releaseId,
        rollbackOf: deployment?.rollbackOf,
        pong: now?.pong,
        endpoint: now?.endpoint,
        targetEndpoint,
        checksumBefore,
        checksumAfter: await checksum(a),
        call: (await call(a, "app.ping", {})).status,
        toActive: toActive.status,
        toActiveCode: toActive.body?.error?.code,
      });
    });

    await record("M13.e.durable-wake", async () => {
      const d = await seed("m11-durable");
      const a = await deploy(d, "durableA");
      const started = await call(d, "app.followUp.start", {
        input: { title: "m13" },
        idempotencyKey: `m13-wake-${runId}`,
      });
      const id = started.body?.id;
      const b = await deploy(d, "durableB");
      // A's candidate drains and is swept; the step it scheduled is due after that.
      await provider.wait(M13_LIMITS.drainWaitMs);
      await provider.reconcile(context);
      const live = await provider.candidates(context, d.workspaceId);
      let status;
      for (const begin = Date.now(); Date.now() - begin < 15 * 60_000;) {
        status = (await call(d, "app.followUp.status", { id })).body?.status;
        if (status === "completed" || status === "failed") break;
        await delay(30_000);
      }
      const checks = {
        bothActive: a.state === "active" && b.state === "active",
        started: started.status === 200 && typeof id === "string",
        replacedCandidateRemoved: live.length === 1,
        stepCompletedOnActiveRelease: status === "completed",
      };
      return { pass: Object.values(checks).every(Boolean), checks, status };
    });
  } catch (error) {
    if (!cases.setUp)
      cases.setUp = { pass: false, error: String(error?.message ?? error).slice(0, 200) };
  } finally {
    // Cloud Build IDs of every attempt of every deployment, for the measured cost.
    buildIds = await collectBuildIds(store, builds).catch(() => []);
    await store?.close().catch(() => undefined);
    await registry?.close?.().catch(() => undefined);
    teardown = await Promise.resolve()
      .then(() => provider.tearDown(approval, runId, context))
      .catch((error) => ({ pass: false, error: String(error?.message ?? error).slice(0, 200) }));
    await rm(scratch, { recursive: true, force: true });
  }
  const leftovers = await provider.inventory(approval, runId);
  const iamAfter = await provider.projectIam();
  cases.cleanup = {
    pass:
      teardown.pass === true &&
      leftovers.length === 0 &&
      JSON.stringify(iamAfter) === JSON.stringify(iamBefore),
    leftovers,
    projectIamUnchanged: JSON.stringify(iamAfter) === JSON.stringify(iamBefore),
    servicesEnabled: enabled,
    iamOriginalUnchanged: JSON.stringify(iamAfter) === JSON.stringify(iamOriginal),
  };
  for (const name of M13_CASES)
    if (!(name in cases)) cases[name] = { pass: false, error: "case not recorded" };
  const buildMinutes = await Promise.resolve()
    .then(() => provider.buildMinutes(buildIds))
    .catch(() => Math.max(builds.length, M13_LIMITS.builds) * 10);
  const estimatedUsd = Number(
    (
      buildMinutes * M13_LIMITS.buildMinuteUsd +
      M13_LIMITS.sqlHours * M13_LIMITS.sqlHourUsd +
      M13_LIMITS.fixedUsd
    ).toFixed(2),
  );
  const pass =
    Object.values(cases).every((v) => v.pass === true) && estimatedUsd <= approval.budgetUsd;
  return { pass, runId, projectionUsd: projection, estimatedUsd, buildMinutes, cases };
}
