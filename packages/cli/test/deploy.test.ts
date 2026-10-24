import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_RECIPE } from "@embody/cloud-contracts";
import { compileManifest, definePlugin, z } from "@embody/core";
import { MemoryTaskQueue } from "@embody/host";
import {
  BuildAdmission,
  DeploymentController,
  MemoryBuildProvider,
  MemoryGatewayStore,
  MemorySourceObjectStore,
  createWorkspaceGateway,
  hostedSigningIdentity,
  newCredential,
  type BuildConfig,
  type DeploymentStages,
  type DeploymentTaskBody,
  type SimulatedBuildResult,
} from "@embody/gateway";
import { EXIT, hostedCapabilities, resolveTarget, runCli } from "../src/index.js";

// M14: the CLI deploy/control journey against the real workspace gateway routes (M10 sources,
// M12 deployments) and the real controller and build admission on a memory store. The packed
// binary against real builds and candidates is `pnpm test:m14`.

const CANARY = "EMBODY_M14_SOURCE_SECRET_5ca1ab1e";
const APP = "app_cards000001";
const NAME = "cards";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sha = (bytes: string | Uint8Array) =>
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
const plugins = [
  definePlugin({
    id: "app",
    version: "0.1.0",
    entities: { card: { schema: z.object({ title: z.string() }) } },
    actions: { ping: { effect: "read", input: z.object({}), handler: () => ({ ok: true }) } },
  }),
];
/** What the recipe produces for an honest request-only build (as the M12 fixture). */
function build(config: BuildConfig, status: SimulatedBuildResult["status"]): SimulatedBuildResult {
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
    log: `Step #1: building ${CANARY}\n`,
  };
}

async function project(hosted: unknown = { profile: "request-only-v1" }, title = "v1") {
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

function capture() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  return { io: { stdin: new PassThrough(), stdout, stderr }, text: () => ({ out, err }) };
}

class Clock {
  public current = new Date("2030-01-01T00:00:00.000Z");
  public now = () => this.current;
}

