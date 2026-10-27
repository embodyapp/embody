import { generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { describe, expect, it } from "vitest";
import { platformInvokerVerifier } from "@embody/auth";
import { submissionFingerprint, type DeploymentSubmission } from "@embody/cloud-contracts";
import {
  BUILD_DEADLINE_MS,
  BuildAdmission,
  DEPLOYMENT_LIMITS,
  DeploymentController,
  MemoryBuildProvider,
  MemoryGatewayStore,
  MemorySourceObjectStore,
  createDeploymentWorker,
  createWorkspaceGateway,
  decideClaim,
  deploymentWakeHook,
  newCredential,
  type BuildConfig,
  type DeploymentRecord,
  type DeploymentTaskBody,
  type SimulatedBuildResult,
} from "../src/index.js";
import {
  APP,
  FakeStages,
  MemoryTaskQueue,
  TestClock,
  drive,
  honestBuild,
  recipe,
  seedDeployableApp,
} from "./deployment-fixture.js";
import { deploymentStoreConformance } from "./deployment-store-conformance.js";
import { signingIdentity } from "./signing-fixture.js";
import { credentialInput } from "./store-conformance.js";

deploymentStoreConformance("memory store", () => Promise.resolve(new MemoryGatewayStore()));

const WS = "ws_deploy000001";
type Behaviour = (config: BuildConfig, attempt: number) => SimulatedBuildResult | undefined;
async function harness(behaviour: Behaviour = (config) => honestBuild(config)) {
  const clock = new TestClock();
  const store = new MemoryGatewayStore();
  const objects = new MemorySourceObjectStore({ clock });
  const attempts = new Map<string, number>();
  let builds = 0;
  const provider = new MemoryBuildProvider((config) => {
    const id = config.tags[1]!;
    if (!attempts.has(id)) attempts.set(id, (builds += 1));
    return behaviour(config, attempts.get(id)!);
  }, clock);
  const submittedIds: string[] = [];
  const finished = new Set<string>();
  const cancelled: string[] = [];
  const realSubmit = provider.submit.bind(provider);
  provider.submit = async (config) => {
    const result = await realSubmit(config);
    submittedIds.push(result.buildId);
    return result;
  };
  const realCancel = provider.cancel.bind(provider);
  provider.cancel = async (id) => {
    cancelled.push(id);
    finished.add(id);
    return realCancel(id);
  };
  /** Builds finish when the test says so, once each; a cancelled build stays cancelled. */
  const completeBuilds = () => {
    for (const id of submittedIds)
      if (!finished.has(id)) {
        provider.complete(id);
        finished.add(id);
      }
  };
  const builder = new BuildAdmission({ store, provider, recipe, sources: objects, clock });
  const stages = new FakeStages();
  const queue = new MemoryTaskQueue<DeploymentTaskBody>();
  const logs: unknown[] = [];
  const controller = new DeploymentController({
    store,
    queue,
    builds: builder,
    stages,
    clock,
    log: (record) => logs.push(record),
  });
  const seeded = await seedDeployableApp(store, WS, clock.now());
  const wake = deploymentWakeHook(queue);
  const submit = async (submission: DeploymentSubmission = seeded.submission()) =>
    (
      await store.submitDeployment(
        {
          submission,
          fingerprint: submissionFingerprint(submission),
          actorId: "alice",
          now: clock.now(),
        },
        wake,
      )
    ).record;
  const run = (options: Parameters<typeof drive>[3] = {}) =>
    drive(controller, queue, clock, { before: completeBuilds, ...options });
  const reload = (record: DeploymentRecord) =>
    store.deployment(record.workspaceId, record.appId, record.deploymentId);
  return {
    clock,
    store,
    objects,
    provider,
    stages,
    queue,
    controller,
    seeded,
    submit,
    run,
    reload,
    wake,
    logs,
    submittedIds,
    cancelled,
    completeBuilds,
  };
}

describe("M12.a/M12.c durable controller (memory store)", () => {
  it("submits through the gateway without waiting, then the worker alone drives it to one active release", async () => {
    const h = await harness();
    const issued = newCredential({
      ...credentialInput(WS),
      grants: [{ workspaceId: WS, appId: APP, role: "deployer" }],
    });
    await h.store.putCredential(issued.credential, null);
    const gateway = createWorkspaceGateway({
      store: h.store,
      token: signingIdentity,
      clock: h.clock,
      deployments: { queue: h.queue },
    });
    const headers = { authorization: `Bearer ${issued.token}` };
    const url = `/v1/workspaces/${WS}/apps/${APP}/deployments`;
    const submitted = await gateway.inject({
      method: "POST",
      url,
      headers,
      payload: h.seeded.submission(),
    });
    expect(submitted.statusCode).toBe(202);
    const status = submitted.json<{ deploymentId: string; state: string }>();
    expect(status.state).toBe("accepted");
    expect(h.provider.submitted).toHaveLength(0);
    // M12.c: the gateway goes away (zero instances); only queue tasks and the worker remain.
    await gateway.close();
    await h.run();
    const record = await h.store.deployment(WS, APP, status.deploymentId);
    expect(record).toMatchObject({ state: "active", stageAttempt: 1 });
    expect(h.provider.submitted).toHaveLength(1);
    expect(h.stages.created).toBe(1);
    const app = await h.store.appStatus(WS, APP);
    expect(app).toMatchObject({
      generation: h.seeded.app.generation + 1,
      activeReleaseId: record!.releaseId,
    });
    const release = await h.store.release(WS, APP, record!.releaseId!);
    expect(release?.imageReference).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(h.queue.pending()).toHaveLength(0);
    // A new gateway instance replays the same key with the original deployment (200, no work).
    const again = createWorkspaceGateway({
      store: h.store,
      token: signingIdentity,
      clock: h.clock,
      deployments: { queue: h.queue },
    });
    const replay = await again.inject({
      method: "POST",
      url,
      headers,
      payload: h.seeded.submission(),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ deploymentId: status.deploymentId, state: "active" });
    const read = await again.inject({ url: `${url}/${status.deploymentId}`, headers });
    expect(read.json()).toMatchObject({ state: "active", releaseId: record!.releaseId });
    const appStatus = await again.inject({ url: `/v1/workspaces/${WS}/apps/${APP}`, headers });
    expect(appStatus.json()).toMatchObject({
      generation: h.seeded.app.generation + 1,
      activeReleaseId: record!.releaseId,
      status: "enabled",
    });
    expect(h.provider.submitted).toHaveLength(1);
    await again.close();
    expect(JSON.stringify(h.logs)).not.toMatch(/X-Goog|https:\/\//);
  });

  it("enforces the deploy/call role split and hides other apps and workspaces", async () => {
    const h = await harness();
    const caller = newCredential({
      ...credentialInput(WS),
      grants: [{ workspaceId: WS, appId: APP, role: "app-caller" }],
    });
    const deployer = newCredential({
      ...credentialInput(WS),
      grants: [{ workspaceId: WS, appId: APP, role: "deployer" }],
    });
    await h.store.putCredential(caller.credential, null);
    await h.store.putCredential(deployer.credential, null);
    const gateway = createWorkspaceGateway({
      store: h.store,
      token: signingIdentity,
      clock: h.clock,
      deployments: { queue: h.queue },
    });
    const url = `/v1/workspaces/${WS}/apps/${APP}/deployments`;
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    expect(
      (
        await gateway.inject({
          method: "POST",
          url,
          headers: as(caller.token),
          payload: h.seeded.submission(),
        })
      ).statusCode,
    ).toBe(403);
    expect(h.queue.tasks).toHaveLength(0);
    const ok = await gateway.inject({
      method: "POST",
      url,
      headers: as(deployer.token),
      payload: h.seeded.submission(),
    });
    expect(ok.statusCode).toBe(202);
    const id = ok.json<{ deploymentId: string }>().deploymentId;
    expect(
      (await gateway.inject({ url: `${url}/${id}`, headers: as(caller.token) })).statusCode,
    ).toBe(403);
    const cancel = {
      version: 1,
      workspaceId: WS,
      appId: APP,
      operation: "cancel",
      deploymentId: id,
      cancellationFence: 0,
    };
    expect(
      (
        await gateway.inject({
          method: "POST",
          url: `${url}/${id}/cancel`,
          headers: as(caller.token),
          payload: cancel,
        })
      ).statusCode,
    ).toBe(403);
    // Body bound to another app, or a route for an app with no grant: rejected / not revealed.
    expect(
      (
        await gateway.inject({
          method: "POST",
          url,
          headers: as(deployer.token),
          payload: { ...h.seeded.submission("deploy_key_other0001"), appId: "app_other00001" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await gateway.inject({
          url: `/v1/workspaces/${WS}/apps/app_other00001/deployments/${id}`,
          headers: as(deployer.token),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await gateway.inject({
          url: `/v1/workspaces/ws_otherws00001/apps/${APP}/deployments/${id}`,
          headers: as(deployer.token),
        })
      ).statusCode,
    ).toBe(401);
    const cancelled = await gateway.inject({
      method: "POST",
      url: `${url}/${id}/cancel`,
      headers: as(deployer.token),
      payload: cancel,
    });
    expect(cancelled.json()).toMatchObject({ state: "cancelled", cancellationFence: 1 });
    // Repeated cancel returns the cancelled status without advancing the fence again.
    expect(
      (
        await gateway.inject({
          method: "POST",
          url: `${url}/${id}/cancel`,
          headers: as(deployer.token),
          payload: cancel,
        })
      ).json(),
    ).toMatchObject({ state: "cancelled", cancellationFence: 1 });
    await gateway.close();
  });

  it("queue outage: submission fails closed and persists nothing; mid-flight it recovers on the next delivery", async () => {
    const h = await harness();
    h.queue.outage = true;
    await expect(h.submit()).rejects.toThrow(/unavailable/);
    expect(await h.store.overdueDeployments(new Date(2040, 0), 10)).toEqual([]);
    h.queue.outage = false;
    const record = await h.submit();
    // The queue fails while the worker runs: the claim cannot commit its lease wake → 503.
    h.queue.outage = true;
    const [first] = h.queue.due(h.clock.now());
    expect(await h.controller.handle(first!.body)).toMatchObject({ status: 503 });
    expect(await h.reload(record)).toMatchObject({ state: "accepted", epoch: 1 });
    h.queue.outage = false;
    // Cloud Tasks retries the same task after its backoff (at most 300 s): it then proceeds.
    await h.run();
    expect(await h.reload(record)).toMatchObject({ state: "active" });
  });

  it("a lost task is recovered by the next authenticated request or delivered task (MD12)", async () => {
    const h = await harness();
    const record = await h.submit();
    for (const task of h.queue.pending()) h.queue.lose(task.name);
    expect(await h.run()).toEqual([]);
    expect(await h.reload(record)).toMatchObject({ state: "accepted" });
    h.clock.advance(DEPLOYMENT_LIMITS.recoveryGraceMs + 1000);
    // Any delivered task (here an unrelated, invalid-but-authenticated one is not enough; a
    // valid task for another deployment is) runs bounded recovery.
    expect((await h.controller.reconcile(10)).woken).toBe(1);
    expect((await h.controller.reconcile(10)).woken).toBe(0); // one wake per window
    await h.run();
    expect(await h.reload(record)).toMatchObject({ state: "active" });
  });
  it("an early task that is the newest wake re-arms itself for the due time (no recovery needed)", async () => {
    // Builds finish only when the test completes them, so the first build is still polling.
    const h = await harness();
    const record = await h.submit();
    for (let i = 0; i < 6; i++) {
      const [task] = h.queue.due(h.clock.now());
      if (!task) break;
      await h.controller.handle(task.body);
      h.queue.acknowledge(task.name);
    }
    const polling = (await h.reload(record))!;
    expect(polling).toMatchObject({ state: "building" });
    expect(Date.parse(polling.dueAt)).toBeGreaterThan(h.clock.now().getTime());
    for (const task of h.queue.pending()) h.queue.lose(task.name);
    const early = await h.controller.handle({
      v: 1,
      kind: "deployment",
      workspaceId: WS,
      appId: APP,
      deploymentId: record.deploymentId,
      reason: "recover",
      epoch: polling.epoch,
    });
    expect(early).toMatchObject({ status: 200, outcome: "early" });
    const [rearmed] = h.queue.pending();
    expect(rearmed).toMatchObject({ scheduleAt: polling.dueAt, body: { reason: "follow-up" } });
    h.completeBuilds();
    await h.run();
    expect(await h.reload(record)).toMatchObject({ state: "active" });
  });
});

describe("M12 retries, deadlines and the M11 obligations", () => {
  it("N2: a DEPENDENCY_UNAVAILABLE build is a new attempt; three of them fail visibly", async () => {
    const flaky = await harness((config, n) =>
      n === 1 ? { ...honestBuild(config), status: "INTERNAL_ERROR" } : honestBuild(config),
    );
    const one = await flaky.submit();
    await flaky.run();
    expect(await flaky.reload(one)).toMatchObject({ state: "active" });
    expect(flaky.provider.submitted).toHaveLength(2);
    expect(await flaky.store.artifactForAttempt(WS, APP, one.deploymentId, 1)).toMatchObject({
      state: "rejected",
      error: "DEPENDENCY_UNAVAILABLE",
    });
    const down = await harness((config) => ({ ...honestBuild(config), status: "INTERNAL_ERROR" }));
    const two = await down.submit();
    await down.run();
    expect(await down.reload(two)).toMatchObject({
      state: "failed",
      error: "DEPENDENCY_UNAVAILABLE",
      reason: "BUILD_DEPENDENCY_UNAVAILABLE",
    });
    expect(down.provider.submitted).toHaveLength(3);
  });

  it("N2: an overdue settle that cannot read the provider becomes the next attempt", async () => {
    const h = await harness((config, n) => (n === 1 ? undefined : honestBuild(config)));
    const record = await h.submit();
    // Run until the first build is submitted and polling (it never finishes on its own).
    for (let i = 0; i < 6; i++) {
      const [task] = h.queue.due(h.clock.now());
      if (!task) break;
      await h.controller.handle(task.body);
      h.queue.acknowledge(task.name);
    }
    expect(await h.reload(record)).toMatchObject({ state: "building", stageAttempt: 1 });
    h.clock.advance(BUILD_DEADLINE_MS + 1000);
    h.provider.available = false;
    const [poll] = h.queue.pending();
    await h.controller.handle(poll!.body);
    h.queue.acknowledge(poll!.name);
    expect(await h.store.artifactForAttempt(WS, APP, record.deploymentId, 1)).toMatchObject({
      state: "rejected",
      error: "DEPENDENCY_UNAVAILABLE",
    });
    expect(await h.reload(record)).toMatchObject({ state: "building", stageAttempt: 2 });
    h.provider.available = true;
    await h.run();
    expect(await h.reload(record)).toMatchObject({ state: "active" });
  });

  it("a non-retryable build rejection fails at once with a public code and no second build", async () => {
    const h = await harness((config) => ({ ...honestBuild(config), status: "FAILURE" }));
    const record = await h.submit();
    await h.run();
    expect(await h.reload(record)).toMatchObject({
      state: "failed",
      error: "BUILD_FAILED",
      reason: "BUILD_BUILD_FAILED",
    });
    expect(h.provider.submitted).toHaveLength(1);
    expect(h.stages.created).toBe(0);
  });

  it("provider errors while polling are bounded: they become attempts, then a visible failure", async () => {
    const h = await harness();
    const record = await h.submit();
    h.provider.available = false;
    const results = await h.run();
    const final = await h.reload(record);
    expect(final).toMatchObject({ state: "failed", error: "DEPENDENCY_UNAVAILABLE" });
    expect(results.length).toBeLessThan(200);
    expect(Date.parse(final!.updatedAt) - Date.parse(record.createdAt)).toBeLessThan(
      DEPLOYMENT_LIMITS.deploymentDeadlineMs,
    );
  });

  it("the deployment deadline fails a nonterminal deployment visibly", () => {
    const record = {
      state: "provisioning",
      deadlineAt: "2030-01-01T02:00:00.000Z",
      dueAt: "2030-01-01T00:00:00.000Z",
      stageAttempt: 1,
      epoch: 5,
      crashes: 0,
      revision: 3,
      workspaceId: WS,
      appId: APP,
      deploymentId: "dep_deadline0001",
    } as unknown as DeploymentRecord;
    const decision = decideClaim(record, new Date("2030-01-01T02:00:00.000Z"), "t");
    expect(decision).toMatchObject({
      kind: "settled",
      next: {
        state: "failed",
        error: "DEPENDENCY_UNAVAILABLE",
        reason: "DEADLINE_EXCEEDED",
        cleanup: true,
      },
    });
  });

  it("a stage over the handler deadline is not completed; the lease wake reclaims it within the lease (worker replacement)", async () => {
    const h = await harness();
    let hangs = 1;
    const provision = h.stages.provision.bind(h.stages);
    h.stages.provision = (context) =>
      hangs-- > 0 ? new Promise(() => undefined) : provision(context);
    const controller = new DeploymentController({
      store: h.store,
      queue: h.queue,
      builds: new BuildAdmission({
        store: h.store,
        provider: h.provider,
        recipe,
        sources: h.objects,
        clock: h.clock,
      }),
      stages: h.stages,
      clock: h.clock,
      handlerDeadlineMs: 20,
    });
    const record = await h.submit();
    const results = await drive(controller, h.queue, h.clock, { before: h.completeBuilds });
    const timedOut = results.findIndex((r) => r.outcome === "timed-out");
    expect(timedOut).toBeGreaterThanOrEqual(0);
    expect(await h.reload(record)).toMatchObject({ state: "active" });
    expect(h.stages.created).toBe(1);
  });

  it("a provisioning stage that never finishes fails at the M13 provisioning bound", async () => {
    const h = await harness();
    h.stages.provision = () => new Promise(() => undefined);
    const controller = new DeploymentController({
      store: h.store,
      queue: h.queue,
      builds: new BuildAdmission({
        store: h.store,
        provider: h.provider,
        recipe,
        sources: h.objects,
        clock: h.clock,
      }),
      stages: h.stages,
      clock: h.clock,
      handlerDeadlineMs: 20,
    });
    const record = await h.submit();
    const started = h.clock.now().getTime();
    await drive(controller, h.queue, h.clock, { before: h.completeBuilds });
    const final = await h.reload(record);
    expect(final).toMatchObject({
      state: "failed",
      error: "DEPENDENCY_UNAVAILABLE",
      reason: "PROVISION_TIMEOUT",
    });
    // The first claim past the 15-minute stage bound fails it (at most one lease later).
    expect(Date.parse(final!.updatedAt) - started).toBeLessThanOrEqual(
      DEPLOYMENT_LIMITS.provisionStageMs + DEPLOYMENT_LIMITS.leaseMs + 2000 + 30_000,
    );
  });

  it("a stage that never finishes is bounded: crashed claims become attempts, then a visible failure", async () => {
    const h = await harness();
    // A build start that never returns (the build stage has no stage-local bound of its own).
    const controller = new DeploymentController({
      store: h.store,
      queue: h.queue,
      builds: {
        start: () => new Promise(() => undefined),
        settle: (artifact) => Promise.resolve(artifact),
        abandon: (artifact) => Promise.resolve(artifact),
      },
      stages: h.stages,
      clock: h.clock,
      handlerDeadlineMs: 20,
    });
    const record = await h.submit();
    const started = h.clock.now().getTime();
    await drive(controller, h.queue, h.clock, { before: h.completeBuilds });
    const final = await h.reload(record);
    expect(final).toMatchObject({
      state: "failed",
      error: "DEPENDENCY_UNAVAILABLE",
      reason: "WORKER_LOST",
    });
    // Three attempts of three lost claims, each reclaimed one lease later, plus the 5 s and
    // 30 s retry delays and the earlier stages (under 30 s here).
    expect(Date.parse(final!.updatedAt) - started).toBeLessThanOrEqual(
      9 * (DEPLOYMENT_LIMITS.leaseMs + 2000) + 35_000 + 30_000,
    );
  });
});

describe("M12.b duplicates, concurrency and cancellation", () => {
  it("five concurrent deliveries of one task start one build and promote once", async () => {
    const h = await harness();
    const record = await h.submit();
    const [task] = h.queue.due(h.clock.now());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.controller.handle(task!.body)),
    );
    expect(results.filter((r) => r.outcome.startsWith("advance"))).toHaveLength(1);
    expect(
      results.filter((r) => ["leased", "early", "superseded"].includes(r.outcome)),
    ).toHaveLength(4);
    // Redeliver every task created so far many times while driving.
    const redeliver = async () => {
      for (const t of h.queue.tasks.slice(-3)) await h.controller.handle(t.body);
    };
    await h.run({ before: async () => (h.completeBuilds(), redeliver()) });
    expect(await h.reload(record)).toMatchObject({ state: "active" });
    expect(h.provider.submitted).toHaveLength(1);
    expect(h.stages.created).toBe(1);
    expect(await h.store.appStatus(WS, APP)).toMatchObject({
      generation: h.seeded.app.generation + 1,
    });
  });

  it("two deployments of one app: exactly one promotes, the other fails stale", async () => {
    const h = await harness();
    const a = await h.submit(h.seeded.submission("deploy_key_twoa0001"));
    const b = await h.submit(h.seeded.submission("deploy_key_twob0001"));
    await h.run();
    const states = [(await h.reload(a))!, (await h.reload(b))!];
    expect(states.map((s) => s.state).sort()).toEqual(["active", "failed"]);
    expect(states.find((s) => s.state === "failed")).toMatchObject({ error: "STALE_GENERATION" });
    expect(await h.store.appStatus(WS, APP)).toMatchObject({
      generation: h.seeded.app.generation + 1,
    });
  });

  it("cancelling during a build cancels the provider build and rejects its artifact; nothing promotes", async () => {
    const h = await harness();
    const record = await h.submit();
    for (let i = 0; i < 4; i++) {
      const [task] = h.queue.due(h.clock.now());
      if (!task) break;
      await h.controller.handle(task.body);
      h.queue.acknowledge(task.name);
    }
    expect(await h.reload(record)).toMatchObject({ state: "building" });
    const { record: cancelled } = await h.store.cancelDeployment(
      { workspaceId: WS, appId: APP, deploymentId: record.deploymentId },
      0,
      h.clock.now(),
      h.wake,
    );
    expect(cancelled).toMatchObject({ state: "cancelled", cleanup: true });
    await h.run();
    expect(await h.reload(record)).toMatchObject({ state: "cancelled", cleanup: false });
    expect(h.cancelled).toEqual(h.submittedIds);
    expect(await h.store.artifactForAttempt(WS, APP, record.deploymentId, 1)).toMatchObject({
      state: "rejected",
      error: "CANCELLED",
    });
    expect(await h.store.appStatus(WS, APP)).toMatchObject({ generation: h.seeded.app.generation });
  });

  it("cancellation racing a running check wins: the stale worker stops and removes only its own candidate", async () => {
    const h = await harness();
    const other = await seedDeployableApp(h.store, "ws_neighbour001", h.clock.now());
    void other;
    const record = await h.submit();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const check = h.stages.check.bind(h.stages);
    let entered!: () => void;
    const inCheck = new Promise<void>((resolve) => (entered = resolve));
    h.stages.check = async (context) => {
      entered();
      await gate;
      return check(context);
    };
    // A neighbour's candidate with a confusable name must survive.
    h.stages.resources.set(`cand-ws_neighbour001-${record.deploymentId}`, {
      workspace: "ws_neighbour001",
      app: APP,
      deployment: record.deploymentId,
      image: "x",
    });
    const running = h.run();
    await inCheck;
    await h.store.cancelDeployment(
      { workspaceId: WS, appId: APP, deploymentId: record.deploymentId },
      0,
      h.clock.now(),
      h.wake,
    );
    release();
    await running;
    await h.run();
    expect(await h.reload(record)).toMatchObject({ state: "cancelled" });
    expect(h.stages.removed).toEqual([FakeStages.nameOf(record)]);
    expect(h.stages.resources.has(`cand-ws_neighbour001-${record.deploymentId}`)).toBe(true);
    expect(await h.store.appStatus(WS, APP)).toMatchObject({ generation: h.seeded.app.generation });
    // Activation won for another deployment: cancelling it now conflicts.
    const next = await h.submit(h.seeded.submission("deploy_key_after0001"));
    await h.run();
    await expect(
      h.store.cancelDeployment(
        { workspaceId: WS, appId: APP, deploymentId: next.deploymentId },
        0,
        h.clock.now(),
        h.wake,
      ),
    ).rejects.toMatchObject({ code: "STALE_GENERATION" });
  });
});

describe("M12.d malicious tasks and task ingress", () => {
  const AUDIENCE = "https://deploy-worker.example.run.app/_embody/tasks/deployment";
  const INVOKER = "embody-deploy-invoker@embody-test.iam.gserviceaccount.com";
  const token = (key: CryptoKey, claims: Record<string, unknown> = {}, lifetime = "5m") =>
    new SignJWT({ email: INVOKER, email_verified: true, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "google" })
      .setIssuer("https://accounts.google.com")
      .setAudience((claims["aud"] as string | undefined) ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(lifetime)
      .sign(key);

  it("rejects forged, foreign and malformed task bodies without doing privileged work", async () => {
    const h = await harness();
    const record = await h.submit();
    const [task] = h.queue.due(h.clock.now());
    const body = task!.body;
    const bad: unknown[] = [
      null,
      "dep",
      { ...body, url: "https://attacker.example/steal" },
      { ...body, headers: { authorization: "Bearer x" } },
      { ...body, deploymentId: "dep_../../etc" },
      { ...body, deploymentId: "dep_X'; DROP TABLE x;--" },
      { ...body, workspaceId: "ws_" },
      { ...body, reason: "promote" },
      { ...body, kind: "build" },
      { ...body, v: 2 },
      { ...body, txid: "1 OR 1=1" },
      { ...body, artifactId: "art_attacker0001" },
    ];
    for (const value of bad)
      expect(await h.controller.handle(value)).toMatchObject({ status: 400 });
    // Well-formed but naming another workspace or app: nothing found, nothing claimed.
    for (const value of [
      { ...body, workspaceId: "ws_attacker0001" },
      { ...body, appId: "app_attacker001" },
    ])
      expect(await h.controller.handle(value)).toMatchObject({ status: 200, outcome: "missing" });
    expect(await h.reload(record)).toMatchObject({ epoch: 1, state: "accepted" });
    expect(h.provider.submitted).toHaveLength(0);
  });

  it("accepts only a current controller-invoker OIDC token, before reading the body", async () => {
    const h = await harness();
    const google = await generateKeyPair("RS256");
    const attacker = await generateKeyPair("RS256");
    const worker = createDeploymentWorker({
      controller: h.controller,
      verifier: platformInvokerVerifier({
        audience: AUDIENCE,
        invokerEmail: INVOKER,
        key: google.publicKey,
      }),
    });
    const record = await h.submit();
    const [task] = h.queue.due(h.clock.now());
    const post = (headers: Record<string, string>, payload: unknown = task!.body) =>
      worker.inject({
        method: "POST",
        url: "/_embody/tasks/deployment",
        headers: { "content-type": "application/json", ...headers },
        payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      });
    const rejected: Record<string, string>[] = [
      {},
      { "x-gateway-auth": `Bearer ${await token(google.privateKey)}` },
      { authorization: `Basic ${await token(google.privateKey)}` },
      { authorization: `Bearer ${await token(attacker.privateKey)}` },
      {
        authorization: `Bearer ${await token(google.privateKey, { aud: "https://other.run.app" })}`,
      },
      {
        authorization: `Bearer ${await token(google.privateKey, { email: "app-runtime@x.iam.gserviceaccount.com" })}`,
      },
      { authorization: `Bearer ${await token(google.privateKey, { email_verified: false })}` },
      // Expired, and an over-long lifetime.
      { authorization: `Bearer ${await token(google.privateKey, {}, "-1m")}` },
      { authorization: `Bearer ${await token(google.privateKey, {}, "3h")}` },
      { authorization: `Bearer ${"a".repeat(5000)}` },
      // Cloud Tasks headers are set by any caller and never authenticate.
      { "x-cloudtasks-taskname": "dep-1", "x-cloudtasks-queuename": "deploy" },
    ];
    for (const headers of rejected) expect((await post(headers)).statusCode).toBe(401);
    // Authentication precedes body parsing: garbage or oversized bodies still get 401.
    expect((await post({}, "{not json")).statusCode).toBe(401);
    expect((await post({}, "x".repeat(10_000))).statusCode).toBe(401);
    expect(await h.reload(record)).toMatchObject({ epoch: 1 });
    const valid = { authorization: `Bearer ${await token(google.privateKey)}` };
    const ok = await post(valid);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ outcome: "advance:validating" });
    expect((await post(valid, { ...task!.body, url: "https://x" })).statusCode).toBe(400);
    expect((await post(valid, "x".repeat(10_000))).statusCode).toBe(413);
    expect(
      (await worker.inject({ method: "POST", url: "/_embody/tasks/reconcile", headers: valid }))
        .statusCode,
    ).toBe(200);
    expect(
      (await worker.inject({ method: "POST", url: "/_embody/tasks/reconcile" })).statusCode,
    ).toBe(401);
    expect((await worker.inject({ url: "/health" })).json()).toEqual({ live: true });
    await worker.close();
  });

  it("an admitted artifact is deployed only by its platform-recorded digest reference", async () => {
    const h = await harness();
    const record = await h.submit();
    await h.run();
    const final = (await h.reload(record))!;
    const release = (await h.store.release(WS, APP, final.releaseId!))!;
    const artifact = await h.store.artifact(WS, APP, release.artifactId);
    expect(release.imageReference).toBe(artifact!.imageReference);
    expect([...h.stages.resources.values()][0]!["image"]).toBe(artifact!.imageReference);
    expect(release.manifest).toMatchObject({
      workspaceId: WS,
      appId: APP,
      deploymentId: record.deploymentId,
      sourceDigest: record.submission.source.digest,
    });
  });
});

describe("M14 app list route", () => {
  it("lists only apps the credential may read, with names, and refuses another workspace", async () => {
    const h = await harness();
    const other = "app_unrelated001";
    await h.store.putApp(
      {
        workspaceId: WS,
        appId: other,
        name: "unrelated",
        registration: null,
        activeRelease: null,
        state: "unavailable",
      },
      null,
    );
    const issue = async (grants: { appId: string; role: "deployer" | "app-caller" }[]) => {
      const issued = newCredential({
        ...credentialInput(WS),
        grants: grants.map((grant) => ({ workspaceId: WS, ...grant })),
      });
      await h.store.putCredential(issued.credential, null);
      return { authorization: `Bearer ${issued.token}` };
    };
    const gateway = createWorkspaceGateway({
      store: h.store,
      token: signingIdentity,
      clock: h.clock,
      deployments: { queue: h.queue },
    });
    const deployer = await issue([{ appId: APP, role: "deployer" }]);
    const list = await gateway.inject({ url: `/v1/workspaces/${WS}/apps`, headers: deployer });
    expect(list.statusCode).toBe(200);
    const body: { workspaceId: string; apps: { appId: string; name?: string }[] } = list.json();
    expect(body.workspaceId).toBe(WS);
    expect(body.apps.map((app) => app.appId)).toEqual([APP]);
    expect(body.apps[0]).toMatchObject({ version: 1, generation: 1, status: "enabled" });
    // App status carries the name too, so the CLI can resolve `--app <name>`.
    const single = await gateway.inject({
      url: `/v1/workspaces/${WS}/apps/${APP}`,
      headers: deployer,
    });
    expect(single.json()).toMatchObject({ appId: APP, name: body.apps[0]!.name });
    const none = await issue([]);
    expect(
      (await gateway.inject({ url: `/v1/workspaces/${WS}/apps`, headers: none })).json(),
    ).toMatchObject({ apps: [] });
    const foreign = await gateway.inject({
      url: `/v1/workspaces/ws_otherws00001/apps`,
      headers: deployer,
    });
    expect(foreign.statusCode).toBe(401);
    expect(foreign.body).not.toContain(APP);
    await gateway.close();
  });
});
