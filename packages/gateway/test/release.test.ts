import { describe, expect, it } from "vitest";
import { BUILD_RECIPE, HOSTED_PROFILE, SOURCE_ADMISSION } from "@embody/cloud-contracts";
import {
  DEPLOYMENT_LIMITS,
  DeploymentController,
  StaleDeploymentError,
  candidateName,
  candidateOwner,
  createWorkspaceGateway,
  newCredential,
  purgeExpiredSources,
  type DeploymentRecord,
} from "../src/index.js";
import {
  APP,
  NAME,
  WS,
  durable,
  platform,
  plainPlugin,
  releaseHarness,
  subscriberPlugin,
  workflowPlugin,
} from "./release-fixture.js";
import { signingIdentity } from "./signing-fixture.js";
import { credentialInput } from "./store-conformance.js";

const DAY = 86_400_000;

describe("M13.a first deploy registers the app; updates switch route and manifest together", () => {
  it("promotes the first release of a reserved app: registration, route, idle state, environment", async () => {
    const h = await releaseHarness();
    expect((await h.catalog()).registration).toBeNull();
    const deployed = await h.deploy([plainPlugin(["ping"])]);
    expect(deployed.state).toBe("active");
    const app = await h.catalog();
    const release = (await h.store.release(WS, APP, deployed.releaseId!))!;
    const service = candidateName(platform.prefix, deployed);
    const endpoint = h.candidates.endpointOf(service);
    expect(app.activeRelease).toBe(deployed.releaseId);
    expect(app.state).toBe("idle");
    expect(app.generation).toBe(2);
    // Namespace from the platform record (the build's own name must match it, see below).
    expect(app.registration).toMatchObject({
      appId: NAME,
      endpoint,
      healthCheckUrl: `${endpoint}/health`,
    });
    expect(app.registration!.manifest.actions).toHaveProperty(["app.ping"]);
    expect(app.registration!.manifest.actions).not.toHaveProperty(["app.pong"]);
    expect(release.registration).toEqual(app.registration);
    expect(release).toMatchObject({
      candidate: { service, endpoint },
      schemaVersion: BUILD_RECIPE.storageSchemaVersion,
      sourceUploadId: deployed.submission.source.uploadId,
    });
    // Candidate from the admitted digest, labelled from platform records, min zero, exact invokers.
    const candidate = h.candidates.services.get(service)!;
    const artifact = (await h.store.artifact(WS, APP, deployed.artifactId!))!;
    expect(candidate.spec.image).toBe(artifact.imageReference);
    expect(candidate.spec.image).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(candidate.spec.labels).toEqual({
      "embody-platform": "emb",
      "embody-role": "candidate",
      "embody-owner": candidateOwner(deployed),
    });
    expect(candidate.spec.annotations).toEqual({
      "embody.dev/workspace": WS,
      "embody.dev/app": APP,
      "embody.dev/deployment": deployed.deploymentId,
    });
    expect(candidate.spec.serviceAccount).toBe(
      `${h.names.runtimeAccount}@embody-cloud.iam.gserviceaccount.com`,
    );
    expect(candidate.spec.maxInstances).toBe(HOSTED_PROFILE.maxInstancesPerApp);
    expect(candidate.invokers).toEqual([
      `serviceAccount:${platform.gatewayServiceAccount}`,
      `serviceAccount:${platform.controllerServiceAccount}`,
    ]);
    // The runtime gets its database URL from its own secret; it holds no migration authority.
    expect(candidate.spec.env).toContainEqual({
      name: "DATABASE_URL",
      secret: { secret: h.names.databaseSecret, version: "latest" },
    });
    expect(JSON.stringify(candidate.spec.env)).not.toMatch(/postgresql:\/\//);
    expect(h.identities.secrets.get(h.names.databaseSecret)?.accessor).toBe(
      candidate.spec.serviceAccount,
    );
    // The Cloud SQL connector authorizes by identity; data access stays per app role.
    expect([...h.identities.databaseClients]).toEqual([candidate.spec.serviceAccount]);
    const db = h.database.databases.get(h.names.database)!;
    expect(db.applied).toEqual([1, 2, 3, 4, 5, 6]);
    expect(db.marker).toBe("1");
    expect(h.queue.pending()).toEqual([]);
  });

  it("an update switches route, manifest and generation in one write; the old release drains", async () => {
    const h = await releaseHarness();
    const first = await h.deploy([plainPlugin(["ping"])]);
    const before = await h.catalog();
    const second = await h.deploy([plainPlugin(["ping", "pong"])]);
    expect(second.state).toBe("active");
    const after = await h.catalog();
    expect(after.generation).toBe(before.generation + 1);
    expect(after.activeRelease).toBe(second.releaseId);
    expect(after.registration!.endpoint).toBe(second.candidate!.endpoint);
    expect(after.registration!.endpoint).not.toBe(before.registration!.endpoint);
    expect(after.registration!.manifest.actions).toHaveProperty(["app.pong"]);
    expect(before.registration!.manifest.actions).not.toHaveProperty(["app.pong"]);
    const old = (await h.store.release(WS, APP, first.releaseId!))!;
    const now = h.clock.now().getTime();
    expect(Date.parse(old.drainUntil!)).toBeGreaterThan(now);
    expect(Date.parse(old.retainUntil!) - Date.parse(old.inactiveSince!)).toBe(
      HOSTED_PROFILE.inactiveReleaseRetentionDays * DAY,
    );
    // Still serving calls routed before the switch, until the drain ends.
    const oldService = first.candidate!.service;
    await h.controller.sweep(true);
    expect(h.candidates.services.has(oldService)).toBe(true);
    h.clock.advance(DEPLOYMENT_LIMITS.drainMs + 1000);
    await h.controller.sweep(true);
    expect(h.candidates.services.has(oldService)).toBe(false);
    expect(h.candidates.services.has(second.candidate!.service)).toBe(true);
    expect((await h.store.release(WS, APP, first.releaseId!))!.candidateRemovedAt).toBeDefined();
    // The sweep never moves the generation (WORKSPACES: generation is conservative).
    expect((await h.catalog()).generation).toBe(after.generation);
  });
});

/** The deployment ID of a route response (the body is untyped JSON). */
const idOf = (response: { json(): unknown }) =>
  (response.json() as { deploymentId: string }).deploymentId;
const failedWith = (record: DeploymentRecord | null, code: string, reason: string) => {
  expect(record).toMatchObject({ state: "failed", error: code, reason });
};

describe("M13.a manifest and namespace integrity", () => {
  it("a manifest substituted after admission fails the checks; the catalog is unchanged", async () => {
    const h = await releaseHarness();
    const first = await h.deploy([plainPlugin()]);
    const before = await h.catalog();
    h.state.plugins = [plainPlugin(["ping", "pong"])];
    const record = await h.submit(await h.submission());
    await h.run({
      rounds: 500,
      before: async () => {
        h.completeBuilds();
        const current = await h.reload(record);
        const artifact = current?.artifactId
          ? await h.store.artifact(WS, APP, current.artifactId)
          : null;
        // The retained manifest is replaced (e.g. a compromised outputs bucket).
        if (artifact?.state === "admitted")
          h.provider.outputs.set(
            `${artifact.outputPrefix}manifest.json`,
            Buffer.from(JSON.stringify({ format: "embody-build-output-v1" })),
          );
      },
    });
    failedWith(await h.reload(record), "CHECK_FAILED", "MANIFEST_MISMATCH");
    expect(await h.catalog()).toEqual(before);
    expect(before.activeRelease).toBe(first.releaseId);
  });

  it("a build whose own app name differs from the platform name is refused (it could serve no call)", async () => {
    const h = await releaseHarness();
    h.state.appId = "someone-else";
    const record = await h.deploy([plainPlugin()]);
    failedWith(record, "CHECK_FAILED", "APP_NAME_MISMATCH");
    expect((await h.catalog()).registration).toBeNull();
  });

  it("customer secret references are refused until M15 serves them", async () => {
    const h = await releaseHarness();
    const record = await h.deploy([plainPlugin()], {
      secretReferences: [
        {
          version: 1,
          workspaceId: WS,
          appId: APP,
          name: "API_KEY",
          secretId: "sec_aaaaaaaa",
          secretVersion: 1,
        },
      ],
    } as never);
    failedWith(record, "INVALID_INPUT", "SECRETS_UNSUPPORTED");
    expect((await h.catalog()).registration).toBeNull();
  });
});

describe("M13.b a failed update leaves the old route usable", () => {
  it("a candidate that never reports ready fails after the readiness bound; the old route serves", async () => {
    const h = await releaseHarness();
    const first = await h.deploy([plainPlugin()]);
    const before = await h.catalog();
    h.state.plugins = [plainPlugin(["ping", "pong"])];
    const record = await h.submit(await h.submission());
    h.health.unhealthy.add(h.candidates.endpointOf(candidateName(platform.prefix, record)));
    await h.run({ rounds: 2000 });
    const failed = await h.reload(record);
    failedWith(failed, "CHECK_FAILED", "READINESS_TIMEOUT");
    expect(Date.parse(failed!.updatedAt) - Date.parse(failed!.stageStartedAt!)).toBeLessThanOrEqual(
      0,
    );
    expect(await h.catalog()).toEqual(before);
    expect(h.candidates.services.has(first.candidate!.service)).toBe(true);
    // Cleanup removed the failed candidate (ownership-checked).
    expect(h.candidates.services.has(candidateName(platform.prefix, record))).toBe(false);
  });

  it("a revision that cannot start (crashing container) fails the check; the old route serves", async () => {
    const h = await releaseHarness();
    await h.deploy([plainPlugin()]);
    const before = await h.catalog();
    const record = await h.submit(await h.submission());
    h.candidates.failingNames.add(candidateName(platform.prefix, record));
    await h.run();
    failedWith(await h.reload(record), "CHECK_FAILED", "CANDIDATE_FAILED");
    expect(await h.catalog()).toEqual(before);
  });

  it("a compatible migration that fails rolls back; the deployment fails and nothing switches", async () => {
    const h = await releaseHarness();
    await h.deploy([plainPlugin()]);
    const before = await h.catalog();
    const db = h.database.databases.get(h.names.database)!;
    db.applied.pop(); // the update needs migration 6
    db.rows.set("card-1", '{"title":"kept"}');
    const apply = h.database.applyNextMigration.bind(h.database);
    h.database.applyNextMigration = () => Promise.reject(new Error("lock timeout"));
    const record = await h.deploy([plainPlugin(["ping", "pong"])]);
    failedWith(record, "DEPENDENCY_UNAVAILABLE", "HANDLER_ERROR");
    expect(db.applied).toEqual([1, 2, 3, 4, 5]);
    expect(db.rows.get("card-1")).toBe('{"title":"kept"}');
    expect(await h.catalog()).toEqual(before);
    h.database.applyNextMigration = apply;
  });

  it("a destructive migration is refused before anything executes", async () => {
    const policy = [1, 2, 3, 4, 5, 6].map((version) => ({
      version,
      compatibility: version === 6 ? ("contract" as const) : ("expand" as const),
    }));
    const h = await releaseHarness({ policy });
    await h.database.ensure(h.names);
    const db = h.database.databases.get(h.names.database)!;
    db.applied.push(1, 2, 3, 4, 5);
    db.rows.set("card-1", '{"title":"production"}');
    const record = await h.deploy([plainPlugin()]);
    failedWith(record, "CHECK_FAILED", "MIGRATION_REJECTED");
    expect(db.applied).toEqual([1, 2, 3, 4, 5]);
    expect([...db.rows]).toEqual([["card-1", '{"title":"production"}']]);
    expect(h.candidates.created).toBe(0);
    expect((await h.catalog()).registration).toBeNull();
  });
});

describe("M13.c concurrent promotions and stale workers cannot overwrite the winner", () => {
  it("two deployments racing: one promotes, the other fails STALE_GENERATION; one generation step", async () => {
    const h = await releaseHarness();
    await h.deploy([plainPlugin()]);
    const generation = (await h.catalog()).generation;
    h.state.plugins = [plainPlugin(["ping", "pong"])];
    const a = await h.submit(await h.submission());
    const b = await h.submit(await h.submission());
    await h.run();
    const [ra, rb] = [await h.reload(a), await h.reload(b)];
    const states = [ra!.state, rb!.state].sort();
    expect(states).toEqual(["active", "failed"]);
    const loser = ra!.state === "failed" ? ra! : rb!;
    const winner = ra!.state === "active" ? ra! : rb!;
    expect(loser.error).toBe("STALE_GENERATION");
    const app = await h.catalog();
    expect(app.generation).toBe(generation + 1);
    expect(app.activeRelease).toBe(winner.releaseId);
    expect(app.registration!.endpoint).toBe(winner.candidate!.endpoint);
    expect(h.candidates.services.has(candidateName(platform.prefix, loser))).toBe(false);
  });

  it("a stale promoting worker cannot overwrite a newer promotion", async () => {
    const h = await releaseHarness();
    await h.deploy([plainPlugin()]);
    const a = await h.submit(await h.submission());
    // Drive A to promoting, then hold its claim.
    for (let round = 0; round < 200; round++) {
      if ((await h.reload(a))!.state === "promoting") break;
      await h.run({ rounds: 1 });
    }
    expect((await h.reload(a))!.state).toBe("promoting");
    const claim = await h.store.claimDeployment(a, h.clock.now(), h.wake);
    expect(claim.decision.kind).toBe("claimed");
    const held = (claim.decision as { next: DeploymentRecord }).next;
    // Meanwhile B races A; A's lease expires and its lease wake reclaims it under a new epoch.
    const b = await h.deploy([plainPlugin(["ping", "pong"])]);
    const states = [(await h.reload(a))!.state, b.state].sort();
    expect(states).toEqual(["active", "failed"]);
    const winner = await h.catalog();
    await expect(
      h.store.completeDeployment(
        {
          workspaceId: WS,
          appId: APP,
          deploymentId: a.deploymentId,
          epoch: held.epoch,
          leaseToken: held.leaseToken!,
        },
        { kind: "promote", releaseId: "rel_stalerelease01" },
        h.clock.now(),
        h.wake,
      ),
    ).rejects.toBeInstanceOf(StaleDeploymentError);
    expect(await h.catalog()).toEqual(winner);
  });

  it("cancelled during checks: never promoted, its candidate removed", async () => {
    const h = await releaseHarness();
    await h.deploy([plainPlugin()]);
    const before = await h.catalog();
    const record = await h.submit(await h.submission());
    for (let round = 0; round < 200; round++) {
      if ((await h.reload(record))!.state === "checking") break;
      await h.run({ rounds: 1 });
    }
    await h.store.cancelDeployment(record, 0, h.clock.now(), h.wake);
    await h.run();
    expect((await h.reload(record))!.state).toBe("cancelled");
    expect(await h.catalog()).toEqual(before);
    expect(h.candidates.services.has(candidateName(platform.prefix, record))).toBe(false);
  });

  it("M12 review finding 1: a stage that outlives its deadline after a cancel has its late candidate removed", async () => {
    const h = await releaseHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = new DeploymentController({
      store: h.store,
      queue: h.queue,
      builds: h.builder,
      stages: {
        provision: async (context) => {
          await gate;
          // Creates the candidate only after the handler gave up and the deployment was cancelled.
          return h.stages.provision(context);
        },
        check: (context) => h.stages.check(context),
        abandon: (record) => h.stages.abandon(record),
      },
      clock: h.clock,
      handlerDeadlineMs: 20,
    });
    const record = await h.submit(await h.submission());
    for (let round = 0; round < 200; round++) {
      if ((await h.reload(record))!.state === "provisioning") break;
      await h.run({ rounds: 1 });
    }
    // Pre-provision the app environment so the late step goes straight to creating the candidate.
    const task = h.queue.due(h.clock.now())[0]!;
    const context = {
      deployment: (await h.reload(record))!,
      artifact: (await h.store.artifact(WS, APP, (await h.reload(record))!.artifactId!))!,
      signal: new AbortController().signal,
    };
    let step = await h.stages.provision(context);
    for (let i = 0; i < 20 && "reason" in step && step.reason !== "CANDIDATE_CREATING"; i++)
      step = await h.stages.provision(context);
    expect(step).toMatchObject({ pending: true, reason: "CANDIDATE_CREATING" });
    await h.candidates.remove(candidateName(platform.prefix, record));
    expect((await slow.handle(task.body)).outcome).toBe("timed-out");
    await h.store.cancelDeployment(record, 0, h.clock.now(), h.wake);
    release();
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(h.candidates.created).toBe(2);
    expect(h.candidates.services.has(candidateName(platform.prefix, record))).toBe(false);
  });
});

async function rollbackGateway(h: Awaited<ReturnType<typeof releaseHarness>>) {
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
  const rollback = async (releaseId: string, expectedGeneration?: number) =>
    gateway.inject({
      method: "POST",
      url: `/v1/workspaces/${WS}/apps/${APP}/rollback`,
      headers: { authorization: `Bearer ${issued.token}` },
      payload: {
        version: 1,
        workspaceId: WS,
        appId: APP,
        operation: "rollback",
        expectedGeneration: expectedGeneration ?? (await h.catalog()).generation,
        releaseId,
      },
    });
  return { gateway, rollback };
}

describe("M13.d rollback restores previous code with data intact; incompatible rollback is refused", () => {
  it("rolls back by digest with a fresh candidate and checks; data and schema untouched", async () => {
    const h = await releaseHarness();
    const v1 = await h.deploy([plainPlugin(["ping"])]);
    const v1App = await h.catalog();
    const v2 = await h.deploy([plainPlugin(["ping", "pong"])]);
    const db = h.database.databases.get(h.names.database)!;
    db.rows.set("card-1", '{"title":"written under v2"}');
    const rows = JSON.stringify([...db.rows]);
    const { gateway, rollback } = await rollbackGateway(h);
    const accepted = await rollback(v1.releaseId!);
    expect(accepted.statusCode).toBe(202);
    const replay = await rollback(v1.releaseId!, (await h.catalog()).generation);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(accepted.json());
    await h.run();
    const done = (await h.store.deployment(WS, APP, idOf(accepted)))!;
    expect(done).toMatchObject({
      state: "active",
      rollbackOf: v1.releaseId,
      artifactId: v1.artifactId,
    });
    const app = await h.catalog();
    const release = (await h.store.release(WS, APP, done.releaseId!))!;
    expect(release).toMatchObject({ rollbackOf: v1.releaseId, artifactId: v1.artifactId });
    expect(app.activeRelease).toBe(done.releaseId);
    // Previous code: v1's manifest and image, on a fresh candidate.
    expect(app.registration!.manifest).toEqual(v1App.registration!.manifest);
    expect(app.registration!.endpoint).toBe(done.candidate!.endpoint);
    expect(app.registration!.endpoint).not.toBe(v1App.registration!.endpoint);
    expect(h.candidates.services.get(done.candidate!.service)!.spec.image).toBe(
      release.imageReference,
    );
    expect(JSON.stringify([...db.rows])).toBe(rows);
    expect(db.applied).toEqual([1, 2, 3, 4, 5, 6]);
    // v1's artifact is pinned again by the new release; v2 now drains and is retained 30 days.
    expect((await h.store.artifact(WS, APP, v1.artifactId!))!.pinnedBy).toBe(done.releaseId);
    expect((await h.store.artifact(WS, APP, v2.artifactId!))!.pinnedBy).toBeUndefined();
    expect((await h.store.release(WS, APP, v2.releaseId!))!.inactiveSince).toBeDefined();
    await gateway.close();
  });

  it("refuses explicitly: the active release, an expired release, a stale generation, an unknown release", async () => {
    const h = await releaseHarness();
    const v1 = await h.deploy([plainPlugin(["ping"])]);
    const v2 = await h.deploy([plainPlugin(["ping", "pong"])]);
    const { gateway, rollback } = await rollbackGateway(h);
    const toActive = await rollback(v2.releaseId!);
    expect(toActive.statusCode).toBe(409);
    expect(toActive.json().error.code).toBe("ROLLBACK_INCOMPATIBLE");
    expect((await rollback(v1.releaseId!, 0)).json().error.code).toBe("STALE_GENERATION");
    expect((await rollback("rel_doesnotexist1")).statusCode).toBe(404);
    h.clock.advance((HOSTED_PROFILE.inactiveReleaseRetentionDays + 1) * DAY);
    const expired = await rollback(v1.releaseId!);
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error).toEqual({
      code: "ROLLBACK_INCOMPATIBLE",
      message:
        "Rollback target is no longer retained or is incompatible with current data or workflows.",
    });
    await gateway.close();
  });

  it("refuses a rollback below the schema reader floor of applied migrations", async () => {
    const policy = [
      ...[1, 2, 3, 4, 5, 6].map((version) => ({ version, compatibility: "expand" as const })),
      { version: 7, compatibility: "expand" as const, readerFloor: 7 },
    ];
    const h = await releaseHarness({ policy });
    const v1 = await h.deploy([plainPlugin(["ping"])]);
    await h.deploy([plainPlugin(["ping", "pong"])]);
    const before = await h.catalog();
    // An operator platform upgrade applied migration 7, which older readers cannot read.
    h.database.databases.get(h.names.database)!.applied.push(7);
    const { gateway, rollback } = await rollbackGateway(h);
    const accepted = await rollback(v1.releaseId!);
    expect(accepted.statusCode).toBe(202);
    await h.run();
    failedWith(
      await h.store.deployment(WS, APP, idOf(accepted)),
      "ROLLBACK_INCOMPATIBLE",
      "SCHEMA_INCOMPATIBLE",
    );
    expect(await h.catalog()).toEqual(before);
    await gateway.close();
  });

  it("refuses a rollback whose code lacks a workflow version still in use", async () => {
    const h = await releaseHarness();
    const caps = { capabilities: durable } as never;
    const v1 = await h.deploy(
      [workflowPlugin({ fulfil: { version: "1.0.0", steps: ["ship"] } })],
      caps,
    );
    await h.deploy(
      [
        workflowPlugin({
          fulfil: { version: "1.0.0", steps: ["ship"] },
          audit: { version: "1.0.0", steps: ["log"] },
        }),
      ],
      caps,
    );
    const before = await h.catalog();
    h.database.databases.get(h.names.database)!.workflows.push({
      definition: "app.audit",
      version: "1.0.0",
      instances: 2,
    });
    const { gateway, rollback } = await rollbackGateway(h);
    const accepted = await rollback(v1.releaseId!);
    await h.run();
    failedWith(
      await h.store.deployment(WS, APP, idOf(accepted)),
      "ROLLBACK_INCOMPATIBLE",
      "WORKFLOW_VERSION_IN_USE",
    );
    expect(await h.catalog()).toEqual(before);
    await gateway.close();
  });
});

