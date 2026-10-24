// Local M14 gate: the PACKED CLI and PACKED scaffolder, installed in a clean consumer directory,
// drive the whole deploy and control journey against the local integration topology
// (infra/mvp/m14/local-topology.mjs): real hosted gateway, controller, build admission and release
// stages on the platform PostgreSQL fixture, builds through the exact platform plan on local
// Docker, candidates as Docker containers on per-app databases. Requires the platform fixture
// (runtime/migration URLs, container), EMBODY_PROVISIONER_URL, Docker, npm 11 and network access
// to registry.npmjs.org. Creates only `embody-m14-*`/`embody-m11-*` containers, recipe-labelled
// images and per-run fixture databases, and removes them. Not cloud evidence.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  command,
  databaseServiceIdentity,
  evidence,
  main,
  platformConfiguration,
  requireVariables,
  root,
  SuiteFailure,
} from "./verification.mjs";
import { DOCKER_CLI, RUNTIME_IMAGE } from "../infra/mvp/builder/local-images.mjs";
import {
  cliRunner,
  createProjects,
  installPackedConsumer,
  mcpClientFactory,
  writeProfiles,
} from "../infra/mvp/m14/consumer.mjs";

const { Buffer, URL } = globalThis;
const CANARY = `EMBODY_M14_SOURCE_SECRET_${randomBytes(8).toString("hex")}`;

function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(
      `docker ${args.slice(0, 2).join(" ")} failed: ${(result.stderr ?? "").slice(-600)}`,
    );
  return result.stdout?.trim() ?? "";
}
function exec(program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(`${program} ${args[0]} failed: ${(result.stderr ?? "").slice(-800)}`);
  return result.stdout.trim();
}

