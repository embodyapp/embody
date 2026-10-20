import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { submissionFingerprint, type DeploymentSubmission } from "@embody/cloud-contracts";
import {
  DEPLOYMENT_LIMITS,
  DeploymentError,
  StaleDeploymentError,
  purgeExpiredSources,
  type ArtifactStore,
  type DeploymentRecord,
  type DeploymentStore,
  type DeploymentWake,
  type GatewayStore,
  type SourceStore,
} from "../src/index.js";
import { APP, pin, seedDeployableApp } from "./deployment-fixture.js";

type Store = GatewayStore & SourceStore & ArtifactStore & DeploymentStore;
const T0 = new Date("2030-01-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 86_400_000;
const MiB = 1024 * 1024;
const noObjects = { delete: () => Promise.resolve() };

/** Shared M12 store contract: the memory store and the real PostgreSQL store must both pass. */
export function deploymentStoreConformance(name: string, factory: () => Promise<Store>): void {
  describe(`${name}: M12 deployment store`, () => {
    let store: Store;
    let workspace: string;
    let wakes: { wake: DeploymentWake; txid: string }[];
    const hook = (wakeList: readonly DeploymentWake[], txid: string) => {
      for (const wake of wakeList) wakes.push({ wake, txid });
      return Promise.resolve();
    };
    const failing = () => Promise.reject(new Error("queue outage"));
    beforeEach(async () => {
      store = await factory();
      workspace = `ws_${randomBytes(8).toString("hex")}`;
      wakes = [];
    });
    afterEach(async () => store.close());
    const submit = (submission: DeploymentSubmission, now = T0, wake = hook) =>
      store.submitDeployment(
        { submission, fingerprint: submissionFingerprint(submission), actorId: "alice", now },
        wake,
      );
    const keyOf = (record: DeploymentRecord) => ({
      workspaceId: record.workspaceId,
      appId: record.appId,
      deploymentId: record.deploymentId,
    });
    const claimed = async (record: DeploymentRecord, now = T0) => {
      const { decision } = await store.claimDeployment(keyOf(record), now, hook);
      if (decision.kind !== "claimed") throw new Error(`expected a claim, got ${decision.kind}`);
      return decision.next;
    };
    const fenceOf = (record: DeploymentRecord) => ({
      ...keyOf(record),
      epoch: record.epoch,
      leaseToken: record.leaseToken!,
    });

    it("M02.b: commits the deployment, its key and source retention with one wake; replays and conflicts", async () => {
      const { submission, source } = await seedDeployableApp(store, workspace, T0);
      const first = await submit(submission());
      expect(first.replay).toBe(false);
      expect(first.record).toMatchObject({ state: "accepted", stageAttempt: 1, epoch: 1 });
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.wake).toMatchObject({
        reason: "submit",
        deploymentId: first.record.deploymentId,
      });
      expect(wakes[0]!.txid).toMatch(/^\d+$/);
      expect(await store.transactionStatus(wakes[0]!.txid)).toBe("committed");
      // Retained as long as the deployment (MD15), not pinned: only a release pins source.
      const retained = await store.source(workspace, APP, source.uploadId);
      expect(retained?.pinnedBy).toBeUndefined();
      expect(Date.parse(retained!.retainUntil)).toBeGreaterThanOrEqual(
        Date.parse(first.record.retainUntil),
      );
      // Same key and body (any key order): the original deployment, no new wake, even later.
      const reordered = JSON.parse(JSON.stringify(submission())) as Record<string, unknown>;
      const replay = await submit(
        Object.fromEntries(Object.entries(reordered).reverse()) as unknown as DeploymentSubmission,
        at(60_000),
      );
      expect(replay.replay).toBe(true);
      expect(replay.record.deploymentId).toBe(first.record.deploymentId);
      expect(wakes).toHaveLength(1);
      await expect(
        submit(submission("deploy_key_00000001", { secretReferences: [], expectedGeneration: 99 })),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(await store.deployment(workspace, APP, first.record.deploymentId)).toMatchObject({
        state: "accepted",
      });
    });

    it("concurrent identical submissions create one deployment", async () => {
      const { submission } = await seedDeployableApp(store, workspace, T0);
      const results = await Promise.all(Array.from({ length: 6 }, () => submit(submission())));
      expect(new Set(results.map((r) => r.record.deploymentId)).size).toBe(1);
      expect(results.filter((r) => !r.replay)).toHaveLength(1);
      expect(wakes).toHaveLength(1);
    });

    it("rejects unknown/disabled apps, stale generations, foreign or unverified sources and over-limit work", async () => {
      const { submission, app } = await seedDeployableApp(store, workspace, T0);
      await expect(
        submit({ ...submission(), appId: "app_unknown001" } as DeploymentSubmission),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        submit(submission("deploy_key_stale0001", { expectedGeneration: app.generation + 1 })),
      ).rejects.toMatchObject({ code: "STALE_GENERATION" });
      await expect(
        submit(
          submission("deploy_key_digest001", {
            source: { ...submission().source, digest: pin("other") },
          }),
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      // Another workspace's verified source (same shape, foreign owner).
      const other = `ws_${randomBytes(8).toString("hex")}`;
      const foreign = await seedDeployableApp(store, other, T0, "source_key_foreign1");
      await expect(
        submit(submission("deploy_key_foreign01", { source: foreign.submission().source })),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      // Unverified (pending) source.
      const pending = await store.admitSource({
        workspaceId: workspace,
        appId: APP,
        idempotencyKey: "source_key_pending1",
        digest: pin("pending"),
        bytes: 100,
        actorId: "alice",
        now: T0,
      });
      await expect(
        submit(
          submission("deploy_key_pending01", {
            source: { uploadId: pending.record.uploadId, digest: pin("pending"), bytes: 100 },
          }),
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      for (let i = 0; i < DEPLOYMENT_LIMITS.maxActivePerApp; i++)
        await submit(submission(`deploy_key_limit000${i}`));
      await expect(submit(submission("deploy_key_limit0009"))).rejects.toMatchObject({
        code: "LIMIT_EXCEEDED",
      });
      // Disabled app: no admission.
      const current = (await store.snapshot(workspace))!.apps[0]!;
      const { revision: _r, generation: _g, lifecycleFence: _l, ...write } = current;
      void _r;
      void _g;
      void _l;
      await store.putApp({ ...write, state: "disabled" }, current.revision);
      const disabled = await store.appStatus(workspace, APP);
      expect(disabled).toMatchObject({ status: "disabled", lifecycleFence: 1 });
      await expect(
        submit(submission("deploy_key_disabled1", { expectedGeneration: disabled!.generation })),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("a failed wake (queue outage) commits nothing and pins nothing", async () => {
      const { submission, source } = await seedDeployableApp(store, workspace, T0);
      await expect(submit(submission(), T0, failing)).rejects.toThrow(/queue outage/);
      expect(await store.source(workspace, APP, source.uploadId)).toMatchObject({
        revision: source.revision,
      });
      expect((await store.source(workspace, APP, source.uploadId))?.pinnedBy).toBeUndefined();
      const retried = await submit(submission());
      expect(retried.replay).toBe(false);
    });

    it("claims under a lease with a lease wake; a second claim sees the lease; completion is fenced", async () => {
      const { submission } = await seedDeployableApp(store, workspace, T0);
      const { record } = await submit(submission());
      const claim = await claimed(record);
      expect(claim).toMatchObject({ epoch: 2, crashes: 1 });
      expect(Date.parse(claim.leaseUntil!)).toBe(T0.getTime() + DEPLOYMENT_LIMITS.leaseMs);
      expect(wakes.at(-1)!.wake).toMatchObject({ reason: "lease", epoch: 2 });
      expect((await store.claimDeployment(keyOf(record), at(1000), hook)).decision).toMatchObject({
        kind: "leased",
      });
      // Stale fences: wrong token, wrong epoch, another workspace.
      for (const fence of [
        { ...fenceOf(claim), leaseToken: "f".repeat(32) },
        { ...fenceOf(claim), epoch: 1 },
        { ...fenceOf(claim), workspaceId: `ws_${randomBytes(8).toString("hex")}` },
      ])
        await expect(
          store.completeDeployment(fence, { kind: "advance" }, at(1000), hook),
        ).rejects.toBeInstanceOf(StaleDeploymentError);
      const next = await store.completeDeployment(
        fenceOf(claim),
        { kind: "advance" },
        at(1000),
        hook,
      );
      expect(next).toMatchObject({ state: "validating", epoch: 3, crashes: 0, stageAttempt: 1 });
      expect(next.leaseToken).toBeUndefined();
      // The same completion again is stale (exactly once).
      await expect(
        store.completeDeployment(fenceOf(claim), { kind: "advance" }, at(1000), hook),
      ).rejects.toBeInstanceOf(StaleDeploymentError);
      // Cross-app/cross-workspace lookups never see it.
      expect(await store.deployment(workspace, "app_other00001", record.deploymentId)).toBeNull();
      expect(
        (
          await store.claimDeployment(
            { ...keyOf(record), workspaceId: `ws_${randomBytes(8).toString("hex")}` },
            at(2000),
            hook,
          )
        ).decision,
      ).toEqual({ kind: "missing" });
    });

    it("an expired lease is reclaimed; repeated lost claims become a counted attempt", async () => {
      const { submission } = await seedDeployableApp(store, workspace, T0);
      const { record } = await submit(submission());
      let now = 0;
      let current = await claimed(record, at(now));
      current = await store.completeDeployment(
        fenceOf(current),
        { kind: "advance" },
        at(now),
        hook,
      );
      for (let i = 0; i < DEPLOYMENT_LIMITS.maxCrashes; i++) {
        now += DEPLOYMENT_LIMITS.leaseMs + 1000;
        current = await claimed(current, at(now));
      }
      now += DEPLOYMENT_LIMITS.leaseMs + 1000;
      const { decision } = await store.claimDeployment(keyOf(record), at(now), hook);
      expect(decision).toMatchObject({
        kind: "settled",
        next: { state: "validating", stageAttempt: 2, crashes: 0 },
      });
    });

    it("cancellation fences claims, does not re-advance, and conflicts after a terminal state", async () => {
      const { submission } = await seedDeployableApp(store, workspace, T0);
      const { record } = await submit(submission());
      const claim = await claimed(record);
      await expect(store.cancelDeployment(keyOf(record), 7, at(10), hook)).rejects.toMatchObject({
        code: "STALE_GENERATION",
      });
      const cancelled = await store.cancelDeployment(keyOf(record), 0, at(10), hook);
      expect(cancelled).toMatchObject({
        changed: true,
        record: { state: "cancelled", cancellationFence: 1 },
      });
      const again = await store.cancelDeployment(keyOf(record), 0, at(20), hook);
      expect(again).toMatchObject({ changed: false, record: { cancellationFence: 1 } });
      await expect(
        store.completeDeployment(fenceOf(claim), { kind: "advance" }, at(30), hook),
      ).rejects.toBeInstanceOf(StaleDeploymentError);
      await expect(
        store.cancelDeployment({ ...keyOf(record), appId: "app_other00001" }, 1, at(40), hook),
      ).rejects.toBeInstanceOf(DeploymentError);
    });

    const toPromoting = async (record: DeploymentRecord, artifactId: string) => {
      let current = record;
      for (const outcome of ["advance", "advance", "build", "advance", "advance"] as const) {
        current = await claimed(current);
        current = await store.completeDeployment(
          fenceOf(current),
          outcome === "build" ? { kind: "advance", artifactId } : { kind: "advance" },
          T0,
          hook,
        );
      }
      expect(current.state).toBe("promoting");
      return claimed(current);
    };
    const artifact = async (record: DeploymentRecord) => {
      const artifactId = `art_${randomBytes(8).toString("hex")}`;
      const created = await store.createArtifact({
        workspaceId: workspace,
        appId: APP,
        deploymentId: record.deploymentId,
        attempt: 1,
        artifactId,
        sourceUploadId: record.submission.source.uploadId,
        sourceDigest: record.submission.source.digest,
        state: "building",
        recipe: "embody-node24-pnpm-v1",
        configDigest: pin("config"),
        image: `us-central1-docker.pkg.dev/p/builds/${workspace}/${APP}:${artifactId}`,
        outputPrefix: `builds/${workspace}/${APP}/${artifactId}/`,
        logsBucket: `gs://logs/logs/${workspace}/${APP}/${artifactId}`,
        createdAt: T0.toISOString(),
        retainUntil: at(DEPLOYMENT_LIMITS.deploymentDeadlineMs).toISOString(),
      });
      await store.updateArtifact(
        {
          ...created,
          buildId: "0123456789abcdef",
          state: "admitted",
          imageDigest: pin(artifactId),
          imageReference: `us-central1-docker.pkg.dev/p/builds/${workspace}/${APP}@${pin(artifactId)}`,
          manifest: {
            version: 1,
            profile: "request-only-v1",
            recipe: "embody-node24-pnpm-v1",
            nodeMajor: 24,
            appId: "my-app",
            appVersion: "0.1.0",
            entrypoint: "dist/src/index.js",
            publishes: [],
            subscriptions: [],
            workflows: [],
            catalogDigest: pin("catalog"),
          },
          manifestDigest: pin("manifest"),
          sbomDigest: pin("sbom"),
          finishedAt: T0.toISOString(),
        },
        created.revision,
      );
      return artifactId;
    };

    it("promotion CAS: one of two deployments of an app wins, the other fails stale; release and pins written", async () => {
      const { submission, app } = await seedDeployableApp(store, workspace, T0);
      const a = (await submit(submission("deploy_key_racea001"))).record;
      const b = (await submit(submission("deploy_key_raceb001"))).record;
      const pa = await toPromoting(a, await artifact(a));
      const pb = await toPromoting(b, await artifact(b));
      const [ra, rb] = await Promise.allSettled([
        store.completeDeployment(
          fenceOf(pa),
          { kind: "promote", releaseId: "rel_releasea0001" },
          at(1),
          hook,
        ),
        store.completeDeployment(
          fenceOf(pb),
          { kind: "promote", releaseId: "rel_releaseb0001" },
          at(1),
          hook,
        ),
      ]);
      const states = [ra, rb].map((r) => (r.status === "fulfilled" ? r.value.state : "rejected"));
      expect(states.sort()).toEqual(["active", "failed"]);
      const winner = [ra, rb].find(
        (r) => r.status === "fulfilled" && r.value.state === "active",
      ) as PromiseFulfilledResult<DeploymentRecord>;
      const loser = [ra, rb].find(
        (r) => r.status === "fulfilled" && r.value.state === "failed",
      ) as PromiseFulfilledResult<DeploymentRecord>;
      expect(loser.value).toMatchObject({ error: "STALE_GENERATION" });
      const status = await store.appStatus(workspace, APP);
      expect(status).toMatchObject({
        generation: app.generation + 1,
        activeReleaseId: winner.value.releaseId,
      });
      const release = await store.release(workspace, APP, winner.value.releaseId!);
      expect(release).toMatchObject({
        deploymentId: winner.value.deploymentId,
        generation: app.generation + 1,
        manifest: {
          releaseId: winner.value.releaseId,
          imageDigest: expect.stringMatching(/^sha256:/),
        },
      });
      expect((await store.artifact(workspace, APP, release!.artifactId))?.pinnedBy).toBe(
        winner.value.releaseId,
      );
      // The release pins its source indefinitely (MD15): no sweep removes it, however late.
      expect((await store.source(workspace, APP, submission().source.uploadId))?.pinnedBy).toBe(
        winner.value.releaseId,
      );
      const late = at(400 * DAY);
      await purgeExpiredSources({ store, objects: noObjects, now: late, limit: 1000 });
      expect(await store.source(workspace, APP, submission().source.uploadId)).not.toBeNull();
      expect(await store.release(workspace, "app_other00001", winner.value.releaseId!)).toBeNull();
    });

    it("review B1: deployed source leaves the quota when its deployments' retention ends", async () => {
      // 10 deployments of maximum-size sources fill the 100 MiB workspace quota. Each is cancelled
      // at once, so the active-deployment limit never applies. Before M12's fix they were pinned
      // forever and the workspace could never upload again.
      let last: DeploymentRecord | undefined;
      const uploads: string[] = [];
      for (let i = 0; i < 10; i++) {
        const { submission, source } = await seedDeployableApp(
          store,
          workspace,
          T0,
          `source_key_quota0${i}`,
          10 * MiB,
        );
        uploads.push(source.uploadId);
        const { record } = await submit(submission(`deploy_key_quota00${i}`));
        last = (await store.cancelDeployment(keyOf(record), 0, T0, hook)).record;
      }
      const upload = (key: string, now: Date) =>
        store.admitSource({
          workspaceId: workspace,
          appId: APP,
          idempotencyKey: key,
          digest: pin(key),
          bytes: 1,
          actorId: "alice",
          now,
        });
      // Within the deployments' retention (MD15: 90 days) the source is kept and counted.
      await expect(upload("source_key_quotafull", at(DAY))).rejects.toMatchObject({
        code: "LIMIT_EXCEEDED",
      });
      // After it, the sweep removes the source and the workspace can upload again.
      const after = new Date(Date.parse(last!.retainUntil) + DAY);
      for (let pass = 0; pass < 20; pass++) {
        const { deleted } = await purgeExpiredSources({
          store,
          objects: noObjects,
          now: after,
          limit: 1000,
        });
        if (deleted === 0) break;
      }
      for (const uploadId of uploads)
        expect(await store.source(workspace, APP, uploadId)).toBeNull();
      const { record } = await upload("source_key_quotafree", after);
      expect(record.state).toBe("pending");
    });

    it("promotion pins the release's source, and fails closed when that source is gone", async () => {
      const { submission, source } = await seedDeployableApp(store, workspace, T0);
      const { record } = await submit(submission());
      const promoting = await toPromoting(record, await artifact(record));
      // A purge tombstone (or any loss of the source) between submission and promotion.
      const current = (await store.source(workspace, APP, source.uploadId))!;
      await store.updateSource({ ...current, purging: true }, current.revision);
      const next = await store.completeDeployment(
        fenceOf(promoting),
        { kind: "promote", releaseId: "rel_sourcegone01" },
        at(1),
        hook,
      );
      expect(next).toMatchObject({
        state: "failed",
        error: "DEPENDENCY_UNAVAILABLE",
        reason: "SOURCE_MISSING",
      });
      expect(await store.release(workspace, APP, "rel_sourcegone01")).toBeNull();
      expect((await store.appStatus(workspace, APP))?.activeReleaseId).not.toBe("rel_sourcegone01");
    });

    it("disabling the app mid-flight fails the deployment at its next transition", async () => {
      const { submission } = await seedDeployableApp(store, workspace, T0);
      const { record } = await submit(submission());
      const claim = await claimed(record);
      const current = (await store.snapshot(workspace))!.apps[0]!;
      const { revision: _r, generation: _g, lifecycleFence: _l, ...write } = current;
      void _r;
      void _g;
      void _l;
      await store.putApp({ ...write, state: "disabled" }, current.revision);
      const next = await store.completeDeployment(fenceOf(claim), { kind: "advance" }, at(5), hook);
      expect(next).toMatchObject({
        state: "failed",
        error: "STALE_GENERATION",
        reason: "APP_CHANGED",
      });
    });

    it("lists overdue deployments without a live lease, scoped by workspace", async () => {
      const { submission } = await seedDeployableApp(store, workspace, T0);
      const { record } = await submit(submission());
      expect(await store.overdueDeployments(at(1000), 10, workspace)).toEqual([]);
      const late = at(DEPLOYMENT_LIMITS.recoveryGraceMs + 5000);
      expect(
        (await store.overdueDeployments(late, 10, workspace)).map((d) => d.deploymentId),
      ).toEqual([record.deploymentId]);
      expect(
        await store.overdueDeployments(late, 10, `ws_${randomBytes(8).toString("hex")}`),
      ).toEqual([]);
      await claimed(record, late);
      expect(
        await store.overdueDeployments(
          at(DEPLOYMENT_LIMITS.recoveryGraceMs + 10_000),
          10,
          workspace,
        ),
      ).toEqual([]);
      expect(await store.transactionStatus("not-a-txid")).toBe("unknown");
    });
  });
}