describe("M13.e workflow versions and subscriptions switch with the active generation", () => {
  it("keeps running versions: a release retaining v1 promotes; dropping or changing v1 is refused", async () => {
    const h = await releaseHarness();
    const caps = { capabilities: durable } as never;
    const v1 = await h.deploy(
      [workflowPlugin({ fulfil: { version: "1.0.0", steps: ["ship"] } })],
      caps,
    );
    expect(v1.state).toBe("active");
    const db = h.database.databases.get(h.names.database)!;
    db.workflows.push({ definition: "app.fulfil", version: "1.0.0", instances: 1 });
    // v2 of the app keeps fulfil@1.0.0 for the running instance and adds a new definition.
    const kept = await h.deploy(
      [
        workflowPlugin({
          fulfil: { version: "1.0.0", steps: ["ship"] },
          fulfilNext: { version: "2.0.0", steps: ["pack", "ship"] },
        }),
      ],
      caps,
    );
    expect(kept.state).toBe("active");
    const generation = (await h.catalog()).generation;
    const dropped = await h.deploy(
      [workflowPlugin({ fulfil: { version: "2.0.0", steps: ["ship"] } })],
      caps,
    );
    failedWith(dropped, "CHECK_FAILED", "WORKFLOW_VERSION_IN_USE");
    const changed = await h.deploy(
      [workflowPlugin({ fulfil: { version: "1.0.0", steps: ["pack", "ship"] } })],
      caps,
    );
    failedWith(changed, "CHECK_FAILED", "WORKFLOW_VERSION_CHANGED");
    expect((await h.catalog()).generation).toBe(generation);
    expect((await h.catalog()).activeRelease).toBe(kept.releaseId);
    // Once the v1 instances finish, the release replacing v1 promotes.
    db.workflows.length = 0;
    const replaced = await h.deploy(
      [workflowPlugin({ fulfil: { version: "2.0.0", steps: ["ship"] } })],
      caps,
    );
    expect(replaced.state).toBe("active");
    // Durable candidates get the app's own wake queue and invoker, and the drain URL.
    const candidate = h.candidates.services.get(replaced.candidate!.service)!;
    expect(candidate.spec.env).toContainEqual({
      name: "EMBODY_DRAIN_URL",
      value: `${replaced.candidate!.endpoint}/_embody/drain`,
    });
    expect(candidate.invokers).toContain(
      `serviceAccount:${h.names.invokerAccount}@embody-cloud.iam.gserviceaccount.com`,
    );
  });

  it("subscriptions switch in the same write as the active release and generation", async () => {
    const h = await releaseHarness();
    const caps = { capabilities: { ...durable, workflows: false, subscriptions: true } } as never;
    const first = await h.deploy([subscriberPlugin(["shop.ordered"])], caps);
    expect(first.state).toBe("active");
    expect((await h.catalog()).registration!.manifest.eventSubscriptions).toEqual(["shop.ordered"]);
    const second = await h.deploy([subscriberPlugin(["shop.cancelled"])], caps);
    const app = await h.catalog();
    expect(app.activeRelease).toBe(second.releaseId);
    expect(app.registration!.manifest.eventSubscriptions).toEqual(["shop.cancelled"]);
    expect(
      (await h.store.release(WS, APP, second.releaseId!))!.manifest.artifact!.subscriptions,
    ).toEqual(["shop.cancelled"]);
  });
});