await main("m14-local", async () => {
  platformConfiguration();
  requireVariables(["EMBODY_PROVISIONER_URL"]);
  if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0)
    throw new Error("test:m14 requires Docker");
  const npmMajor = Number(exec("npm", ["--version"]).split(".")[0]);
  if (npmMajor !== 11) throw new Error("test:m14 requires npm 11 (as the packed baseline)");
  const image = databaseServiceIdentity();
  const run = randomBytes(3).toString("hex");
  const scratch = await mkdtemp(join(process.env.EMBODY_M14_SCRATCH ?? tmpdir(), "embody-m14-"));
  const started = Date.now();
  let topology;
  let registry;
  let objectServer;
  let objectPlainServer;
  let builderTag;
  const cleanup = {};
  try {
    command("pnpm", ["build"]);
    command(process.execPath, ["scripts/prepare-platform.mjs"]);
    const [gateway, host, storage, { stageRecipe }, { startFrameworkRegistry }] = await Promise.all(
      [
        import("../packages/gateway/dist/index.js"),
        import("../packages/host/dist/index.js"),
        import("../packages/storage/dist/index.js"),
        import("../infra/mvp/builder/stage.mjs"),
        import("../infra/mvp/builder/registry.mjs"),
      ],
    );
    const [{ LocalBuildProvider }, { startLocalTopology }, { runM14Journey, M14_CASES }] =
      await Promise.all([
        import("../infra/mvp/m11/local-provider.mjs"),
        import("../infra/mvp/m14/local-topology.mjs"),
        import("../infra/mvp/m14/journey.mjs"),
      ]);

    // Recipe image and the framework registry (the "published" @embody packages).
    const context = join(scratch, "recipe");
    const framework = await stageRecipe(context);
    builderTag = `embody-m11-builder:m14-${run}`;
    docker(["build", "-q", "-t", builderTag, context], { stdio: ["ignore", "pipe", "inherit"] });
    const imageId = docker(["image", "inspect", "--format", "{{.Id}}", builderTag]);
    const builderRef = `us-central1-docker.pkg.dev/embody-m14-local/recipe/builder@${imageId}`;
    const recipe = {
      project: "embody-m14-local",
      region: "us-central1",
      builderServiceAccount: "embody-m14-builder@embody-m14-local.iam.gserviceaccount.com",
      builderImage: builderRef,
      dockerImage: DOCKER_CLI,
      runtimeImage: RUNTIME_IMAGE,
      imageRepository: "us-central1-docker.pkg.dev/embody-m14-local/builds",
      outputBucket: "embody-m14-local-outputs",
      logsBucket: "embody-m14-local-logs",
    };
    registry = await startFrameworkRegistry(join(context, "framework"), framework);

    // A clean consumer: the packed CLI and scaffolder installed from their tarballs, as a user
    // would from the registry. Nothing below imports the workspace's own CLI.
    const { cliBin, createBin } = await installPackedConsumer({
      dir: join(scratch, "consumer"),
      framework,
      frameworkDir: join(context, "framework"),
      root,
      packDir: context,
    });

    // Source objects behind host endpoints (the signed-URL stand-in): HTTPS on loopback for the
    // CLI (build plans accept only https source URLs) with a throwaway self-signed certificate
    // trusted only by the CLI processes, and plain HTTP for the build containers (as test:m11).
    const tls = join(scratch, "tls");
    await mkdir(tls, { recursive: true });
    exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-keyout",
      join(tls, "key.pem"),
      "-out",
      join(tls, "cert.pem"),
    ]);
    let objects;
    const serveObjects = (request, response) => {
      void (async () => {
        let body = Buffer.alloc(0);
        for await (const chunk of request) body = Buffer.concat([body, chunk]);
        const reply = await objects.fetch(new URL(request.url, objects.origin).href, {
          method: request.method,
          headers: request.headers,
          ...(body.length ? { body } : {}),
        });
        response.writeHead(reply.status).end(Buffer.from(await reply.arrayBuffer()));
      })();
    };
    const linux = process.platform === "linux";
    objectServer = createHttpsServer(
      {
        key: await readFile(join(tls, "key.pem")),
        cert: await readFile(join(tls, "cert.pem")),
      },
      serveObjects,
    );
    await new Promise((resolve) => objectServer.listen(0, "127.0.0.1", resolve));
    objectPlainServer = createServer(serveObjects);
    await new Promise((resolve) =>
      objectPlainServer.listen(0, linux ? "0.0.0.0" : "127.0.0.1", resolve),
    );
    const objectPort = objectPlainServer.address().port;
    objects = new gateway.MemorySourceObjectStore({
      origin: `https://127.0.0.1:${objectServer.address().port}`,
    });
    const builds = new LocalBuildProvider({
      scratch: join(scratch, "builds"),
      outputBucket: recipe.outputBucket,
      dockerImage: DOCKER_CLI,
      rewriteSourceUrl: (url) =>
        url.replace(objects.origin, `http://host.docker.internal:${objectPort}`),
      imageAliases: { [builderRef]: builderTag },
      TooLarge: gateway.BuildOutputTooLargeError,
      cleanupImage: RUNTIME_IMAGE,
    });
    const provisioner = new URL(process.env.EMBODY_PROVISIONER_URL);
    const gatewayRequire = createRequire(join(root, "packages/gateway/package.json"));
    topology = await startLocalTopology({
      gateway,
      host,
      storage,
      recipe,
      builds,
      objects,
      platformUrl: process.env.EMBODY_PLATFORM_URL,
      provisionerUrl: process.env.EMBODY_PROVISIONER_URL,
      runtimeHost: `${linux ? "127.0.0.1" : "host.docker.internal"}:${provisioner.port || 5432}`,
      hostAlias: linux ? "127.0.0.1" : "host.docker.internal",
      network: linux ? "host" : "bridge",
      run,
      preload: join(root, "infra/mvp/m14/emulator-preload.mjs"),
      pgModule: pathToFileURL(gatewayRequire.resolve("pg")).href,
    });

    // --- Operator provisioning (the only operator step; the journey below is CLI-only). ---
    const workspace = `ws_m14l${run}`;
    const appIds = { cards: `app_m14cards${run}`, flow: `app_m14flow${run}` };
    const names = { cards: "m14-cards", flow: "m14-flow" };
    await topology.operator.workspace(workspace);
    await topology.operator.reserveApp(workspace, appIds.cards, names.cards, false);
    const flowNames = await topology.operator.reserveApp(workspace, appIds.flow, names.flow, true);
    cleanup.workspace = workspace;
    cleanup.apps = Object.values(appIds);
    const both = (role) => Object.values(appIds).map((appId) => ({ appId, role }));
    const deployer = await topology.operator.credential(workspace, "m14-user", both("deployer"));
    const caller = await topology.operator.credential(workspace, "m14-user", both("app-caller"), [
      // Gateway catalog scopes are per namespace; the app's kernel checks plugin scopes (`app`).
      `${names.cards}:*`,
      `${names.flow}:*`,
      "app:*",
    ]);
    const stale = await topology.operator.credential(workspace, "m14-user", both("deployer"));
    await stale.revoke();

    // The user's protected profiles (mode 0600), as the CLI requires for stored tokens.
    const home = join(scratch, "home");
    const configFile = await writeProfiles(home, {
      deployer: { baseUrl: `${topology.root}/w/${workspace}`, token: deployer.token },
      caller: { baseUrl: topology.root, workspace, token: caller.token },
      edge: { baseUrl: `${topology.edge}/w/${workspace}`, token: caller.token },
      stale: { baseUrl: `${topology.root}/w/${workspace}/`, token: stale.token },
    });

    // --- The user's projects: generated by the packed scaffolder, locked against the registry.
    const projects = await createProjects({
      dir: join(scratch, "projects"),
      createBin,
      registryUrl: registry.url,
      names,
      canary: CANARY,
    });

    // --- The packed CLI as a separate process with a clean environment per call.
    const cli = cliRunner({
      cliBin,
      cwd: scratch,
      home,
      configFile,
      cache: join(scratch, "cache"),
      // Trusts only the run's throwaway object-store certificate (loopback HTTPS).
      env: { NODE_EXTRA_CA_CERTS: join(tls, "cert.pem") },
    });
    const scan = async () => {
      const parts = [...topology.auditLines, ...topology.workerLines];
      for (const candidate of await topology.candidates.list())
        parts.push(topology.candidates.logs(candidate.name));
      for (const build of builds.builds.values()) parts.push(build.log);
      for (const key of objects.keys()) {
        const info = await objects.stat(key);
        parts.push(
          gunzipSync(
            await objects.read(key, { generation: info.generation, maxBytes: 64 << 20 }),
          ).toString("latin1"),
        );
      }
      return parts.join("\n");
    };
    const pauseTarget = {};
    const journey = await runM14Journey({
      cli,
      names,
      appIds,
      workspace,
      root: topology.root,
      scratch,
      projects,
      profiles: { deployer: "deployer", caller: "caller", edge: "edge", stale: "stale" },
      pause: async (appId) => {
        pauseTarget[appId] = await topology.activeCandidate(workspace, appId);
        topology.candidates.pause(pauseTarget[appId]);
      },
      resume: async (appId) => topology.candidates.unpause(pauseTarget[appId]),
      tasks: async () =>
        topology.tasks.filter((task) =>
          task.queue.endsWith(`/queues/${flowNames.wakeQueue}/tasks`),
        ),
      mcpClient: mcpClientFactory(gatewayRequire),
      secrets: [deployer.token, caller.token, stale.token, CANARY],
      scan,
    });

    const outcomes = M14_CASES.map((id) => journey.cases[id] ?? { pass: false, error: "not run" });
    const counts = {
      passed: outcomes.filter((c) => c.pass).length,
      failed: outcomes.filter((c) => !c.pass).length,
      skipped: 0,
    };
    const details = {
      providerEvidence: false,
      topology:
        "local: hosted gateway + M12 controller + M11 build admission + M13 release stages on platform PostgreSQL; builds via the M11 Docker emulator; candidates as Docker containers; Cloud Tasks recorded, not delivered",
      packedCli: "@embody/cli and create-embody-app installed from tarballs in a clean consumer",
      builds: builds.builds.size,
      candidatesCreated: topology.candidates.created,
      controllerTasks: topology.delivered(),
      durationSeconds: Math.round((Date.now() - started) / 1000),
      cases: journey.cases,
    };
    if (!journey.pass) {
      await evidence("m14-local", "failed", counts, [image], details);
      console.error(
        JSON.stringify(
          Object.fromEntries(Object.entries(journey.cases).filter(([, c]) => !c.pass)),
          null,
          2,
        ),
      );
      if (process.env.EMBODY_M14_DEBUG) console.error(topology.workerLines.slice(-40).join("\n"));
      throw new SuiteFailure("M14 local journey failed", counts);
    }
    await evidence("m14-local", "passed", counts, [image], details);
    console.log(
      `M14 local: ${counts.passed}/${M14_CASES.length} journey cases passed, ${details.builds} builds in ${details.durationSeconds}s`,
    );
  } finally {
    const removed = topology?.candidates.cleanup() ?? 0;
    await topology?.close().catch(() => undefined);
    if (cleanup.workspace && topology)
      await topology
        .dropAppDatabases(cleanup.workspace, cleanup.apps)
        .catch((error) => console.error(`App database cleanup failed: ${error.message}`));
    objectServer?.close();
    objectPlainServer?.close();
    await registry?.close();
    const leftovers = [
      docker(["ps", "-aq", "--filter", "name=embody-m11-step-"], { allowFailure: true }),
      docker(["ps", "-aq", "--filter", "name=embody-sandbox-art_"], { allowFailure: true }),
    ]
      .filter(Boolean)
      .join("\n");
    if (leftovers) docker(["rm", "-f", ...leftovers.split("\n")], { allowFailure: true });
    // Only this run's app images (labelled with its workspace), never other runs' images.
    const images = cleanup.workspace
      ? docker(["images", "-q", "--filter", `label=org.embody.workspace=${cleanup.workspace}`], {
          allowFailure: true,
        })
      : "";
    if (images) docker(["rmi", "-f", ...new Set(images.split("\n"))], { allowFailure: true });
    if (builderTag) docker(["rmi", "-f", builderTag], { allowFailure: true });
    if (!process.env.EMBODY_M14_KEEP_SCRATCH)
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    console.log(`M14 local cleanup: ${removed} candidate container(s) removed`);
  }
});
