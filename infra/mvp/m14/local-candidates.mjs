// Local candidate provider for the M14 journey: the M13 `CandidateProvider` port on Docker. A
// candidate runs the admitted image (the local image ID the M11 build emulator produced) with
// exactly the environment the release stages specified, resolving secret references from the
// memory identity provider the way Cloud Run resolves Secret Manager references. Containers are
// named and labelled per run so cleanup removes only what this run created. NOT provider
// evidence: no Cloud Run IAM, ingress or scaling; the live suite covers those.
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

const { AbortSignal, URL, fetch, setTimeout } = globalThis;

function docker(args, options = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", ...options });
  if (result.status !== 0 && !options.allowFailure)
    throw new Error(`docker ${args[0]} failed: ${(result.stderr ?? "").slice(-400)}`);
  return (result.stdout ?? "").trim();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export class DockerCandidateProvider {
  /**
   * `run`: label value scoping this run. `secrets`: the memory identity provider (versions).
   * `network`: "host" on Linux, otherwise ports are published on loopback. `preload`: absolute
   * path of the emulator preload mounted read-only. `emulator`: its JSON configuration.
   */
  constructor({ run, prefix, secrets, network, preload, emulator }) {
    this.run = run;
    this.prefix = prefix;
    this.secrets = secrets;
    this.network = network;
    this.preload = preload;
    this.emulator = emulator;
    this.candidates = new Map();
    this.created = 0;
  }
  container(name) {
    return `embody-m14-${this.run}-${name}`;
  }
  state(name) {
    const candidate = this.candidates.get(name);
    if (!candidate) return null;
    const status = docker(["inspect", "--format", "{{.State.Status}}", this.container(name)], {
      allowFailure: true,
    });
    return {
      name,
      endpoint: `http://127.0.0.1:${candidate.port}`,
      image: candidate.spec.image,
      status:
        status === "running" || status === "paused"
          ? "ready"
          : status === "created" || status === "restarting"
            ? "pending"
            : "failed",
      labels: { ...candidate.spec.labels },
      annotations: { ...candidate.spec.annotations },
    };
  }
  async get(name) {
    return this.state(name);
  }
  async create(spec) {
    if (this.candidates.has(spec.name)) return;
    const digest = /@(sha256:[a-f0-9]{64})$/.exec(spec.image)?.[1];
    if (!digest) throw new Error("Candidates deploy digest references only");
    const port = await freePort();
    const env = [];
    for (const entry of spec.env) {
      if (entry.secret) {
        const secret = this.secrets.secrets.get(entry.secret.secret);
        const value = secret?.versions.at(-1);
        if (value === undefined) throw new Error("Candidate secret has no version");
        env.push([entry.name, value]);
      } else env.push([entry.name, entry.value ?? ""]);
    }
    env.push(
      ["PORT", String(this.network === "host" ? port : 8080)],
      ["NODE_OPTIONS", "--import=/embody-emulator/preload.mjs"],
      ["EMBODY_M14_EMULATOR", JSON.stringify(this.emulator)],
    );
    this.candidates.set(spec.name, { spec, port });
    this.created += 1;
    const args = [
      "run",
      "--detach",
      "--name",
      this.container(spec.name),
      "--label",
      `org.embody.m14.run=${this.run}`,
      ...Object.entries(spec.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      "--memory",
      "512m",
      "--pids-limit",
      "256",
      "-v",
      `${this.preload}:/embody-emulator/preload.mjs:ro`,
      ...(this.network === "host"
        ? ["--network", "host"]
        : ["-p", `127.0.0.1:${port}:8080`, "--add-host", "host.docker.internal:host-gateway"]),
      ...env.flatMap(([key]) => ["-e", key]),
      digest,
    ];
    // Values go through the child's environment, never the docker command line.
    docker(args, { env: { ...process.env, ...Object.fromEntries(env) } });
  }
  async setInvokers(name, members) {
    const candidate = this.candidates.get(name);
    if (!candidate) throw new Error("Candidate not found");
    candidate.invokers = [...members];
  }
  async remove(name) {
    if (!this.candidates.delete(name)) return;
    docker(["rm", "-f", this.container(name)], { allowFailure: true });
  }
  async list() {
    return [...this.candidates.keys()].map((name) => this.state(name)).filter(Boolean);
  }
  /** Freezes a candidate's processes: requests hang (the journey's cold-timeout case). */
  pause(name) {
    docker(["pause", this.container(name)]);
  }
  unpause(name) {
    docker(["unpause", this.container(name)], { allowFailure: true });
  }
  logs(name) {
    return docker(["logs", this.container(name)], { allowFailure: true, maxBuffer: 16 << 20 });
  }
  /** Removes every container this run created, whatever the provider still tracks. */
  cleanup() {
    const ids = docker(["ps", "-aq", "--filter", `label=org.embody.m14.run=${this.run}`], {
      allowFailure: true,
    });
    if (ids) docker(["rm", "-f", ...ids.split("\n")], { allowFailure: true });
    this.candidates.clear();
    return ids ? ids.split("\n").length : 0;
  }
}

/** Readiness: `/health` answers `ready: true` (the M13 probe, without Cloud Run ID tokens). */
export function localHealthProbe() {
  return {
    async ready(endpoint, signal) {
      try {
        const response = await fetch(new URL("/health", endpoint), {
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        });
        if (!response.ok) return false;
        return (await response.json()).ready === true;
      } catch {
        return false;
      }
    },
  };
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