describe("M13 retention: replaced releases do not hold the workspace source quota (M12 re-review N1)", () => {
  it("a workspace that promoted more than 100 MiB of source over time can still upload", async () => {
    const h = await releaseHarness();
    const max = SOURCE_ADMISSION.maxRetainedSourceBytesPerWorkspace;
    const bytes = HOSTED_PROFILE.maxSourceBytes;
    const releases: DeploymentRecord[] = [];
    // 9 × 10 MiB promoted, each replacing the previous one.
    for (let i = 0; i < 9; i++) releases.push(await h.deploy([plainPlugin()], {}, bytes));
    expect(releases.every((record) => record.state === "active")).toBe(true);
    const active = releases.at(-1)!;
    for (const replaced of releases.slice(0, -1)) {
      const source = (await h.store.source(WS, APP, replaced.submission.source.uploadId))!;
      expect(source.pinnedBy).toBeUndefined();
      expect((await h.store.artifact(WS, APP, replaced.artifactId!))!.pinnedBy).toBeUndefined();
    }
    expect((await h.store.source(WS, APP, active.submission.source.uploadId))!.pinnedBy).toBe(
      active.releaseId,
    );
    // After the deployment (90 d) and inactive-release (30 d) retentions, the sweep frees them.
    h.clock.advance((HOSTED_PROFILE.deploymentRetentionDays + 1) * DAY);
    const purged = await purgeExpiredSources({
      store: h.store,
      objects: h.objects,
      now: h.clock.now(),
    });
    expect(purged.deleted).toBe(8);
    expect(await h.store.source(WS, APP, active.submission.source.uploadId)).not.toBeNull();
    // 90 MiB were promoted; with only the active release pinned, 10 MiB more fit many times over.
    for (let i = 0; i < Math.floor(max / bytes) - 1; i++) await h.submission({}, bytes);
  });
});

