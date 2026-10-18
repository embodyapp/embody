// Real GCP provider for the M11 live suite. Creates only owned, run-scoped resources with
// resource-level IAM: a builder and a source read-signer service account, a no-role runtime
// probe service account, two Artifact Registry repositories (recipe, builds), two private
// buckets (sources, build outputs) and one Cloud Run job. Builds run on the Cloud Build default
// pool in the region as the builder. Tokens, signed URLs and payloads are never printed.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { deadlineFetch, operatorToken } from "../m09/gcp.mjs";

const { Buffer, URL, fetch } = globalThis;
const exec = promisify(execFile);
const STORAGE = "https://storage.googleapis.com/storage/v1";
const IAM = "https://iam.googleapis.com/v1";
const AR = "https://artifactregistry.googleapis.com/v1";
const RUN = "https://run.googleapis.com/v2";
export const M11_REGION = "us-central1";
export const NODE_RUNTIME =
  "docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5";
export const CLOUD_BUILDERS_DOCKER =
  "gcr.io/cloud-builders/docker@sha256:f772ab459889c67835bd959c2b9e9351f2c0752c4f989710ecda20c229f0733e";

export function m11Names(project, prefix, runId) {
  const account = (id) => ({ id, email: `${id}@${project}.iam.gserviceaccount.com` });
  return {
    builder: account(`${prefix}-b-${runId}`),
    reader: account(`${prefix}-r-${runId}`),
    runtime: account(`${prefix}-x-${runId}`),
    recipeRepo: `${prefix}-recipe-${runId}`,
    buildsRepo: `${prefix}-builds-${runId}`,
    sourceBucket: `${prefix}-src-${runId}`,
    outputBucket: `${prefix}-out-${runId}`,
    logsBucket: `${prefix}-log-${runId}`,
    job: `${prefix}-run-${runId}`,
  };
}