/** Gateway, controller and build provider; `pump()` runs due controller tasks like a queue. */
async function topology() {
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
      registration: {
        protocolVersion: 1,
        appId: NAME,
        version: "0.1.0",
        endpoint: "https://cards.example.com",
        healthCheckUrl: "https://cards.example.com/health",
        manifest: compileManifest(plugins),
      },
    } as never,
    null,
  );
  const credential = async (role: "deployer" | "app-caller") => {
    const issued = newCredential({
      workspaceId: workspace,
      principal: {
        orgId: workspace,
        actorId: "alice",
        actorType: "human",
        roles: [],
        scopes: role === "app-caller" ? [`${NAME}:*`] : [],
      },
      grants: [{ workspaceId: workspace, appId: APP, role }],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const record = await store.putCredential(issued.credential, null);
    return { token: issued.token, record };
  };
  const deployer = await credential("deployer");
  const caller = await credential("app-caller");
  const objects = new MemorySourceObjectStore({ clock });
  let buildStatus: SimulatedBuildResult["status"] = "SUCCESS";
  const provider = new MemoryBuildProvider((config) => build(config, buildStatus), clock);
  const submitted: string[] = [];
  const realSubmit = provider.submit.bind(provider);
  provider.submit = async (config) => {
    const result = await realSubmit(config);
    submitted.push(result.buildId);
    return result;
  };
  const finished = new Set<string>();
  let holdBuilds = false;
  const stages: DeploymentStages = {
    provision: () => Promise.resolve({ ok: true }),
    check: () => Promise.resolve({ ok: true }),
  };
  const queue = new MemoryTaskQueue<DeploymentTaskBody>();
  const controller = new DeploymentController({
    store,
    queue,
    builds: new BuildAdmission({ store, provider, recipe, sources: objects, clock }),
    stages,
    clock,
  });
  const gateway = createWorkspaceGateway({
    store,
    token: signing,
    clock,
    sources: { objects },
    deployments: { queue },
  });
  const base = await gateway.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => gateway.close());
  const cache = await mkdtemp(join(tmpdir(), "embody-cli-m14-cache-"));
  cleanups.push(() => rm(cache, { recursive: true, force: true }));
  const requests: string[] = [];
  let hang: ((url: string) => boolean) | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    let request = new Request(input, init);
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
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
    return fetch(request);
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
  const run = async (
    args: string[],
    options: {
      token?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
      now?: () => number;
    } = {},
  ) => {
    const out = capture();
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
    for (const secret of [deployer.token, caller.token, CANARY]) {
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
    requests,
    run,
    step,
    drain,
    setBuild: (status: SimulatedBuildResult["status"]) => (buildStatus = status),
    holdBuilds: (value: boolean) => (holdBuilds = value),
    hang: (match: ((url: string) => boolean) | undefined) => (hang = match),
  };
}

describe("M14.a deploy, reconnect and status", () => {
  it("deploys by app name, prints the deployment ID at once and ends active with stable JSON", async () => {
    const t = await topology();
    const dir = await project();
    const result = await t.run(["deploy", dir, "--app", NAME, "--output", "json"]);
    expect(result.code).toBe(0);
    const status = JSON.parse(result.out) as { deploymentId: string; releaseId: string };
    expect(status).toMatchObject({
      version: 1,
      workspaceId: t.workspace,
      appId: APP,
      state: "active",
    });
    expect(status.releaseId).toMatch(/^rel_/);
    expect(result.err).toContain(`Submitted deployment ${status.deploymentId}`);
    expect(result.err).toContain(`embody deployments status ${status.deploymentId}`);
    // The source secret (.env) was never uploaded.
    const [key] = t.objects.keys();
    const info = await t.objects.stat(key!);
    const archive = gunzipSync(
      await t.objects.read(key!, { generation: info!.generation, maxBytes: 1 << 20 }),
    );
    expect(archive.includes(Buffer.from(CANARY))).toBe(false);
    expect(archive.includes(Buffer.from("embody.config.ts"))).toBe(true);
    // Every platform call went through the gateway's management API or the signed upload.
    expect(
      t.requests.every((r) => r.includes(`/v1/workspaces/${t.workspace}/`) || r.startsWith("PUT")),
    ).toBe(true);
  });

  it("--no-wait returns the ID; a new process polls it by ID; rerunning deploy resumes it", async () => {
    const t = await topology();
    const dir = await project();
    const submitted = await t.run(["deploy", dir, "--app", NAME, "--no-wait", "--output", "json"]);
    expect(submitted.code).toBe(0);
    const first = JSON.parse(submitted.out) as { deploymentId: string; state: string };
    expect(first.state).toBe("accepted");
    // Lost connection: the same command replays the same deployment instead of building again.
    const again = await t.run(["deploy", dir, "--app", NAME, "--no-wait", "--output", "json"]);
    expect(JSON.parse(again.out)).toMatchObject({ deploymentId: first.deploymentId });
    expect(again.err).toContain("Resuming existing deployment");
    const read = await t.run(["deployments", "status", first.deploymentId, "--app", APP]);
    expect(read.code).toBe(0);
    expect(read.out).toMatch(new RegExp(`^${first.deploymentId} (accepted|validating)`));
    const waited = await t.run([
      "deployments",
      "status",
      first.deploymentId,
      "--app",
      NAME,
      "--wait",
      "--output",
      "json",
    ]);
    expect(waited.code).toBe(0);
    expect(JSON.parse(waited.out)).toMatchObject({ state: "active" });
  });

  it("Ctrl-C stops local waiting only: exit 130, nothing cancelled, the deployment finishes", async () => {
    const t = await topology();
    const dir = await project();
    t.holdBuilds(true);
    const controller = new AbortController();
    const result = await t.run(["deploy", dir, "--app", NAME, "--output", "json"], {
      signal: controller.signal,
      sleep: async () => {
        await t.step();
        controller.abort();
      },
    });
    expect(result.code).toBe(EXIT.interrupted);
    expect(result.err).toContain("NOT cancelled and continues on the server");
    const last = JSON.parse(result.out) as {
      deploymentId: string;
      state: string;
      cancellationFence: number;
    };
    expect(["accepted", "validating", "building"]).toContain(last.state);
    const record = await t.store.deployment(t.workspace, APP, last.deploymentId);
    expect(record?.state).not.toBe("cancelled");
    expect(record?.cancellationFence).toBe(last.cancellationFence);
    t.holdBuilds(false);
    await t.drain();
    expect((await t.store.deployment(t.workspace, APP, last.deploymentId))?.state).toBe("active");
  });

  it("waits 30 minutes by default, then exits 10 with the deployment still running", async () => {
    const t = await topology();
    t.holdBuilds(true);
    let clock = 0;
    let polls = 0;
    const result = await t.run(["deploy", await project(), "--app", NAME, "--output", "json"], {
      now: () => clock,
      sleep: async (ms) => {
        polls += 1;
        clock += ms + 10 * 60_000;
        await t.step();
      },
    });
    expect(result.code).toBe(EXIT.waitTimeout);
    expect(polls).toBe(3);
    expect(clock).toBeGreaterThanOrEqual(30 * 60_000);
    expect(result.err).toContain("continues on the server");
    expect((JSON.parse(result.out) as { state: string }).state).not.toBe("active");
  });

  it("explicit cancel is server-side and fenced; repeating it is harmless; active cannot be cancelled", async () => {
    const t = await topology();
    const dir = await project();
    t.holdBuilds(true);
    const submitted = await t.run(["deploy", dir, "--app", NAME, "--no-wait", "--output", "json"]);
    const { deploymentId } = JSON.parse(submitted.out) as { deploymentId: string };
    await t.step();
    const cancelled = await t.run([
      "deployments",
      "cancel",
      deploymentId,
      "--app",
      NAME,
      "--output",
      "json",
    ]);
    expect(cancelled.code).toBe(0);
    const body = JSON.parse(cancelled.out) as { state: string; cancellationFence: number };
    expect(body.state).toBe("cancelled");
    const fence = (await t.store.deployment(t.workspace, APP, deploymentId))!.cancellationFence;
    const repeat = await t.run(["deployments", "cancel", deploymentId, "--app", NAME]);
    expect(repeat.code).toBe(0);
    expect(repeat.out).toContain("already cancelled");
    expect((await t.store.deployment(t.workspace, APP, deploymentId))!.cancellationFence).toBe(
      fence,
    );
    const waited = await t.run(["deployments", "status", deploymentId, "--app", NAME, "--wait"]);
    expect(waited.code).toBe(EXIT.deploymentCancelled);
    t.holdBuilds(false);
    await t.drain();
    // A later deploy of new source goes active; cancelling it now conflicts.
    const next = await project({ profile: "request-only-v1" }, "v2");
    const active = await t.run(["deploy", next, "--app", NAME, "--output", "json"]);
    expect(active.code).toBe(0);
    const activeId = (JSON.parse(active.out) as { deploymentId: string }).deploymentId;
    const late = await t.run(["deployments", "cancel", activeId, "--app", NAME]);
    expect(late.code).toBe(EXIT.remote);
    expect(late.err).toContain("already ended active");
  });
});

describe("M14 rollback", () => {
  // A successful rollback needs M13 release stages (the journey, `pnpm test:m14`); this harness
  // promotes M12-style releases, which the gateway refuses to roll back to, explicitly.
  it("submits through the rollback route and reports an explicit refusal and missing scope", async () => {
    const t = await topology();
    const deploy = async (title: string) => {
      const result = await t.run([
        "deploy",
        await project({ profile: "request-only-v1" }, title),
        "--app",
        NAME,
        "--output",
        "json",
      ]);
      expect(result.code).toBe(0);
      return JSON.parse(result.out) as { releaseId: string };
    };
    const v1 = await deploy("v1");
    await deploy("v2");
    const refused = await t.run(["rollback", NAME, v1.releaseId]);
    expect(refused.code).toBe(EXIT.remote);
    expect(refused.err).toContain(
      "ROLLBACK_INCOMPATIBLE: The rollback target is no longer retained",
    );
    expect(t.requests).toContain(`POST /v1/workspaces/${t.workspace}/apps/${APP}/rollback`);
    const scope = await t.run(["rollback", NAME, v1.releaseId], { token: t.caller.token });
    expect(scope.code).toBe(EXIT.forbidden);
    const usage = await t.run(["rollback", NAME, "v1"]);
    expect(usage.code).toBe(EXIT.usage);
  });
});

describe("M14.b stable exits and actionable errors", () => {
  it("build failure ends failed with exit 8 and a fix-it hint, without leaking build logs", async () => {
    const t = await topology();
    t.setBuild("FAILURE");
    const result = await t.run(["deploy", await project(), "--app", NAME]);
    expect(result.code).toBe(EXIT.deploymentFailed);
    expect(result.out).toMatch(/failed: BUILD_FAILED/);
    expect(result.err).toContain("pnpm install --frozen-lockfile && pnpm build");
  });

  it("malformed source and a missing hosted declaration fail locally before any request", async () => {
    const t = await topology();
    const keyed = await project();
    await rm(join(keyed, "embody.config.ts"));
    const packed = await t.run(["deploy", keyed, "--app", NAME]);
    expect(packed.code).toBe(EXIT.usage);
    expect(packed.err).toContain("Packaging failed: embody.config.ts");
    const undeclared = await t.run(["deploy", await project(null), "--app", NAME]);
    expect(undeclared.code).toBe(EXIT.usage);
    expect(undeclared.err).toContain('"embody": { "hosted"');
    const missing = await t.run(["deploy", join(keyed, "nope"), "--app", NAME]);
    expect(missing.code).toBe(EXIT.usage);
    expect(t.requests).toEqual([]);
  });

  it("missing scope, stale key, unknown app and missing workspace have distinct exits", async () => {
    const t = await topology();
    const dir = await project();
    const scope = await t.run(["deploy", dir, "--app", NAME], { token: t.caller.token });
    expect(scope.code).toBe(EXIT.forbidden);
    expect(scope.err).toContain("deployer credential");
    await t.store.putCredential(
      { ...t.deployer.record, revoked: true },
      t.deployer.record.revision,
    );
    const stale = await t.run(["deploy", dir, "--app", NAME]);
    expect(stale.code).toBe(EXIT.auth);
    expect(stale.err).toContain("Ask your workspace operator for a new key");
    const unknown = await t.run(["apps", "status", "nothere"], { token: t.caller.token });
    expect(unknown.code).toBe(EXIT.notFound);
    const noWorkspace = await t.run(["deployments", "status", "dep_aaaaaaaa", "--app", NAME], {
      env: { EMBODY_GATEWAY_URL: t.base },
    });
    expect(noWorkspace.code).toBe(EXIT.usage);
    expect(noWorkspace.err).toContain("A workspace is required");
  });

  it("cold timeout: a gateway that does not answer gives exit 7 and an unknown-outcome note for writes", async () => {
    const t = await topology();
    t.hang((url) => url.includes("/v1/"));
    const slow = await t.run(["apps", "status", "--request-timeout", "0.2"]);
    expect(slow.code).toBe(EXIT.unavailable);
    expect(slow.err).toContain("did not answer within 0.2 s");
    t.hang(undefined);
    // A dispatchable release first; then the app call never answers.
    expect((await t.run(["deploy", await project(), "--app", NAME])).code).toBe(0);
    t.hang((url) => url.includes("/api/execute/"));
    const write = await t.run(
      ["cards", "card", "create", "--title", "x", "--request-timeout", "0.3"],
      {
        token: t.caller.token,
      },
    );
    expect(write.code).toBe(EXIT.unavailable);
    expect(write.err).toContain("may be starting from zero");
    expect(write.err).toContain("outcome is unknown");
  });
});

describe("M14.c workspace prefixes, MCP setup and redaction", () => {
  it("accepts /w/<ws>, root plus --workspace or EMBODY_WORKSPACE, and a reverse-proxy path", async () => {
    const t = await topology();
    const forms: Array<{ args: string[]; env: Record<string, string> }> = [
      { args: [], env: {} },
      { args: ["--workspace", t.workspace], env: { EMBODY_GATEWAY_URL: t.base } },
      { args: [], env: { EMBODY_GATEWAY_URL: `${t.base}/`, EMBODY_WORKSPACE: t.workspace } },
      { args: [], env: { EMBODY_GATEWAY_URL: `${t.base}/edge/w/${t.workspace}/` } },
    ];
    for (const form of forms) {
      const listed = await t.run(["apps", "status", ...form.args, "--output", "json"], {
        env: form.env,
      });
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.out)).toMatchObject({
        workspaceId: t.workspace,
        apps: [{ appId: APP, name: NAME }],
      });
    }
    expect(resolveTarget("https://gw.example/edge/w/ws_aaaaaaaa")).toEqual({
      root: "https://gw.example/edge",
      workspaceBase: "https://gw.example/edge/w/ws_aaaaaaaa",
      workspaceId: "ws_aaaaaaaa",
    });
    expect(() => resolveTarget("https://gw.example/w/ws_aaaaaaaa", "ws_bbbbbbbb")).toThrow(
      /does not match/,
    );
    expect(() => resolveTarget("https://user:pw@gw.example/w/ws_aaaaaaaa")).toThrow(/credentials/);
  });

  it("mcp setup prints the workspace MCP URL and never the credential; --write keeps it private", async () => {
    const t = await topology();
    const shown = await t.run(["mcp", "setup", "--app", NAME, "--output", "json"]);
    expect(shown.code).toBe(0);
    const body = JSON.parse(shown.out) as { url: string; config: unknown };
    expect(body.url).toBe(`${t.base}/w/${t.workspace}/mcp/${NAME}`);
    expect(JSON.stringify(body.config)).toContain("Bearer <workspace credential>");
    const dir = await mkdtemp(join(tmpdir(), "embody-cli-mcp-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "mcp.json");
    const written = await t.run(["mcp", "setup", "--write", file]);
    expect(written.code).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain(`Bearer ${t.deployer.token}`);
    // Never overwrites: the file holds a credential.
    expect((await t.run(["mcp", "setup", "--write", file])).code).toBe(EXIT.usage);
  });

  it("reads only static declarations: capabilities come from package.json, never project code", async () => {
    const dir = await project({ profile: "durable-v1", workflows: true, subscriptions: true });
    expect(await hostedCapabilities(dir)).toMatchObject({
      profile: "durable-v1",
      workflows: true,
      events: false,
      subscriptions: true,
      schedules: false,
    });
    await expect(
      hostedCapabilities(await project({ profile: "request-only-v1", workflows: true })),
    ).rejects.toThrow(/request-only profile takes no/);
    await expect(hostedCapabilities(await project({ profile: "gpu" }))).rejects.toThrow(
      /Invalid hosted declaration/,
    );
  });
});
