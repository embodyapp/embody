import { createHash } from "node:crypto";
import { compileManifest, definePlugin, z } from "@embody/core";
import { BUILD_RECIPE, type DeploymentSubmission } from "@embody/cloud-contracts";
import { MemoryTaskQueue } from "@embody/host";
import type {
  BuildConfig,
  BuildRecipeConfig,
  DeploymentController,
  DeploymentRecord,
  DeploymentStageContext,
  DeploymentStages,
  DeploymentTaskBody,
  GatewayStore,
  SimulatedBuildResult,
  SourceStore,
  StageResult,
  TaskResult,
} from "../src/index.js";
import { appRecord } from "./store-conformance.js";

export const pin = (n: string) => `sha256:${createHash("sha256").update(n).digest("hex")}`;
const sha = (bytes: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const recipe: BuildRecipeConfig = {
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
const plugins = [
  definePlugin({
    id: "app",
    version: "0.1.0",
    entities: { card: { schema: z.object({ title: z.string() }) } },
    actions: { ping: { effect: "read", input: z.object({}), handler: () => ({ ok: true }) } },
  }),
];
/** What the real recipe produces for an honest request-only build. */
export function honestBuild(
  config: BuildConfig,
  status: SimulatedBuildResult["status"] = "SUCCESS",
): SimulatedBuildResult {
  const prefix = config.artifacts.objects.location.replace(/^gs:\/\/[^/]+\//, "");
  const manifest = Buffer.from(
    JSON.stringify({
      format: "embody-build-output-v1",
      recipe: BUILD_RECIPE.id,
      nodeVersion: "v24.22.0",
      appId: "my-app",
      appVersion: "0.1.0",
      preflight: { requestOnly: true, durable: true },
      publishes: [],
      catalog: compileManifest(plugins),
    }),
  );
  const sbom = Buffer.from('{"bomFormat":"CycloneDX"}\n');
  const source = config.steps[0]!.env.find((e) => e.startsWith("EMBODY_SOURCE_DIGEST="))!.split(
    "=",
  )[1];
  return {
    status,
    outputs: { [`${prefix}manifest.json`]: manifest, [`${prefix}sbom.json`]: sbom },
    stepOutputs: [
      JSON.stringify({
        recipe: BUILD_RECIPE.id,
        sourceDigest: source,
        treeDigest: pin("tree"),
        lockfileDigest: pin("lock"),
        sbomDigest: sha(sbom),
        packages: 200,
        audit: { critical: 0, high: 0, moderate: 0, low: 0 },
      }),
      "",
      JSON.stringify({ manifestDigest: sha(manifest), outputBytes: 1234 }),
    ],
    images: [{ name: config.images[0]!, digest: pin(`image-${config.images[0]}`) }],
    log: "Step #1: building\n",
  };
}
export const requestOnly = {
  profile: "request-only-v1",
  crud: true,
  boundedActions: true,
  workflows: false,
  schedules: false,
  subscriptions: false,
  appToAppRpc: false,
  persistentLocalState: false,
  genui: false,
} as const;
export const APP = "app_kanban0001";

/** Workspace, catalog app and one verified source; returns submission builders. */
export async function seedDeployableApp(
  store: GatewayStore & SourceStore,
  workspaceId: string,
  now: Date,
  key = "source_key_0000001",
) {
  await store.createWorkspace(workspaceId).catch(() => undefined);
  const app =
    (await store.snapshot(workspaceId))?.apps.find((a) => a.appId === APP) ??
    (await store.putApp(appRecord(workspaceId), null));
  const digest = pin(`source-${workspaceId}-${key}`);
  const { record } = await store.admitSource({
    workspaceId,
    appId: APP,
    idempotencyKey: key,
    digest,
    bytes: 100,
    actorId: "alice",
    now,
  });
  const verified =
    record.state === "verified"
      ? record
      : await store.updateSource(
          { ...record, state: "verified", verifiedAt: now.toISOString() },
          record.revision,
        );
  const submission = (
    idempotencyKey = "deploy_key_00000001",
    overrides: Partial<DeploymentSubmission> = {},
  ): DeploymentSubmission =>
    ({
      version: 1,
      workspaceId,
      appId: APP,
      idempotencyKey,
      source: { uploadId: verified.uploadId, digest, bytes: 100 },
      expectedGeneration: app.generation,
      capabilities: requestOnly,
      secretReferences: [],
      ...overrides,
    }) as unknown as DeploymentSubmission;
  return { app, source: verified, submission };
}

/**
 * Provisioning/check stages that model M13's contract: a candidate named from platform records
 * and labelled with its owner, created idempotently (a re-run adopts it), checked, and removed on
 * abandon only when its labels match.
 */
export class FakeStages implements DeploymentStages {
  public readonly resources = new Map<string, Record<string, string>>();
  public created = 0;
  public checks = 0;
  public removed: string[] = [];
  public checkResult: StageResult = { ok: true };
  public provisionResult: StageResult = { ok: true };
  public static nameOf(deployment: DeploymentRecord): string {
    return `cand-${deployment.workspaceId}-${deployment.deploymentId}`;
  }
  public provision(context: DeploymentStageContext): Promise<StageResult> {
    if (!this.provisionResult.ok) return Promise.resolve(this.provisionResult);
    const name = FakeStages.nameOf(context.deployment);
    if (!this.resources.has(name)) {
      this.resources.set(name, {
        workspace: context.deployment.workspaceId,
        app: context.deployment.appId,
        deployment: context.deployment.deploymentId,
        image: context.artifact.imageReference!,
      });
      this.created += 1;
    }
    return Promise.resolve({ ok: true });
  }
  public check(context: DeploymentStageContext): Promise<StageResult> {
    this.checks += 1;
    const labels = this.resources.get(FakeStages.nameOf(context.deployment));
    if (!labels || labels["image"] !== context.artifact.imageReference)
      return Promise.resolve({ ok: false, retryable: false, reason: "CANDIDATE_MISSING" });
    return Promise.resolve(this.checkResult);
  }
  public abandon(deployment: DeploymentRecord): Promise<void> {
    const name = FakeStages.nameOf(deployment);
    const labels = this.resources.get(name);
    // Ownership check: never remove a resource another deployment or workspace owns.
    if (
      labels &&
      labels["workspace"] === deployment.workspaceId &&
      labels["deployment"] === deployment.deploymentId
    ) {
      this.resources.delete(name);
      this.removed.push(name);
    }
    return Promise.resolve();
  }
}

export class TestClock {
  public constructor(public current = new Date("2030-01-01T00:00:00.000Z")) {}
  public now = () => this.current;
  public advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/**
 * Delivers due tasks the way Cloud Tasks does: a 2xx or 4xx answer acknowledges (a 4xx is a
 * platform bug the real queue would keep retrying, without effect), a 503 leaves the task for a
 * later delivery. When nothing is due it jumps the clock to the next task. Stops when the queue
 * is empty or `rounds` are used.
 */
export async function drive(
  controller: Pick<DeploymentController, "handle">,
  queue: MemoryTaskQueue<DeploymentTaskBody>,
  clock: TestClock,
  options: { rounds?: number; before?: () => void | Promise<void> } = {},
): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  for (let round = 0; round < (options.rounds ?? 500); round++) {
    await options.before?.();
    const due = queue.due(clock.now());
    if (due.length === 0) {
      const pending = queue.pending();
      if (pending.length === 0) return results;
      const next = Math.min(...pending.map((task) => Date.parse(task.scheduleAt)));
      clock.current = new Date(Math.max(next, clock.now().getTime() + 1000));
      continue;
    }
    const task = due[0]!;
    const result = await controller.handle(task.body);
    results.push(result);
    if (result.status === 503) clock.advance(5000);
    else queue.acknowledge(task.name);
  }
  return results;
}
export { MemoryTaskQueue };
