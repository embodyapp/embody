// Local emulation of the Cloud Build default pool for the exact platform build plan: each step
// runs as its own container with /workspace and /builder/outputs mounted, Docker-CLI steps get
// the Docker socket (as Cloud Build steps do), substitutions are applied and `$$` unescaped.
// It exercises the real recipe scripts and sandbox flags on local Docker. It is NOT provider
// evidence: no IAM, no metadata server, no registry push (the local image ID stands in for the
// pushed digest).
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const { setTimeout, clearTimeout } = globalThis;

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(`docker ${args[0]} failed: ${(result.stderr ?? "").slice(-400)}`);
  return result;
}

export class LocalBuildProvider {
  /**
   * `scratch`: a directory Docker can bind-mount. `rewriteSourceUrl(url)`: maps the signed URL
   * to one the prepare container can reach. `dockerSteps`: images that get the Docker socket.
   */
  constructor({ scratch, outputBucket, dockerImage, rewriteSourceUrl, cleanupImage, imageAliases = {} }) {
    this.imageAliases = imageAliases;
    this.slots = 2;
    this.queue = [];
    this.scratch = scratch;
    this.bucketDir = join(scratch, "bucket");
    this.outputBucket = outputBucket;
    this.dockerImage = dockerImage;
    this.rewriteSourceUrl = rewriteSourceUrl;
    this.cleanupImage = cleanupImage;
    this.builds = new Map();
    this.running = new Set();
    this.submitted = [];
  }
  async submit(config) {
    const id = randomUUID();
    this.submitted.push(config);
    const build = { id, config, status: "QUEUED", images: [], stepOutputs: [], log: "" };
    this.builds.set(id, build);
    const run = this.acquire()
      .then(() => this.run(build))
      .finally(() => this.release())
      .catch((error) => {
      build.status = "INTERNAL_ERROR";
      build.log += `\nemulator error: ${error.message}\n`;
    });
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
    return { buildId: id };
  }
  acquire() {
    if (this.slots > 0) {
      this.slots -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.slots += 1;
  }
  async idle() {
    while (this.running.size) await Promise.all([...this.running]);
  }
  async run(build) {
    const root = join(this.scratch, "builds", build.id);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    build.status = "WORKING";
    build.startTime = new Date().toISOString();
    const deadline = Date.now() + Number.parseInt(build.config.timeout, 10) * 1000;
    let failed = false;
    for (const [index, step] of build.config.steps.entries()) {
      const outputs = join(root, `outputs-${index}`);
      await mkdir(outputs, { recursive: true });
      const alias = (value) => {
        for (const [from, to] of Object.entries(this.imageAliases)) value = value.replaceAll(from, to);
        return value;
      };
      const env = step.env.map((pair) =>
        alias(pair.replace("$_SOURCE_URL", this.rewriteSourceUrl(build.config.substitutions._SOURCE_URL))),
      );
      const args = [
        "run",
        "--rm",
        "--name",
        `embody-m11-step-${build.id.slice(0, 8)}-${index}`,
        "--add-host",
        "host.docker.internal:host-gateway",
        "-v",
        `${workspace}:/workspace`,
        "-v",
        `${outputs}:/builder/outputs`,
        "-e",
        "BUILDER_OUTPUT=/builder/outputs",
        ...env.flatMap((pair) => ["-e", pair]),
        ...(step.name === this.dockerImage
          ? ["-v", "/var/run/docker.sock:/var/run/docker.sock"]
          : []),
        "--entrypoint",
        step.entrypoint,
        alias(step.name),
        ...step.args.map((arg) => arg.replaceAll("$$", "$")),
      ];
      const stepTimeout = Math.min(
        Number.parseInt(step.timeout, 10) * 1000,
        Math.max(1000, deadline - Date.now()),
      );
      const { code, output, timedOut } = await new Promise((resolve) => {
        const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
        let text = "";
        const append = (chunk) => {
          if (text.length < 4 * 1024 * 1024) text += chunk;
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        let expired = false;
        const timer = setTimeout(() => {
          expired = true;
          docker(["rm", "-f", `embody-m11-step-${build.id.slice(0, 8)}-${index}`], {
            allowFailure: true,
          });
        }, stepTimeout);
        child.on("close", (status) => {
          clearTimeout(timer);
          resolve({ code: status, output: text, timedOut: expired });
        });
      });
      build.log += output
        .split("\n")
        .map((line) => `Step #${index} - "${step.id}": ${line}`)
        .join("\n");
      build.log += "\n";
      try {
        build.stepOutputs[index] = await readFile(join(outputs, "output"), "utf8");
      } catch {
        build.stepOutputs[index] = "";
      }
      if (timedOut) {
        build.status = "TIMEOUT";
        failed = true;
        break;
      }
      if (code !== 0) {
        build.status = "FAILURE";
        failed = true;
        break;
      }
    }
    if (!failed) {
      for (const image of build.config.images) {
        const id = docker(["image", "inspect", "--format", "{{.Id}}", image]).stdout.trim();
        build.images.push({ name: image, digest: id });
      }
      const location = build.config.artifacts.objects.location.replace(
        `gs://${this.outputBucket}/`,
        "",
      );
      for (const path of build.config.artifacts.objects.paths) {
        const target = join(this.bucketDir, location, path.split("/").pop());
        await mkdir(dirname(target), { recursive: true });
        await cp(join(workspace, path), target);
      }
      build.status = "SUCCESS";
    }
    build.finishTime = new Date().toISOString();
    const logs = build.config.logsBucket.replace(`gs://${this.outputBucket}/`, "");
    const logFile = join(this.bucketDir, logs, `log-${build.id}.txt`);
    await mkdir(dirname(logFile), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(logFile, build.log);
    // Workspace files may be owned by container users; remove them from a container.
    docker(["run", "--rm", "-v", `${root}:/target`, "--entrypoint", "rm", this.cleanupImage, "-rf", "/target/workspace"], {
      allowFailure: true,
    });
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  async find(tag) {
    for (const build of this.builds.values()) if (build.config.tags.includes(tag)) return build.id;
    return null;
  }
  async get(buildId) {
    const build = this.builds.get(buildId);
    if (!build) throw new Error("Build not found");
    const { substitutions, ...config } = build.config;
    void substitutions;
    return {
      id: build.id,
      status: build.status,
      config,
      images: build.images,
      stepOutputs: build.stepOutputs,
      ...(build.startTime ? { startTime: build.startTime } : {}),
      ...(build.finishTime ? { finishTime: build.finishTime } : {}),
    };
  }
  async cancel(buildId) {
    const build = this.builds.get(buildId);
    if (build && !["SUCCESS", "FAILURE", "TIMEOUT"].includes(build.status))
      build.status = "CANCELLED";
  }
  async readOutput(path, maxBytes) {
    try {
      const file = join(this.bucketDir, path);
      if ((await stat(file)).size > maxBytes) throw new Error("Build output too large");
      return new Uint8Array(await readFile(file));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async deleteOutputs(prefix) {
    await rm(join(this.bucketDir, prefix), { recursive: true, force: true });
  }
  async readLog(buildId, logsBucket, maxBytes) {
    const bytes = await this.readOutput(
      `${logsBucket.replace(`gs://${this.outputBucket}/`, "")}/log-${buildId}.txt`,
      maxBytes,
    );
    return bytes ? Buffer.from(bytes).toString("utf8") : null;
  }
  async deleteImage(path, digest) {
    const [workspaceId, appId] = path.split("/");
    const ids = docker([
      "images",
      "-q",
      "--no-trunc",
      "--filter",
      `label=org.embody.workspace=${workspaceId}`,
      "--filter",
      `label=org.embody.app=${appId}`,
    ]).stdout.split("\n");
    if (ids.includes(digest)) docker(["rmi", "-f", digest], { allowFailure: true });
  }
  async listImages(path) {
    const [workspaceId, appId] = path.split("/");
    const out = docker([
      "images",
      "--no-trunc",
      "--format",
      "{{.ID}} {{.CreatedAt}}",
      "--filter",
      `label=org.embody.workspace=${workspaceId}`,
      "--filter",
      `label=org.embody.app=${appId}`,
    ]).stdout;
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [digest, ...rest] = line.split(" ");
        return { digest, createdAt: new Date(rest.slice(0, 2).join(" ")).toISOString() };
      });
  }
  async files() {
    const walk = async (dir) => {
      const out = [];
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else out.push(full.slice(this.bucketDir.length + 1));
      }
      return out;
    };
    return walk(this.bucketDir);
  }
}
