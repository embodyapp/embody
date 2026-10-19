// M12 live suite (`test:mvp:cloud` suite m12): the durable deployment controller on real
// infrastructure. A Cloud Run deployment worker (controller identity) is woken only by OIDC tasks
// on a real Cloud Tasks queue, keeps state in a disposable Cloud SQL platform database and builds
// with real Cloud Build (the M11 recipe and builder). The operator machine plays the gateway and
// then goes away: deployments must finish with no gateway process at all. Faults planted in the
// platform database make the worker exit at named points once (worker replacement). The provider
// (./gcp.mjs, or a fake in tests) does all cloud I/O; teardown runs on every path.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const M12_LIMITS = Object.freeze({
  /** Proposed one-off live budget; usable only with the owner's explicit approval. */
  maxBudgetUsd: 6,
  buildMinuteUsd: 0.006,
  /** Builds per run (see the case list) and their full-timeout charge. */
  builds: 6,
  /** db-f1-micro + 10 GiB HDD + idle IPv4, per hour (M09 worksheet prices). */
  sqlHourUsd: 0.0222,
  sqlHours: 4,
  /** Worker requests/CPU, Cloud Tasks, images for a day, buckets, logs and egress. */
  fixedUsd: 0.4,
  /** One deployment from submission to active, including a 10-minute build and the crashes. */
  deploymentWaitMs: 40 * 60_000,
  pollMs: 15_000,
  /** How long a paused queue must hold a deployment still. */
  pauseHoldMs: 120_000,
  propagationMs: 8 * 60_000,
});

/** Guards for suite m12. Throws before any cloud call. */
export function m12Approval(env) {
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
  if (budget > M12_LIMITS.maxBudgetUsd)
    throw new Error(`M12 live budget is at most $${M12_LIMITS.maxBudgetUsd}`);
  if (!env.EMBODY_CLOUD_SQL_PROXY)
    throw new Error("M12 needs EMBODY_CLOUD_SQL_PROXY (Cloud SQL Auth Proxy v2) on the operator");
  return {
    project: env.EMBODY_MVP_CLOUD_PROJECT,
    prefix: env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX,
    budgetUsd: budget,
    proxy: env.EMBODY_CLOUD_SQL_PROXY,
  };
}

/** Conservative: every build at the full 600 s timeout, SQL for the whole window, fixed costs. */
export function m12Projection(builds = M12_LIMITS.builds) {
  return Number(
    (
      builds * 10 * M12_LIMITS.buildMinuteUsd +
      M12_LIMITS.sqlHours * M12_LIMITS.sqlHourUsd +
      M12_LIMITS.fixedUsd
    ).toFixed(2),
  );
}

export const M12_PROVIDER_METHODS = Object.freeze([
  "preflight",
  "enableServices",
  "projectIam",
  "setUp",
  "pushRecipe",
  "pushWorker",
  "prepareDatabase",
  "deployWorker",
  "putSource",
  "tasksQueue",
  "pauseQueue",
  "resumeQueue",
  "workerBindings",
  "idToken",
  "postTask",
  "buildStatus",
  "buildsByTag",
  "buildMinutes",
  "wait",
  "tearDown",
  "inventory",
]);

/** The worker identity holds exactly the controller grants; the invoker only invokes the worker. */
export function evaluateWorkerBindings(bindings) {
  const expected = [
    "builder:roles/iam.serviceAccountUser",
    "buildsRepo:roles/artifactregistry.repoAdmin",
    "invoker:roles/iam.serviceAccountUser",
    "logsBucket:roles/storage.objectAdmin",
    "outputBucket:roles/storage.objectAdmin",
    "project:roles/cloudbuild.builds.editor",
    "project:roles/cloudsql.client",
    "queue:roles/cloudtasks.enqueuer",
    "reader:roles/iam.serviceAccountTokenCreator",
    "secret:roles/secretmanager.secretAccessor",
  ];
  const worker = bindings.filter((b) => b.startsWith("worker|")).map((b) => b.slice(7));
  const invoker = bindings.filter((b) => b.startsWith("invoker|")).map((b) => b.slice(8));
  const checks = {
    workerExact: JSON.stringify([...worker].sort()) === JSON.stringify(expected),
    invokerOnlyInvokesWorker:
      JSON.stringify(invoker) === JSON.stringify(["service:roles/run.invoker"]),
    noOwnerOrEditor: !bindings.some((b) => /roles\/(owner|editor)$/.test(b)),
  };
  return { pass: Object.values(checks).every(Boolean), checks, worker, invoker };
}