export function createM11GcpProvider({
  project,
  gateway,
  credentials = "gcloud",
  token = () => operatorToken(credentials),
  fetcher: baseFetch = fetch,
}) {
  const fetcher = deadlineFetch(baseFetch);
  let cached;
  const accessToken = async () => {
    if (!cached || cached.until < Date.now())
      cached = { value: await token(), until: Date.now() + 3 * 60_000 };
    return cached.value;
  };
  async function api(
    url,
    method = "GET",
    body,
    { allow = [], contentType = "application/json" } = {},
  ) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetcher(url, {
          method,
          redirect: "error",
          headers: { authorization: `Bearer ${await accessToken()}`, "content-type": contentType },
          ...(body === undefined
            ? {}
            : {
                body:
                  typeof body === "string" || body instanceof Uint8Array
                    ? body
                    : JSON.stringify(body),
              }),
        });
      } catch {
        if (method === "GET" && attempt < 2) {
          await delay(5000);
          continue;
        }
        throw new Error(`Provider ${method} ${new URL(url).host} failed (0); details suppressed`);
      }
      if (response.status === 401 && attempt === 0) {
        cached = undefined;
        continue;
      }
      if (response.status >= 500 && method === "GET" && attempt < 2) {
        await delay(5000);
        continue;
      }
      if (allow.includes(response.status)) return { status: response.status };
      if (response.status === 404 && ["GET", "DELETE"].includes(method)) return null;
      if (!response.ok)
        throw new Error(
          `Provider ${method} ${new URL(url).host} failed (${response.status}); body suppressed`,
        );
      return response.status === 204 ? {} : response.json().catch(() => ({}));
    }
  }
  async function eventually(fn, attempts = 12) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= attempts || !/failed \((400|403|404|409)\)/.test(error.message)) throw error;
        await delay(10_000);
      }
    }
  }
  async function operation(op, base = "https://artifactregistry.googleapis.com/v1") {
    for (let i = 0; op && !op.done && i < 60; i++) {
      await delay(3000);
      op = await api(`${base}/${op.name}`);
    }
    if (op && op.error)
      throw new Error(`Provider operation failed (${op.error.code}); details suppressed`);
    return op;
  }
  async function operatorMember() {
    const { stdout } = await exec("gcloud", ["config", "get-value", "account"]);
    const account = stdout.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(account)) throw new Error("Operator gcloud account unavailable");
    return account.endsWith(".gserviceaccount.com")
      ? `serviceAccount:${account}`
      : `user:${account}`;
  }
  async function addBinding(getUrl, setUrl, role, member, wrap = (policy) => ({ policy })) {
    await eventually(async () => {
      // IAM service accounts take POST :getIamPolicy; Artifact Registry takes GET; buckets GET /iam.
      const post = getUrl.endsWith(":getIamPolicy") && getUrl.startsWith(IAM);
      const policy = (await api(getUrl, post ? "POST" : "GET", post ? {} : undefined)) ?? {};
      policy.bindings = [...(policy.bindings ?? []), { role, members: [member] }];
      await api(
        setUrl,
        setUrl.endsWith(":setIamPolicy") ? "POST" : "PUT",
        setUrl.endsWith(":setIamPolicy") ? wrap(policy) : policy,
      );
    });
  }
  const repoPath = (name) => `projects/${project}/locations/${M11_REGION}/repositories/${name}`;
  const repoHost = `${M11_REGION}-docker.pkg.dev`;
  let projectNumber;
  let stateBucket;
  const inventoryWrite = async (runId, data) => {
    if (!stateBucket) return;
    await api(
      `https://storage.googleapis.com/upload/storage/v1/b/${stateBucket}/o?uploadType=media&name=${encodeURIComponent(`mvp/m11/runs/${runId}.json`)}`,
      "POST",
      JSON.stringify({ ...data, updatedAt: new Date().toISOString() }),
    );
  };
  const run = (command, args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"], ...options });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`${command} ${args[0]} failed (${code}); output suppressed`)),
      );
    });

  return {
    async preflight() {
      const info = await api(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}`);
      if (!info?.projectNumber) throw new Error("Project unavailable");
      projectNumber = info.projectNumber;
      const disabled = [];
      for (const service of [
        "cloudbuild.googleapis.com",
        "artifactregistry.googleapis.com",
        "storage.googleapis.com",
        "iam.googleapis.com",
        "iamcredentials.googleapis.com",
        "run.googleapis.com",
      ]) {
        const state = await api(
          `https://serviceusage.googleapis.com/v1/projects/${projectNumber}/services/${service}`,
        );
        if (state?.state !== "ENABLED") disabled.push(service);
      }
      stateBucket = `${project}-tfstate-${projectNumber}`;
      const state = await api(`${STORAGE}/b/${stateBucket}?fields=iamConfiguration`);
      if (!state || state.iamConfiguration?.publicAccessPrevention !== "enforced")
        throw new Error("Private state bucket unavailable or not private");
      return { disabledServices: disabled };
    },
    /** Enables APIs the suite needs (retained afterwards, as M09 does: disable_on_destroy=false). */
    async enableServices(services) {
      for (const service of services) {
        const op = await api(
          `https://serviceusage.googleapis.com/v1/projects/${projectNumber}/services/${service}:enable`,
          "POST",
          {},
        );
        await operation(op, "https://serviceusage.googleapis.com/v1");
      }
    },
    async setUp(approval, runId) {
      const n = m11Names(project, approval.prefix, runId);
      await inventoryWrite(runId, { status: "creating", ...n });
      for (const [account, label] of [
        [n.builder, "builder"],
        [n.reader, "source read signer"],
        [n.runtime, "runtime probe (no roles)"],
      ])
        await api(`${IAM}/projects/${project}/serviceAccounts`, "POST", {
          accountId: account.id,
          serviceAccount: { displayName: `Embody M11 qualification ${label} (disposable)` },
        });
      // Mutable tags: Artifact Registry refuses to delete a tagged version in an immutable-tag
      // repository (FAILED_PRECONDITION), which retention and rejection cleanup need. Nothing
      // deploys by tag: admission binds the provider-reported digest.
      for (const repo of [n.recipeRepo, n.buildsRepo])
        await operation(
          await api(
            `${AR}/projects/${project}/locations/${M11_REGION}/repositories?repositoryId=${repo}`,
            "POST",
            {
              format: "DOCKER",
              labels: { embody: "m11-qualification", run: runId },
              dockerConfig: { immutableTags: false },
            },
          ),
        );
      for (const bucket of [n.sourceBucket, n.outputBucket, n.logsBucket])
        await api(`${STORAGE}/b?project=${project}`, "POST", {
          name: bucket,
          location: "US-CENTRAL1",
          storageClass: "STANDARD",
          labels: { embody: "m11-qualification", run: runId },
          iamConfiguration: {
            uniformBucketLevelAccess: { enabled: true },
            publicAccessPrevention: "enforced",
          },
          softDeletePolicy: { retentionDurationSeconds: "0" },
          versioning: { enabled: false },
          lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 2 } }] },
        });
      const sa = (email) => `serviceAccount:${email}`;
      // Builder: push to the builds repo, pull the recipe, create outputs. Nothing else.
      await addBinding(
        `${AR}/${repoPath(n.buildsRepo)}:getIamPolicy`,
        `${AR}/${repoPath(n.buildsRepo)}:setIamPolicy`,
        "roles/artifactregistry.writer",
        sa(n.builder.email),
      );
      await addBinding(
        `${AR}/${repoPath(n.recipeRepo)}:getIamPolicy`,
        `${AR}/${repoPath(n.recipeRepo)}:setIamPolicy`,
        "roles/artifactregistry.reader",
        sa(n.builder.email),
      );
      await addBinding(
        `${STORAGE}/b/${n.outputBucket}/iam`,
        `${STORAGE}/b/${n.outputBucket}/iam`,
        "roles/storage.objectCreator",
        sa(n.builder.email),
      );
      // Cloud Build checks it can get the artifact and logs buckets (otherwise "bucket does not
      // exist" / FAILED_PRECONDITION): bucket get and object list, never object read.
      await addBinding(
        `${STORAGE}/b/${n.outputBucket}/iam`,
        `${STORAGE}/b/${n.outputBucket}/iam`,
        "roles/storage.legacyBucketReader",
        sa(n.builder.email),
      );
      // Logs: Cloud Build refuses a user-specified logs bucket the build identity cannot get
      // (FAILED_PRECONDITION) and rewrites the log object while the build runs, so the builder
      // gets bucket get/list plus object create/update/delete here, and nowhere else.
      await addBinding(
        `${STORAGE}/b/${n.logsBucket}/iam`,
        `${STORAGE}/b/${n.logsBucket}/iam`,
        "roles/storage.legacyBucketReader",
        sa(n.builder.email),
      );
      await addBinding(
        `${STORAGE}/b/${n.logsBucket}/iam`,
        `${STORAGE}/b/${n.logsBucket}/iam`,
        "roles/storage.objectUser",
        sa(n.builder.email),
      );
      // Read signer: object read on sources only; the operator (as controller) may sign as it.
      await addBinding(
        `${STORAGE}/b/${n.sourceBucket}/iam`,
        `${STORAGE}/b/${n.sourceBucket}/iam`,
        "roles/storage.objectViewer",
        sa(n.reader.email),
      );
      const operator = await operatorMember();
      await addBinding(
        `${IAM}/projects/-/serviceAccounts/${n.reader.email}:getIamPolicy`,
        `${IAM}/projects/-/serviceAccounts/${n.reader.email}:setIamPolicy`,
        "roles/iam.serviceAccountTokenCreator",
        operator,
      );
      await inventoryWrite(runId, { status: "created", ...n });
      return { ...n, projectNumber };
    },
    /** Builds the recipe image for linux/amd64 and pushes it, plus a copy of the runtime base. */
    async pushRecipe(context, recipeContext) {
      const config = await mkdtemp(join(recipeContext, "..", "docker-config-"));
      try {
        // Short-lived operator token in a throwaway Docker config; nothing persists.
        // The throwaway config keeps the operator's plugins and current Docker endpoint.
        const home = process.env.HOME ?? "";
        const { stdout: dockerHost } = await exec("docker", [
          "context",
          "inspect",
          "--format",
          "{{.Endpoints.docker.Host}}",
        ]);
        await writeFile(
          join(config, "config.json"),
          JSON.stringify({
            cliPluginsExtraDirs: [
              join(home, ".docker/cli-plugins"),
              "/Applications/Docker.app/Contents/Resources/cli-plugins",
              "/usr/local/lib/docker/cli-plugins",
              "/usr/libexec/docker/cli-plugins",
            ],
            auths: {
              [repoHost]: {
                auth: Buffer.from(`oauth2accesstoken:${await accessToken()}`).toString("base64"),
              },
            },
          }),
          { mode: 0o600 },
        );
        const env = { ...process.env, DOCKER_CONFIG: config, DOCKER_HOST: dockerHost.trim() };
        const base = `${repoHost}/${project}/${context.recipeRepo}`;
        await run(
          "docker",
          [
            "buildx",
            "build",
            "--platform",
            "linux/amd64",
            "--provenance=false",
            "-q",
            "--push",
            "-t",
            `${base}/builder:m11`,
            recipeContext,
          ],
          { env },
        );
        await run(
          "docker",
          ["buildx", "imagetools", "create", "-t", `${base}/node-runtime:24`, NODE_RUNTIME],
          { env },
        );
        const image = await api(`${AR}/${repoPath(context.recipeRepo)}/dockerImages?pageSize=50`);
        const builder = (image?.dockerImages ?? []).find(
          (i) => i.uri.includes("/builder@") && (i.tags ?? []).includes("m11"),
        );
        if (!builder) throw new Error("Recipe image not found after push");
        return {
          builderImage: builder.uri,
          runtimeImage: `${base}/node-runtime@${NODE_RUNTIME.split("@")[1]}`,
        };
      } finally {
        await rm(config, { recursive: true, force: true });
      }
    },
    buildProvider(recipe) {
      return new gateway.CloudBuildProvider({ recipe, accessToken, timeoutMs: 30_000 });
    },
    sources(context) {
      return new gateway.GcsSourceObjectStore({
        bucket: context.sourceBucket,
        signerEmail: context.reader.email.replace(`-r-`, `-u-`), // never used: no uploads here
        readSignerEmail: context.reader.email,
        accessToken,
        timeoutMs: 20_000,
      });
    },
    async putSource(context, key, bytes) {
      await api(
        `https://storage.googleapis.com/upload/storage/v1/b/${context.sourceBucket}/o?uploadType=media&name=${encodeURIComponent(key)}&ifGenerationMatch=0`,
        "POST",
        bytes,
        { contentType: "application/gzip" },
      );
    },
    /** Resource-level IAM of every role the builder holds anywhere in the run's resources. */
    async builderBindings(context) {
      const member = `serviceAccount:${context.builder.email}`;
      const collect = (where, policy) =>
        (policy?.bindings ?? [])
          .filter((b) => b.members.includes(member))
          .map((b) => `${where}:${b.role}`);
      const project_ = await api(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`,
        "POST",
        {},
      );
      return [
        ...collect("project", project_),
        ...collect("buildsRepo", await api(`${AR}/${repoPath(context.buildsRepo)}:getIamPolicy`)),
        ...collect("recipeRepo", await api(`${AR}/${repoPath(context.recipeRepo)}:getIamPolicy`)),
        ...collect("outputBucket", await api(`${STORAGE}/b/${context.outputBucket}/iam`)),
        ...collect("logsBucket", await api(`${STORAGE}/b/${context.logsBucket}/iam`)),
        ...collect("sourceBucket", await api(`${STORAGE}/b/${context.sourceBucket}/iam`)),
        ...collect(
          "builderSelf",
          await api(
            `${IAM}/projects/-/serviceAccounts/${context.builder.email}:getIamPolicy`,
            "POST",
            {},
          ),
        ),
        ...collect(
          "runtimeSa",
          await api(
            `${IAM}/projects/-/serviceAccounts/${context.runtime.email}:getIamPolicy`,
            "POST",
            {},
          ),
        ),
      ].sort();
    },
    /** Points an admitted image's tag at another image (as a builder-token holder could). */
    async retag(context, image, source) {
      const config = await mkdtemp(join(tmpdir(), "embody-m11-retag-"));
      try {
        const { stdout: dockerHost } = await exec("docker", [
          "context",
          "inspect",
          "--format",
          "{{.Endpoints.docker.Host}}",
        ]);
        await writeFile(
          join(config, "config.json"),
          JSON.stringify({
            cliPluginsExtraDirs: [
              join(process.env.HOME ?? "", ".docker/cli-plugins"),
              "/Applications/Docker.app/Contents/Resources/cli-plugins",
            ],
            auths: {
              [repoHost]: {
                auth: Buffer.from(`oauth2accesstoken:${await accessToken()}`).toString("base64"),
              },
            },
          }),
          { mode: 0o600 },
        );
        // A single manifest, like a real push (the default would wrap it in a new index).
        await run(
          "docker",
          ["buildx", "imagetools", "create", "--prefer-index=false", "-t", image, source],
          {
            env: { ...process.env, DOCKER_CONFIG: config, DOCKER_HOST: dockerHost.trim() },
          },
        );
      } finally {
        await rm(config, { recursive: true, force: true });
      }
    },
    /**
     * Runs an admitted image as a one-off Cloud Run job under the no-role runtime identity. The
     * job exits 0 only if the image runs and every privileged API call from it is denied.
     */
    async runImage(context, image, env) {
      const parent = `projects/${project}/locations/${M11_REGION}`;
      const name = `${parent}/jobs/${context.job}`;
      await api(`${RUN}/${name}`, "DELETE").then((op) => op && delay(5000));
      const created = await eventually(() =>
        api(`${RUN}/${parent}/jobs?jobId=${context.job}`, "POST", {
          labels: { embody: "m11-qualification" },
          template: {
            taskCount: 1,
            template: {
              maxRetries: 0,
              timeout: "180s",
              serviceAccount: context.runtime.email,
              containers: [
                {
                  image,
                  command: ["node"],
                  args: ["--input-type=module", "-e", env.script],
                  env: Object.entries(env.vars).map(([n, value]) => ({ name: n, value })),
                  resources: { limits: { cpu: "1", memory: "512Mi" } },
                },
              ],
            },
          },
        }),
      );
      await operation(created, RUN);
      const launched = await api(`${RUN}/${name}:run`, "POST", {});
      const done = await operation(launched, RUN);
      const execution = done?.response ?? {};
      return {
        succeeded: Number(execution.succeededCount ?? 0),
        failed: Number(execution.failedCount ?? 0),
      };
    },
    async projectIam() {
      const policy = await api(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`,
        "POST",
        {},
      );
      return JSON.stringify(
        (policy.bindings ?? [])
          .map(
            (b) =>
              `${b.role}|${[...b.members].sort().join(",")}|${b.condition ? JSON.stringify(b.condition) : ""}`,
          )
          .sort(),
      );
    },
    async buildMinutes(buildIds) {
      let seconds = 0;
      for (const id of buildIds) {
        const build = await api(
          `https://cloudbuild.googleapis.com/v1/projects/${project}/locations/${M11_REGION}/builds/${id}`,
        );
        if (build?.startTime && build?.finishTime)
          seconds += (Date.parse(build.finishTime) - Date.parse(build.startTime)) / 1000;
        else if (build?.startTime) seconds += 600;
      }
      return seconds / 60;
    },
    wait: (ms) => delay(ms),
    async tearDown(approval, runId) {
      const n = m11Names(project, approval.prefix, runId);
      const removed = [];
      const job = await api(`${RUN}/projects/${project}/locations/${M11_REGION}/jobs/${n.job}`);
      if (job) {
        await operation(
          await api(`${RUN}/projects/${project}/locations/${M11_REGION}/jobs/${n.job}`, "DELETE"),
          RUN,
        );
        removed.push("job");
      }
      for (const bucket of [n.sourceBucket, n.outputBucket, n.logsBucket]) {
        if (!(await api(`${STORAGE}/b/${bucket}?fields=name`))) continue;
        let pageToken;
        do {
          const page = await api(
            `${STORAGE}/b/${bucket}/o?versions=true&fields=items(name,generation),nextPageToken${pageToken ? `&pageToken=${pageToken}` : ""}`,
          );
          for (const item of page?.items ?? [])
            await api(
              `${STORAGE}/b/${bucket}/o/${encodeURIComponent(item.name)}?generation=${item.generation}`,
              "DELETE",
            );
          pageToken = page?.nextPageToken;
        } while (pageToken);
        await eventually(() => api(`${STORAGE}/b/${bucket}`, "DELETE"), 6);
        removed.push(`bucket:${bucket}`);
      }
      for (const repo of [n.buildsRepo, n.recipeRepo])
        if (await api(`${AR}/${repoPath(repo)}`)) {
          await operation(await api(`${AR}/${repoPath(repo)}`, "DELETE"));
          removed.push(`repository:${repo}`);
        }
      for (const account of [n.builder, n.reader, n.runtime])
        if (await api(`${IAM}/projects/${project}/serviceAccounts/${account.email}`)) {
          await api(`${IAM}/projects/${project}/serviceAccounts/${account.email}`, "DELETE");
          removed.push(`serviceAccount:${account.id}`);
        }
      await inventoryWrite(runId, { status: "removed", ...n });
      return { pass: true, removed };
    },
    async inventory(approval) {
      const leftovers = [];
      const buckets = await api(
        `${STORAGE}/b?project=${project}&prefix=${approval.prefix}-&fields=items(name)`,
      );
      for (const item of buckets?.items ?? [])
        if (/-(src|out|log)-[a-f0-9]{6}$/.test(item.name)) leftovers.push(`bucket:${item.name}`);
      const repos = await api(
        `${AR}/projects/${project}/locations/${M11_REGION}/repositories?pageSize=200`,
      );
      for (const repo of repos?.repositories ?? []) {
        const id = repo.name.split("/").pop();
        if (
          id.startsWith(`${approval.prefix}-recipe-`) ||
          id.startsWith(`${approval.prefix}-builds-`)
        )
          leftovers.push(`repository:${id}`);
      }
      const jobs = await api(`${RUN}/projects/${project}/locations/${M11_REGION}/jobs`);
      for (const job of jobs?.jobs ?? [])
        if (job.name.split("/").pop().startsWith(`${approval.prefix}-run-`))
          leftovers.push(`job:${job.name.split("/").pop()}`);
      let pageToken;
      do {
        const page = await api(
          `${IAM}/projects/${project}/serviceAccounts?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ""}`,
        );
        for (const account of page?.accounts ?? [])
          if (
            /^[a-z0-9-]+-(b|r|x)-[a-f0-9]{6}@/.test(account.email) &&
            account.email.startsWith(`${approval.prefix}-`)
          )
            leftovers.push(`serviceAccount:${account.email}`);
        pageToken = page?.nextPageToken;
      } while (pageToken);
      return leftovers;
    },
  };
}
