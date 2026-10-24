import { createHash } from "node:crypto";
import { compileManifest, definePlugin, defineWorkflow, z, type EmbodyPlugin } from "@embody/core";
import {
  BUILD_RECIPE,
  submissionFingerprint,
  type DeploymentSubmission,
} from "@embody/cloud-contracts";
import { STORAGE_MIGRATIONS } from "@embody/storage";
import {
  BuildAdmission,
  CandidateSweep,
  DeploymentController,
  MemoryAppDatabase,
  MemoryAppIdentityProvider,
  MemoryBuildProvider,
  MemoryCandidateProvider,
  MemoryGatewayStore,
  MemoryHealthProbe,
  MemorySourceObjectStore,
  ReleaseStages,
  appResourceNames,
  provisionAppIdentity,
  deploymentWakeHook,
  type BuildConfig,
  type DeploymentRecord,
  type DeploymentTaskBody,
  type MigrationPolicyEntry,
  type PostgresGatewayStore,
  type ReleasePlatform,
  type SimulatedBuildResult,
} from "../src/index.js";
import {
  APP,
  MemoryTaskQueue,
  TestClock,
  drive,
  pin,
  recipe,
  requestOnly,
} from "./deployment-fixture.js";

export const WS = "ws_release00001";
export const NAME = "kanban";
export const durable = {
  profile: "durable-v1",
  crud: true,
  boundedActions: true,
  workflows: true,
  events: false,
  subscriptions: false,
  schedules: false,
  appToAppRpc: false,
  persistentLocalState: false,
  genui: false,
} as const;
const sha = (bytes: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A request-only plugin; `actions` names its read actions (a different set is a new manifest). */
export function plainPlugin(actions: readonly string[] = ["ping"]): EmbodyPlugin {
  return definePlugin({
    id: "app",
    version: "0.1.0",
    entities: { card: { schema: z.object({ title: z.string() }) } },
    actions: Object.fromEntries(
      actions.map((name) => [
        name,
        { effect: "read" as const, input: z.object({}), handler: () => ({ ok: true }) },
      ]),
    ),
  });
}
/** A durable plugin with workflows `name@version` and the given step names. */
export function workflowPlugin(
  workflows: Readonly<Record<string, { version: string; steps: readonly string[] }>>,
): EmbodyPlugin {
  return definePlugin({
    id: "app",
    version: "0.1.0",
    entities: { card: { schema: z.object({ title: z.string() }) } },
    workflows: Object.fromEntries(
      Object.entries(workflows).map(([name, workflow]) => [
        name,
        defineWorkflow(z.object({}))({
          version: workflow.version,
          resultStep: workflow.steps.at(-1)!,
          steps: Object.fromEntries(
            workflow.steps.map((step) => [step, { handler: () => ({ ok: true }) }]),
          ),
        }),
      ]),
    ),
  });
}

/** A durable plugin subscribing to `events` (the catalog's `eventSubscriptions`). */
export function subscriberPlugin(events: readonly string[]): EmbodyPlugin {
  return definePlugin({
    id: "app",
    version: "0.1.0",
    entities: { card: { schema: z.object({ title: z.string() }) } },
    events: Object.fromEntries(events.map((name) => [name, () => undefined])),
  });
}

/** What the recipe produces for an honest build of `plugins` (as `honestBuild`, any catalog). */
export function catalogBuild(
  config: BuildConfig,
  plugins: readonly EmbodyPlugin[],
  appId = NAME,
): SimulatedBuildResult {
  const prefix = config.artifacts.objects.location.replace(/^gs:\/\/[^/]+\//, "");
  const manifest = Buffer.from(
    JSON.stringify({
      format: "embody-build-output-v1",
      recipe: BUILD_RECIPE.id,
      nodeVersion: "v24.22.0",
      appId,
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
    status: "SUCCESS",
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

export const platform: ReleasePlatform = {
  prefix: "emb",
  gatewayServiceAccount: "embody-gateway@embody-cloud.iam.gserviceaccount.com",
  controllerServiceAccount: "embody-controller@embody-cloud.iam.gserviceaccount.com",
  jwtIssuer: "https://gateway.example.com",
  jwksUrl: "https://gateway.example.com/.well-known/jwks.json",
  cloudSqlConnection: "embody-cloud:us-central1:embody",
  projectNumber: "123456789012",
  region: "us-central1",
  wakeBaseUrl: "https://embody-worker-123456789012.us-central1.run.app",
};
export const storagePolicy: readonly MigrationPolicyEntry[] = STORAGE_MIGRATIONS.map((m) => ({
  version: m.version,
  compatibility: m.compatibility,
  ...(m.readerFloor !== undefined ? { readerFloor: m.readerFloor } : {}),
}));

/**
 * The M12 controller with the real M13 release stages over memory providers, on a memory store
 * with a *reserved* app (name only, no registration). `h.plugins` is the catalog the next build
 * produces; `h.deploy(...)` uploads a fresh source and submits.
 */
export async function releaseHarness(
  options: {
    policy?: readonly MigrationPolicyEntry[];
    /** Defaults to a memory store; the PostgreSQL suite passes a real one. */
    store?: MemoryGatewayStore | PostgresGatewayStore;
    workspaceId?: string;
  } = {},
) {
  const clock = new TestClock();
  const store = options.store ?? new MemoryGatewayStore();
  const ws = options.workspaceId ?? WS;
  const objects = new MemorySourceObjectStore({ clock });
  const state: { plugins: readonly EmbodyPlugin[]; appId: string } = {
    plugins: [plainPlugin()],
    appId: NAME,
  };
  const perBuild = new Map<string, { plugins: readonly EmbodyPlugin[]; appId: string }>();
  const provider = new MemoryBuildProvider((config) => {
    const id = config.tags[1]!;
    if (!perBuild.has(id)) perBuild.set(id, { plugins: state.plugins, appId: state.appId });
    const build = perBuild.get(id)!;
    return catalogBuild(config, build.plugins, build.appId);
  }, clock);
  const submitted: string[] = [];
  const realSubmit = provider.submit.bind(provider);
  provider.submit = async (config) => {
    const result = await realSubmit(config);
    submitted.push(result.buildId);
    return result;
  };
  const finished = new Set<string>();
  const completeBuilds = () => {
    for (const id of submitted)
      if (!finished.has(id)) {
        provider.complete(id);
        finished.add(id);
      }
  };
  const builder = new BuildAdmission({ store, provider, recipe, sources: objects, clock });
  const candidates = new MemoryCandidateProvider(platform.projectNumber, platform.region);
  const identities = new MemoryAppIdentityProvider();
  const policy = options.policy ?? storagePolicy;
  const database = new MemoryAppDatabase(policy);
  const health = new MemoryHealthProbe();
  const stages = new ReleaseStages({
    platform,
    candidates,
    identities,
    database,
    health,
    outputs: provider,
    store,
    migrations: policy,
  });
  const sweep = new CandidateSweep({ prefix: platform.prefix, candidates, store });
  const queue = new MemoryTaskQueue<DeploymentTaskBody>();
  const controller = new DeploymentController({
    store,
    queue,
    builds: builder,
    stages,
    sweeper: sweep,
    clock,
  });
  await store.createWorkspace(ws);
  await store.putApp(
    {
      workspaceId: ws,
      appId: APP,
      name: NAME,
      registration: null,
      activeRelease: null,
      state: "unavailable",
    },
    null,
  );
  // App provisioning (a trusted admin step at reservation): identities, secret, queue, grants.
  await provisionAppIdentity(identities, appResourceNames(platform.prefix, ws, APP), {
    workspaceId: ws,
    appId: APP,
    durable: true,
    controllerEmail: platform.controllerServiceAccount,
    signal: new AbortController().signal,
  });
  const wake = deploymentWakeHook(queue);
  let sources = 0;
  /** A fresh verified source of `bytes`, then a submission at the app's current generation. */
  const submission = async (
    overrides: Partial<DeploymentSubmission> = {},
    bytes = 100,
  ): Promise<DeploymentSubmission> => {
    sources += 1;
    const key = `source_key_${String(sources).padStart(8, "0")}`;
    const digest = pin(`source-${key}`);
    const { record } = await store.admitSource({
      workspaceId: ws,
      appId: APP,
      idempotencyKey: key,
      digest,
      bytes,
      actorId: "alice",
      now: clock.now(),
    });
    const verified = await store.updateSource(
      { ...record, state: "verified", verifiedAt: clock.now().toISOString() },
      record.revision,
    );
    const app = await store.appStatus(ws, APP);
    return {
      version: 1,
      workspaceId: ws,
      appId: APP,
      idempotencyKey: `deploy_key_${String(sources).padStart(8, "0")}`,
      source: { uploadId: verified.uploadId, digest, bytes },
      expectedGeneration: app!.generation,
      capabilities: requestOnly,
      secretReferences: [],
      ...overrides,
    } as unknown as DeploymentSubmission;
  };
  const submit = async (value: DeploymentSubmission) =>
    (
      await store.submitDeployment(
        {
          submission: value,
          fingerprint: submissionFingerprint(value),
          actorId: "alice",
          now: clock.now(),
        },
        wake,
      )
    ).record;
  const run = (opts: Parameters<typeof drive>[3] = {}) =>
    drive(controller, queue, clock, { before: completeBuilds, ...opts });
  const reload = (record: DeploymentRecord) =>
    store.deployment(record.workspaceId, record.appId, record.deploymentId);
  /** Builds `plugins`, deploys and drives the queue until idle; returns the final record. */
  const deploy = async (
    plugins: readonly EmbodyPlugin[],
    overrides: Partial<DeploymentSubmission> = {},
    bytes = 100,
  ) => {
    state.plugins = plugins;
    const record = await submit(await submission(overrides, bytes));
    await run();
    return (await reload(record))!;
  };
  const catalog = async () => (await store.snapshot(ws))!.apps.find((app) => app.appId === APP)!;
  const names = appResourceNames(platform.prefix, ws, APP);
  return {
    clock,
    store,
    objects,
    provider,
    builder,
    candidates,
    identities,
    database,
    health,
    stages,
    sweep,
    queue,
    controller,
    state,
    wake,
    submission,
    submit,
    run,
    reload,
    deploy,
    catalog,
    names,
    completeBuilds,
    workspaceId: ws,
  };
}
export { APP };