/** One deployment's recorded facts → pass/fail. */
export function evaluateDeployment(facts, expect) {
  const checks = {
    state: facts.state === expect.state,
    ...(expect.error ? { error: facts.error === expect.error } : {}),
    ...(expect.builds === undefined ? {} : { builds: facts.builds === expect.builds }),
    ...(expect.candidates === undefined
      ? {}
      : { candidates: facts.candidates === expect.candidates }),
    ...(expect.generationStep === undefined
      ? {}
      : { generation: facts.generationAfter - facts.generationBefore === expect.generationStep }),
    ...(expect.faults === undefined ? {} : { faultsFired: facts.faultsFired === expect.faults }),
    ...(expect.release === undefined
      ? {}
      : { release: Boolean(facts.releaseId) === expect.release }),
    withinBound: facts.elapsedMs <= M12_LIMITS.deploymentWaitMs,
  };
  return { pass: Object.values(checks).every(Boolean), checks, facts };
}

/** Ingress: every forged or foreign request is refused and changes nothing; the real one works. */
export function evaluateIngress(results) {
  const refused = (status) => status === 401 || status === 403;
  const checks = {
    anonymous: refused(results.anonymous),
    operatorToken: refused(results.operatorToken),
    wrongAudience: refused(results.wrongAudience),
    otherIdentity: refused(results.otherIdentity),
    maliciousBody: results.maliciousBody === 400,
    foreignWorkspace:
      results.foreignWorkspace?.status === 200 && results.foreignWorkspace.outcome === "missing",
    invokerAccepted: results.invoker === 200,
    noStateChange: results.epochBefore === results.epochAfter,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

const capabilities = {
  profile: "request-only-v1",
  crud: true,
  boundedActions: true,
  workflows: false,
  schedules: false,
  subscriptions: false,
  appToAppRpc: false,
  persistentLocalState: false,
  genui: false,
};

/**
 * Ordered live run. deps: { gateway, contracts, createApp, stageRecipe, startFrameworkRegistry,
 * createFixture, cloudBuildersDocker, now? }.
 */
export async function runM12Suite(env, provider, deps) {
  const approval = m12Approval(env);
  for (const method of M12_PROVIDER_METHODS)
    if (typeof provider[method] !== "function") throw new Error(`Provider lacks ${method}`);
  const projection = m12Projection();
  if (projection > approval.budgetUsd)
    throw new Error("M12 projection exceeds the approved budget; no resources created");
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
  const builds = [];
  const scratch = await mkdtemp(join(tmpdir(), "embody-m12-live-"));
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
    const workerImage = await provider.pushWorker(context);
    const db = await provider.prepareDatabase(context, approval);
    const worker = await provider.deployWorker(context, { image: workerImage, recipe });
    await record("M12.live.iam", async () =>
      evaluateWorkerBindings(await provider.workerBindings(context)),
    );
    store = new deps.gateway.PostgresGatewayStore(db.runtimeUrl);
    const queue = provider.tasksQueue(context, worker);
    const packed = await deps.createFixture("request-only", join(scratch, "app"), {
      createApp: deps.createApp,
      packSource: deps.contracts.packSource,
      registryUrl: registry.url,
    });
    const summary = await deps.contracts.inspectSourceArchive(packed.archive);

    let seq = 0;
    /** A fresh workspace, app, deployer credential and verified, uploaded source. */
    const seed = async () => {
      const workspaceId = `ws_m12${runId}${String(seq).padStart(2, "0")}`;
      const appId = `app_m12${runId}${String(seq++).padStart(2, "0")}`;
      await store.createWorkspace(workspaceId);
      const app = await store.putApp(
        {
          workspaceId,
          appId,
          activeRelease: null,
          state: "unavailable",
          registration: {
            protocolVersion: 1,
            appId: `m12-${appId.slice(-8)}`,
            version: "0.1.0",
            endpoint: "https://candidate.invalid",
            healthCheckUrl: "https://candidate.invalid/health",
            manifest: {
              protocolVersion: 1,
              plugins: [{ id: "app", version: "0.1.0" }],
              entities: {},
              actions: {},
              eventSubscriptions: [],
            },
          },
        },
        null,
      );
      const issued = deps.gateway.newCredential({
        workspaceId,
        principal: {
          orgId: workspaceId,
          actorId: "m12-operator",
          actorType: "human",
          roles: [],
          scopes: [],
        },
        grants: [{ workspaceId, appId, role: "deployer" }],
        expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
      });
      await store.putCredential(issued.credential, null);
      const { record: pending } = await store.admitSource({
        workspaceId,
        appId,
        idempotencyKey: `m12_source_${runId}_${seq}`,
        digest: packed.digest,
        bytes: packed.bytes,
        actorId: "m12-operator",
        now: new Date(),
      });
      await provider.putSource(context, pending.objectKey, packed.archive);
      const source = await store.updateSource(
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
      const submission = (key = `m12-${runId}-${appId}`) => ({
        version: 1,
        workspaceId,
        appId,
        idempotencyKey: key,
        source: { uploadId: source.uploadId, digest: packed.digest, bytes: packed.bytes },
        expectedGeneration: app.generation,
        capabilities,
        secretReferences: [],
      });
      return { workspaceId, appId, app, token: issued.token, submission };
    };
    /** The operator machine as the gateway: one request, then the gateway process is gone. */
    const viaGateway = async (seeded, method, path, payload) => {
      const gateway = deps.gateway.createWorkspaceGateway({
        store,
        token: deps.signingIdentity,
        deployments: { queue },
      });
      try {
        const response = await gateway.inject({
          method,
          url: `/v1/workspaces/${seeded.workspaceId}/apps/${seeded.appId}${path}`,
          headers: { authorization: `Bearer ${seeded.token}` },
          ...(payload === undefined ? {} : { payload }),
        });
        return { status: response.statusCode, body: response.json() };
      } finally {
        await gateway.close();
      }
    };
    const plant = (deploymentId, points) => db.plantFaults(deploymentId, points);
    const facts = async (seeded, deploymentId, startedAt) => {
      const deployment = await store.deployment(seeded.workspaceId, seeded.appId, deploymentId);
      const status = await store.appStatus(seeded.workspaceId, seeded.appId);
      const artifacts = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        const artifact = await store.artifactForAttempt(
          seeded.workspaceId,
          seeded.appId,
          deploymentId,
          attempt,
        );
        if (artifact) artifacts.push(artifact);
      }
      let providerBuilds = 0;
      for (const artifact of artifacts) {
        const found = await provider.buildsByTag(`embody-${artifact.artifactId.replace("_", "-")}`);
        providerBuilds += found.length;
        builds.push(...found);
      }
      return {
        state: deployment?.state,
        error: deployment?.error,
        reason: deployment?.reason,
        stageAttempt: deployment?.stageAttempt,
        releaseId: deployment?.releaseId,
        builds: providerBuilds,
        candidates: await db.candidates(seeded.workspaceId),
        generationBefore: seeded.app.generation,
        generationAfter: status?.generation,
        faultsFired: await db.faultsFired(deploymentId),
        elapsedMs: Date.now() - startedAt,
      };
    };
    const until = async (
      seeded,
      deploymentId,
      predicate,
      timeoutMs = M12_LIMITS.deploymentWaitMs,
    ) => {
      const started = Date.now();
      for (;;) {
        const current = await store.deployment(seeded.workspaceId, seeded.appId, deploymentId);
        if (current && predicate(current)) return current;
        if (Date.now() - started > timeoutMs) return current;
        await provider.wait(M12_LIMITS.pollMs);
      }
    };
    const terminal = (d) => ["active", "failed", "cancelled"].includes(d.state);

    // Worker reachable with the invoker's token, before any case (IAM propagation).
    await record("propagation", async () => {
      const started = Date.now();
      for (let attempts = 1; ; attempts++) {
        const token = await provider.idToken(context, worker.taskUrl, "invoker");
        const status = await provider.postTask(worker.taskUrl, token, { v: 1 });
        if (status === 400)
          return { pass: true, attempts, seconds: Math.round((Date.now() - started) / 1000) };
        if (Date.now() - started > M12_LIMITS.propagationMs)
          return { pass: false, attempts, status };
        await provider.wait(15_000);
      }
    });
    if (!cases.propagation.pass) throw new Error("Worker invoker IAM did not propagate");

    // D1: gateway gone after 202; duplicate tasks; worker killed after its first claim, after the
    // build was created (before its ID was recorded) and after promotion (before the ACK).
    const chain = (async () => {
      const seeded = await seed();
      const started = Date.now();
      const submitted = await viaGateway(seeded, "POST", "/deployments", seeded.submission());
      const id = submitted.body.deploymentId;
      if (submitted.status !== 202 || !id) throw new Error(`submit ${submitted.status}`);
      await plant(id, ["after-claim", "after-build-submit", "after-promote"]);
      for (let i = 0; i < 4; i++)
        await queue.enqueue({
          name: `dup-${runId}-${i}`,
          scheduleAt: new Date().toISOString(),
          body: {
            v: 1,
            kind: "deployment",
            workspaceId: seeded.workspaceId,
            appId: seeded.appId,
            deploymentId: id,
            reason: "recover",
            epoch: 1,
          },
        });
      await until(seeded, id, terminal);
      return { seeded, id, facts: await facts(seeded, id, started) };
    })();
    // D2: committed with its task lost; a later status read through the gateway recovers it.
    const lost = (async () => {
      const seeded = await seed();
      const started = Date.now();
      const sub = seeded.submission();
      const { record: committed } = await store.submitDeployment(
        {
          submission: sub,
          fingerprint: deps.contracts.submissionFingerprint(sub),
          actorId: "m12-operator",
          now: new Date(),
        },
        async () => undefined,
      );
      await provider.wait(90_000);
      const read = await viaGateway(seeded, "GET", `/deployments/${committed.deploymentId}`);
      await until(seeded, committed.deploymentId, terminal);
      return { read: read.status, facts: await facts(seeded, committed.deploymentId, started) };
    })();
    // D5: task enqueued, transaction rolled back: the delivered task does nothing.
    const rolledBack = (async () => {
      const seeded = await seed();
      const sub = seeded.submission();
      let deploymentId;
      await store
        .submitDeployment(
          {
            submission: sub,
            fingerprint: deps.contracts.submissionFingerprint(sub),
            actorId: "m12-operator",
            now: new Date(),
          },
          async (wakes, txid) => {
            deploymentId = wakes[0].deploymentId;
            await deps.gateway.deploymentWakeHook(queue)(wakes, txid);
            throw new Error("crash before commit");
          },
        )
        .catch(() => undefined);
      await provider.wait(120_000);
      const after = await store.deployment(seeded.workspaceId, seeded.appId, deploymentId);
      const source = await store.source(seeded.workspaceId, seeded.appId, sub.source.uploadId);
      return {
        pass: after === null && !source?.pinnedBy,
        deployment: after === null ? "absent" : after.state,
        sourcePinned: Boolean(source?.pinnedBy),
      };
    })();
    // D3: cancelled while its build runs: the provider build is cancelled, nothing promotes.
    const cancel = (async () => {
      const seeded = await seed();
      const started = Date.now();
      const submitted = await viaGateway(seeded, "POST", "/deployments", seeded.submission());
      const id = submitted.body.deploymentId;
      let artifact;
      for (let i = 0; i < 80 && !artifact?.buildId; i++) {
        artifact = await store.artifactForAttempt(seeded.workspaceId, seeded.appId, id, 1);
        if (!artifact?.buildId) await provider.wait(10_000);
      }
      const cancelled = await viaGateway(seeded, "POST", `/deployments/${id}/cancel`, {
        version: 1,
        workspaceId: seeded.workspaceId,
        appId: seeded.appId,
        operation: "cancel",
        deploymentId: id,
        cancellationFence: 0,
      });
      await until(seeded, id, (d) => terminal(d) && !d.cleanup, 10 * 60_000);
      const status = artifact?.buildId ? await provider.buildStatus(artifact.buildId) : "none";
      const latest = await store.artifactForAttempt(seeded.workspaceId, seeded.appId, id, 1);
      return {
        cancelStatus: cancelled.status,
        buildStatus: status,
        artifact: latest?.state === "rejected" ? latest.error : latest?.state,
        facts: await facts(seeded, id, started),
      };
    })();
    // D6: two deployments of one app at once: exactly one promotes.
    const race = (async () => {
      const seeded = await seed();
      const started = Date.now();
      const [a, b] = await Promise.all([
        viaGateway(seeded, "POST", "/deployments", seeded.submission(`m12-${runId}-race-a`)),
        viaGateway(seeded, "POST", "/deployments", seeded.submission(`m12-${runId}-race-b`)),
      ]);
      const ids = [a.body.deploymentId, b.body.deploymentId];
      for (const id of ids) await until(seeded, id, terminal);
      return { seeded, all: await Promise.all(ids.map((id) => facts(seeded, id, started))) };
    })();

    const [d1, d2, d5, d3, d6] = await Promise.allSettled([chain, lost, rolledBack, cancel, race]);
    const value = (settled) => {
      if (settled.status === "rejected") throw settled.reason;
      return settled.value;
    };
    await record("M12.a.c.chain-zero-gateway", async () => {
      const { facts: f } = value(d1);
      return evaluateDeployment(f, {
        state: "active",
        builds: 1,
        candidates: 1,
        generationStep: 1,
        faults: 3,
        release: true,
      });
    });
    await record("M12.a.lost-task", async () => {
      const { facts: f, read } = value(d2);
      const result = evaluateDeployment(f, {
        state: "active",
        builds: 1,
        generationStep: 1,
        release: true,
      });
      return { ...result, pass: result.pass && read === 200, read };
    });
    await record("M12.a.rolled-back", async () => value(d5));
    await record("M12.b.cancel-during-build", async () => {
      const r = value(d3);
      const result = evaluateDeployment(r.facts, {
        state: "cancelled",
        builds: 1,
        candidates: 0,
        generationStep: 0,
        release: false,
      });
      const ok =
        r.cancelStatus === 200 && r.buildStatus === "CANCELLED" && r.artifact === "CANCELLED";
      return {
        ...result,
        pass: result.pass && ok,
        cancelStatus: r.cancelStatus,
        buildStatus: r.buildStatus,
        artifact: r.artifact,
      };
    });
    await record("M12.b.promotion-race", async () => {
      const { all } = value(d6);
      const states = all.map((f) => f.state).sort();
      const after = Math.max(...all.map((f) => f.generationAfter));
      const checks = {
        oneActive: JSON.stringify(states) === JSON.stringify(["active", "failed"]),
        loserStale: all.some((f) => f.state === "failed" && f.error === "STALE_GENERATION"),
        oneGenerationStep: after - all[0].generationBefore === 1,
      };
      return { pass: Object.values(checks).every(Boolean), checks, states };
    });

    // D4: a paused controller queue holds a deployment still; on resume it completes.
    await record("M12.c.queue-pause", async () => {
      const seeded = await seed();
      const started = Date.now();
      const submitted = await viaGateway(seeded, "POST", "/deployments", seeded.submission());
      const id = submitted.body.deploymentId;
      await until(seeded, id, (d) => d.state === "building");
      await provider.pauseQueue(context);
      await provider.wait(30_000); // a task already dispatched may still finish
      const held = await store.deployment(seeded.workspaceId, seeded.appId, id);
      await provider.wait(M12_LIMITS.pauseHoldMs);
      const still = await store.deployment(seeded.workspaceId, seeded.appId, id);
      const resumedAt = Date.now();
      await provider.resumeQueue(context);
      await until(seeded, id, terminal);
      const f = await facts(seeded, id, started);
      const result = evaluateDeployment(f, {
        state: "active",
        builds: 1,
        generationStep: 1,
        release: true,
      });
      const checks = { held: held?.epoch === still?.epoch, ...result.checks };
      return {
        pass: result.pass && checks.held,
        checks,
        resumeToActiveSeconds: Math.round((Date.now() - resumedAt) / 1000),
      };
    });

    // M12.d: forged and foreign requests against the real worker URL.
    await record("M12.d.ingress", async () => {
      const { seeded, id } = value(d1);
      const before = await store.deployment(seeded.workspaceId, seeded.appId, id);
      const body = {
        v: 1,
        kind: "deployment",
        workspaceId: seeded.workspaceId,
        appId: seeded.appId,
        deploymentId: id,
        reason: "recover",
        epoch: before.epoch,
      };
      const invoker = await provider.idToken(context, worker.taskUrl, "invoker");
      const results = {
        anonymous: await provider.postTask(worker.taskUrl, undefined, body),
        operatorToken: await provider.postTask(
          worker.taskUrl,
          await provider.idToken(context, worker.taskUrl, "operator"),
          body,
        ),
        wrongAudience: await provider.postTask(
          worker.taskUrl,
          await provider.idToken(context, `${worker.url}/other`, "invoker"),
          body,
        ),
        otherIdentity: await provider.postTask(
          worker.taskUrl,
          await provider.idToken(context, worker.taskUrl, "runtime"),
          body,
        ),
        maliciousBody: await provider.postTask(worker.taskUrl, invoker, {
          ...body,
          url: "https://attacker.example/steal",
        }),
        foreignWorkspace: await provider.postTask(
          worker.taskUrl,
          invoker,
          { ...body, workspaceId: "ws_attacker00001" },
          true,
        ),
        invoker: await provider.postTask(worker.taskUrl, invoker, body),
        epochBefore: before.epoch,
      };
      results.epochAfter = (await store.deployment(seeded.workspaceId, seeded.appId, id)).epoch;
      return evaluateIngress(results);
    });
  } catch (error) {
    cases.setUp = { pass: false, error: String(error?.message ?? error).slice(0, 200) };
  } finally {
    await registry?.close();
    await store?.close().catch(() => undefined);
    try {
      teardown = await provider.tearDown(approval, runId, context);
    } catch (error) {
      teardown = { pass: false, error: String(error?.message ?? error).slice(0, 200) };
    }
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  const attempt = async (fn, fallback) => {
    for (let i = 0; i < 4; i++)
      try {
        return { value: await fn() };
      } catch (error) {
        if (i === 3)
          return { value: fallback, error: String(error?.message ?? error).slice(0, 120) };
        await provider.wait(15_000);
      }
    return { value: fallback };
  };
  let inventory = await attempt(() => provider.inventory(approval, runId), ["unknown"]);
  for (let i = 0; inventory.value.length && i < 12; i++) {
    await provider.wait(15_000);
    inventory = await attempt(() => provider.inventory(approval, runId), ["unknown"]);
  }
  const iamAfter = await attempt(() => provider.projectIam(), "unknown");
  cases.cleanup = {
    pass: teardown.pass === true && inventory.value.length === 0 && iamBefore === iamAfter.value,
    teardown,
    leftovers: inventory.value,
    projectIamUnchanged: iamBefore === iamAfter.value,
  };
  const unique = [...new Set(builds)];
  const minutes = unique.length
    ? await provider.buildMinutes(unique).catch(() => unique.length * 10)
    : 0;
  const estimatedUsd = Number(
    (
      minutes * M12_LIMITS.buildMinuteUsd +
      M12_LIMITS.sqlHours * M12_LIMITS.sqlHourUsd +
      M12_LIMITS.fixedUsd
    ).toFixed(2),
  );
  for (const name of [
    "M12.live.iam",
    "propagation",
    "M12.a.c.chain-zero-gateway",
    "M12.a.lost-task",
    "M12.a.rolled-back",
    "M12.b.cancel-during-build",
    "M12.b.promotion-race",
    "M12.c.queue-pause",
    "M12.d.ingress",
    "cleanup",
  ])
    if (!(name in cases)) cases[name] = { pass: false, error: "case not recorded" };
  const pass =
    Object.values(cases).every((v) => v.pass === true) && estimatedUsd <= approval.budgetUsd;
  return {
    pass,
    runId,
    cases,
    builds: unique.length,
    buildMinutes: Number(minutes.toFixed(1)),
    enabledServices: enabled,
    enablementDelta: JSON.parse(iamBefore).filter((b) => !JSON.parse(iamOriginal).includes(b))
      .length,
    projectionUsd: projection,
    estimatedUsd,
    budgetUsd: approval.budgetUsd,
  };
}