describe("M13 candidate sweep is ownership-checked and bounded", () => {
  it("removes orphans of ended deployments, keeps running and active ones, never touches foreign services", async () => {
    const h = await releaseHarness();
    const active = await h.deploy([plainPlugin()]);
    const running = await h.submit(await h.submission());
    const runningName = candidateName(platform.prefix, running);
    const base = h.candidates.services.get(active.candidate!.service)!.spec;
    const spec = (
      name: string,
      labels: Record<string, string>,
      annotations: Record<string, string>,
    ) => h.candidates.create({ ...base, name, labels, annotations });
    const ownerOf = (deploymentId: string) => ({ workspaceId: WS, appId: APP, deploymentId });
    const annotationsOf = (deploymentId: string) => ({
      "embody.dev/workspace": WS,
      "embody.dev/app": APP,
      "embody.dev/deployment": deploymentId,
    });
    const labelsOf = (deploymentId: string, prefix = "emb") => ({
      "embody-platform": prefix,
      "embody-role": "candidate",
      "embody-owner": candidateOwner(ownerOf(deploymentId)),
    });
    await spec(runningName, labelsOf(running.deploymentId), annotationsOf(running.deploymentId));
    // A cancelled deployment whose late candidate escaped cleanup.
    const cancelled = await h.submit(await h.submission());
    await h.store.cancelDeployment(cancelled, 0, h.clock.now(), h.wake);
    const orphan = candidateName(platform.prefix, cancelled);
    await spec(orphan, labelsOf(cancelled.deploymentId), annotationsOf(cancelled.deploymentId));
    // Foreign: another platform prefix, a forged owner label, a name that does not match.
    await spec(
      "other-c0123",
      labelsOf(cancelled.deploymentId, "oth"),
      annotationsOf(cancelled.deploymentId),
    );
    await spec(
      "emb-cforged000000000000000000",
      labelsOf(cancelled.deploymentId),
      annotationsOf(cancelled.deploymentId),
    );
    await spec(
      candidateName(platform.prefix, ownerOf("dep_forgedowner001")),
      labelsOf(cancelled.deploymentId),
      annotationsOf("dep_forgedowner001"),
    );
    const generation = (await h.catalog()).generation;
    const result = (await h.sweep.sweep(h.clock.now())) as { removed: number };
    expect(result.removed).toBe(1);
    expect(h.candidates.services.has(orphan)).toBe(false);
    expect(h.candidates.services.has(runningName)).toBe(true);
    expect(h.candidates.services.has(active.candidate!.service)).toBe(true);
    expect(h.candidates.services.has("other-c0123")).toBe(true);
    expect(h.candidates.services.has("emb-cforged000000000000000000")).toBe(true);
    expect((await h.catalog()).generation).toBe(generation);
  });
});
