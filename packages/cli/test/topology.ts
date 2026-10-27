import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect } from "vitest";
import { BUILD_RECIPE } from "@embody/cloud-contracts";
import { compileManifest, definePlugin, z } from "@embody/core";
import { MemoryTaskQueue } from "@embody/host";
import {
  BuildAdmission,
  DeploymentController,
  MemoryBuildProvider,
  MemoryGatewayStore,
  MemorySourceObjectStore,
  customerSecretName,
  createWorkspaceGateway,
  hostedSigningIdentity,
  newCredential,
  type BuildConfig,
  type DeploymentStages,
  type DeploymentTaskBody,
  type MemorySecretVault,
  type SimulatedBuildResult,
} from "@embody/gateway";
import { runCli } from "../src/index.js";

// M14/M15: the CLI deploy/control journey against the real workspace gateway routes (M10 sources,
// M12 deployments, M15 management) and the real controller and build admission on a memory
// store. The packed binary against real builds and candidates is `pnpm test:m14`/`test:m15`.

export const CANARY = "EMBODY_M14_SOURCE_SECRET_5ca1ab1e";
/** A credential passed on the command line in the wrong form (review B1). */
export const ARG_CANARY = "emb_ARG_CANARY_d0n0tpr1nt";
export const APP = "app_cards000001";
export const NAME = "cards";
export const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export const sha = (bytes: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const pin = (value: string) => sha(value);
const recipe = {
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
export const plugins = [
  definePlugin({
    id: "app",
    version: "0.1.0",
    entities: { card: { schema: z.object({ title: z.string() }) } },
    actions: { ping: { effect: "read", input: z.object({}), handler: () => ({ ok: true }) } },
  }),
];
/** What the recipe produces for an honest request-only build (as the M12 fixture). */
function build(
  config: BuildConfig,
  status: SimulatedBuildResult["status"],
  log = `Step #1: building ${CANARY}\n`,
): SimulatedBuildResult {
  const prefix = config.artifacts.objects.location.replace(/^gs:\/\/[^/]+\//, "");
  const manifest = Buffer.from(
    JSON.stringify({
      format: "embody-build-output-v1",
      recipe: BUILD_RECIPE.id,
      nodeVersion: "v24.22.0",
      appId: NAME,
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
    log,
  };
}

export async function project(hosted: unknown = { profile: "request-only-v1" }, title = "v1") {
  const root = await mkdtemp(join(tmpdir(), "embody-cli-m14-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: NAME,
      type: "module",
      ...(hosted === null ? {} : { embody: { hosted } }),
    }),
    "embody.config.ts": `export default { title: ${JSON.stringify(title)} };\n`,
    "src/index.ts": "export const ok = true;\n",
    ".env": `SECRET=${CANARY}`,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

export function capture() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  return { io: { stdin: new PassThrough(), stdout, stderr }, text: () => ({ out, err }) };
}

export class Clock {
  public current = new Date("2030-01-01T00:00:00.000Z");
  public now = () => this.current;
}

/** The catalog registration of `cards` (M15 stages promote it again). */
export const registration = (endpoint = "https://cards.example.com") => ({
  protocolVersion: 1 as const,
  appId: NAME,
  version: "0.1.0",
  endpoint,
  healthCheckUrl: `${endpoint}/health`,
  manifest: compileManifest(plugins),
});
export interface TopologyOptions {
  /** M15: serve customer secrets from this vault (runtime accessor `rt-<app>@test`). */
  readonly vault?: MemorySecretVault;
  /** Replaces the always-succeeding stages (M15: capture injected secrets, races). */
  readonly stages?: (store: MemoryGatewayStore) => DeploymentStages;
  /** The provider build log (M15 redaction cases). */
  readonly buildLog?: string;
  /** The gateway's fetch to app endpoints (M15: count app contacts). */
  readonly appFetch?: typeof fetch;
}
export const accessor = (appId: string) => `rt-${appId}@test`;
/** Gateway, controller and build provider; `pump()` runs due controller tasks like a queue. */
export async function topology(options: TopologyOptions = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signing = await hostedSigningIdentity({
    issuer: "cli-m14",
    kid: "k1",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES256", use: "sig" }],
  });
  const clock = new Clock();
  const workspace = `ws_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const store = new MemoryGatewayStore();
  await store.createWorkspace(workspace);
  await store.putApp(
    {
      workspaceId: workspace,
      appId: APP,
      activeRelease: null,
      state: "unavailable",
      registration: registration(),
    } as never,
    null,
  );
  const credential = async (
    role: "deployer" | "app-caller" | "operator",
    scope: { workspace?: string; appId?: string; actorId?: string } = {},
  ) => {
    const ws = scope.workspace ?? workspace;
    const issued = newCredential({
      workspaceId: ws,
      principal: {
        orgId: ws,
        actorId: scope.actorId ?? (role === "operator" ? "olivia" : "alice"),
        actorType: "human",
        roles: [],
        scopes: role === "app-caller" ? [`${NAME}:*`] : [],
      },
      grants: [{ workspaceId: ws, appId: scope.appId ?? APP, role }],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const record = await store.putCredential(issued.credential, null);
    return { token: issued.token, record };
  };
  const deployer = await credential("deployer");
  const caller = await credential("app-caller");
  const operator = await credential("operator");
  const objects = new MemorySourceObjectStore({ clock });
  let buildStatus: SimulatedBuildResult["status"] = "SUCCESS";
  const provider = new MemoryBuildProvider(
    (config) => build(config, buildStatus, options.buildLog),
    clock,
  );
  const submitted: string[] = [];
  const realSubmit = provider.submit.bind(provider);
  provider.submit = async (config) => {
    const result = await realSubmit(config);
    submitted.push(result.buildId);
    return result;
  };
  const finished = new Set<string>();
  let holdBuilds = false;
  const stages: DeploymentStages = options.stages?.(store) ?? {
    provision: () => Promise.resolve({ ok: true }),
    check: () => Promise.resolve({ ok: true }),
  };
  const queue = new MemoryTaskQueue<DeploymentTaskBody>();
  const builds = new BuildAdmission({ store, provider, recipe, sources: objects, clock });
  const controller = new DeploymentController({ store, queue, builds, stages, clock });
  const gateway = createWorkspaceGateway({
    store,
    token: signing,
    clock,
    sources: { objects },
    ...(options.appFetch ? { fetch: options.appFetch } : {}),
    deployments: {
      queue,
      ...(options.vault
        ? {
            secrets: {
              vault: options.vault,
              naming: {
                secret: (ws: string, app: string, name: string) =>
                  customerSecretName("emb", ws, app, name),
                accessor: (_ws: string, app: string) => accessor(app),
              },
            },
          }
        : {}),
      buildLogs: {
        read: async (record, attempt) => {
          const artifact = await store.artifactForAttempt(
            record.workspaceId,
            record.appId,
            record.deploymentId,
            attempt,
          );
          return artifact ? { text: await builds.log(artifact), truncated: false } : null;
        },
      },
    },
  });
  const base = await gateway.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => gateway.close());
  const cache = await mkdtemp(join(tmpdir(), "embody-cli-m14-cache-"));
  cleanups.push(() => rm(cache, { recursive: true, force: true }));
  const requests: string[] = [];
  let hang: ((url: string) => boolean) | undefined;
  /** Runs before a request is forwarded (races, interrupts); one hook at a time. */
  let before: ((request: Request) => Promise<void>) | undefined;
  let after: ((request: Request, response: Response) => Promise<Response>) | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    let request = new Request(input, init);
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    await before?.(request);
    if (hang?.(request.url))
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    if (request.url.startsWith(objects.origin)) return objects.fetch(request);
    // A reverse proxy that serves the gateway under /edge.
    const url = new URL(request.url);
    if (url.pathname.startsWith("/edge/")) {
      url.pathname = url.pathname.slice("/edge".length);
      request = new Request(url, request);
    }
    const response = await fetch(request);
    return after ? after(request, response) : response;
  };
  /** One due controller task (completing builds first); false when nothing is due or pending. */
  const step = async (): Promise<boolean> => {
    if (!holdBuilds)
      for (const id of submitted)
        if (!finished.has(id)) {
          provider.complete(id);
          finished.add(id);
        }
    const due = queue.due(clock.now());
    if (due.length === 0) {
      const pending = queue.pending();
      if (pending.length === 0) return false;
      const next = Math.min(...pending.map((task) => Date.parse(task.scheduleAt)));
      clock.current = new Date(Math.max(next, clock.now().getTime() + 1000));
      return true;
    }
    const task = due[0]!;
    const result = await controller.handle(task.body);
    if (result.status === 503) clock.current = new Date(clock.now().getTime() + 5000);
    else queue.acknowledge(task.name);
    return true;
  };
  const drain = async () => {
    for (let i = 0; i < 500 && (await step()); i += 1);
  };
  /** Values no CLI output may ever contain (credentials, source and M15 secret canaries). */
  const forbidden = new Set<string>();
  const run = async (
    args: string[],
    options: {
      token?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
      now?: () => number;
      /** Written to the CLI's stdin (a pipe), e.g. a secret value. */
      stdin?: string;
    } = {},
  ) => {
    const out = capture();
    if (options.stdin !== undefined) out.io.stdin.end(options.stdin);
    const code = await runCli(args, {
      io: out.io,
      fetch: fetcher,
      env: {
        EMBODY_CONFIG: join(tmpdir(), `missing-${randomUUID()}.json`),
        EMBODY_CACHE_DIR: cache,
        EMBODY_GATEWAY_URL: `${base}/w/${workspace}`,
        EMBODY_TOKEN: options.token ?? deployer.token,
        ...options.env,
      },
      ...(options.signal ? { signal: options.signal } : {}),
      // Each poll lets the "queue" deliver a few tasks: the CLI only ever sees HTTP status.
      poll: {
        intervalMs: 1,
        sleep:
          options.sleep ??
          (async () => {
            for (let i = 0; i < 3; i += 1) await step();
          }),
        ...(options.now ? { now: options.now } : {}),
      },
    });
    const text = out.text();
    // M14.c: no credential and no source secret in any CLI output.
    for (const secret of [
      deployer.token,
      caller.token,
      operator.token,
      CANARY,
      ARG_CANARY,
      ...forbidden,
    ]) {
      expect(text.out).not.toContain(secret);
      expect(text.err).not.toContain(secret);
    }
    return { code, ...text };
  };
  return {
    workspace,
    base,
    store,
    objects,
    queue,
    clock,
    deployer,
    caller,
    operator,
    credential,
    controller,
    builds,
    forbid: (value: string) => forbidden.add(value),
    requests,
    run,
    step,
    drain,
    setBuild: (status: SimulatedBuildResult["status"]) => (buildStatus = status),
    holdBuilds: (value: boolean) => (holdBuilds = value),
    hang: (match: ((url: string) => boolean) | undefined) => (hang = match),
    before: (hook: ((request: Request) => Promise<void>) | undefined) => (before = hook),
    after: (hook: ((request: Request, response: Response) => Promise<Response>) | undefined) =>
      (after = hook),
  };
}
