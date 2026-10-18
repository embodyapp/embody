// Local M11 gate: builds the recipe image from this checkout and runs the exact platform build
// plan on local Docker through the Cloud Build emulator, with clean scaffolds and adversaries.
// Requires Docker and network access to registry.npmjs.org (the trusted fetch step). Creates
// only uniquely named local containers/images (prefix embody-m11-) and removes them. Not cloud
// evidence: IAM, metadata-server and registry behaviour are qualified by the live suite.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidence, main, SuiteFailure } from "./verification.mjs";

const { Buffer, URL } = globalThis;
const RUNTIME_IMAGE =
  "docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5";
const DOCKER_CLI =
  "docker.io/library/docker:29-cli@sha256:6fae2214c3121a28d5aa639d09032f61310b7c9c75ffbad1025f261a1b621800";

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

await main("m11-local", async () => {
  if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0)
    throw new Error("test:m11 requires Docker");
  const run = randomBytes(3).toString("hex");
  const scratch = await mkdtemp(join(process.env.EMBODY_M11_SCRATCH ?? tmpdir(), "embody-m11-"));
  let server;
  let frameworkRegistry;
  let builderRef;
  try {
    const [
      gateway,
      contracts,
      scaffold,
      { stageRecipe },
      { startFrameworkRegistry },
      { LocalBuildProvider },
      { runM11Cases },
    ] = await Promise.all([
      import("../packages/gateway/dist/index.js"),
      import("../packages/cloud-contracts/dist/index.js"),
      import("../packages/create-embody-app/dist/index.js"),
      import("../infra/mvp/builder/stage.mjs"),
      import("../infra/mvp/builder/registry.mjs"),
      import("../infra/mvp/m11/local-provider.mjs"),
      import("../infra/mvp/m11/suite.mjs"),
    ]);

    // Recipe image. Plans must name digest-pinned images; locally the emulator maps the pinned
    // name to the image built here (Cloud Build pulls it from the platform registry).
    const context = join(scratch, "recipe");
    const framework = await stageRecipe(context);
    const tag = `embody-m11-builder:${run}`;
    docker(["build", "-q", "-t", tag, context], { stdio: ["ignore", "pipe", "inherit"] });
    const imageId = docker(["image", "inspect", "--format", "{{.Id}}", tag]);
    builderRef = `us-central1-docker.pkg.dev/embody-m11-local/recipe/builder@${imageId}`;
    const recipe = {
      project: "embody-m11-local",
      region: "us-central1",
      builderServiceAccount: "embody-m11-builder@embody-m11-local.iam.gserviceaccount.com",
      builderImage: builderRef,
      dockerImage: DOCKER_CLI,
      runtimeImage: RUNTIME_IMAGE,
      imageRepository: "us-central1-docker.pkg.dev/embody-m11-local/builds",
      outputBucket: "embody-m11-local-outputs",
      logsBucket: "embody-m11-local-logs",
    };

    // Source objects behind a host HTTP endpoint the prepare container reaches.
    const objects = new gateway.MemorySourceObjectStore();
    server = createServer((request, response) => {
      void (async () => {
        const reply = await objects.fetch(new URL(request.url, objects.origin).href, {
          method: request.method,
        });
        response.writeHead(reply.status).end(Buffer.from(await reply.arrayBuffer()));
      })();
    });
    const host = process.platform === "linux" ? "0.0.0.0" : "127.0.0.1";
    await new Promise((resolve) => server.listen(0, host, resolve));
    const sourcePort = server.address().port;
    const mapUrl = (url) =>
      url.replace(objects.origin, `http://host.docker.internal:${sourcePort}`);
    frameworkRegistry = await startFrameworkRegistry(join(context, "framework"), framework);

    const provider = new LocalBuildProvider({
      scratch,
      outputBucket: recipe.outputBucket,
      dockerImage: DOCKER_CLI,
      rewriteSourceUrl: mapUrl,
      imageAliases: { [builderRef]: tag },
      cleanupImage: RUNTIME_IMAGE,
    });
    const store = new gateway.MemoryGatewayStore();
    const result = await runM11Cases({
      gateway,
      contracts,
      createApp: scaffold.createApp,
      provider,
      sources: objects,
      store,
      recipe,
      registryUrl: frameworkRegistry.url,
      scratch,
      pidsLimit: contracts.BUILD_RECIPE.sandbox.pids,
      putSource: async (key, bytes) => objects.putRaw(key, bytes),
      mapForeignUrl: mapUrl,
      wait: (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
      pollMs: 3000,
      debugDir: process.env.EMBODY_M11_DEBUG_DIR,
      kinds: process.env.EMBODY_M11_KINDS?.split(","),
      runnable: async (artifact) => {
        // Run the admitted image with no network: framework resolves, config loads, and the
        // catalog it compiles is the one admission recorded.
        const script = [
          "const { createHash } = await import('node:crypto');",
          "const core = await import('@embody/core'); const host = await import('@embody/host');",
          "const c = (await import('/app/dist/embody.config.js')).default;",
          "const m = core.compileManifest(c.plugins, { app: host.appMetadataOf(c) });",
          "const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => JSON.stringify(k) + ':' + canon(x)).join(',') + '}' : JSON.stringify(v);",
          "console.log(JSON.stringify({ node: process.version, user: process.getuid(), catalog: 'sha256:' + createHash('sha256').update(canon(m)).digest('hex') }));",
        ].join("\n");
        const output = docker([
          "run",
          "--rm",
          "--network",
          "none",
          "--entrypoint",
          "node",
          artifact.imageDigest,
          "--input-type=module",
          "-e",
          script,
        ]);
        const facts = JSON.parse(output.split("\n").pop());
        const checks = {
          node24: /^v24\./.test(facts.node),
          nonRoot: facts.user === 1000,
          catalogMatches: facts.catalog === artifact.manifest.catalogDigest,
        };
        return { pass: Object.values(checks).every(Boolean), checks };
      },
    });
    await provider.idle();
    const outcomes = Object.values(result.cases);
    const counts = {
      passed: outcomes.filter((c) => c.pass).length,
      failed: outcomes.filter((c) => !c.pass).length,
      skipped: 0,
    };
    const details = {
      providerEvidence: false,
      builderImage: builderRef,
      runtimeImage: RUNTIME_IMAGE,
      dockerImage: DOCKER_CLI,
      m11: result,
    };
    if (!result.pass) {
      await evidence("m11-local", "failed", counts, [], details);
      console.error(
        JSON.stringify(
          Object.fromEntries(Object.entries(result.cases).filter(([, v]) => !v.pass)),
          null,
          2,
        ),
      );
      for (const [name, value] of Object.entries(result.results))
        if (value.logTail)
          console.error(
            `--- ${name} (${value.error ?? value.state}, expected ${value.expect})\n${value.logTail}`,
          );
      throw new SuiteFailure("M11 local build cases failed", counts);
    }
    await evidence("m11-local", "passed", counts, [], details);
    console.log(
      `M11 local: ${counts.passed} cases passed, ${result.builds} builds in ${result.buildSeconds}s`,
    );
  } finally {
    server?.close();
    await frameworkRegistry?.close();
    const leftovers = [
      docker(["ps", "-aq", "--filter", "name=embody-m11-"], { allowFailure: true }),
      docker(["ps", "-aq", "--filter", "name=embody-sandbox-art_"], { allowFailure: true }),
    ]
      .filter(Boolean)
      .join("\n");
    if (leftovers) docker(["rm", "-f", ...leftovers.split("\n")], { allowFailure: true });
    const images = docker(
      ["images", "-q", "--filter", "label=org.embody.recipe=embody-node24-pnpm-v1"],
      { allowFailure: true },
    );
    if (images) docker(["rmi", "-f", ...new Set(images.split("\n"))], { allowFailure: true });
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
});
