// Real GCP provider for the M12 live suite, composed on the M11 provider (builder, read signer,
// no-role runtime identity, recipe and builds repositories, source/output/logs buckets). M12
// adds, all run-scoped and owned: a Cloud SQL platform database, a secret holding the worker's
// database URL, the controller queue, a worker (controller) identity, a controller invoker and
// the Cloud Run deployment worker. The worker's project-level grants (Cloud Build, Cloud SQL
// client) are removed before its identity is deleted. Tokens, passwords and URLs with
// credentials are never printed.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { deadlineFetch, operatorToken } from "../m09/gcp.mjs";
import { createM11GcpProvider, m11Names } from "../m11/gcp.mjs";

const { AbortSignal, Buffer, URL, fetch } = globalThis;
const exec = promisify(execFile);
const REGION = "us-central1";
const IAM = "https://iam.googleapis.com/v1";
const SQL = "https://sqladmin.googleapis.com/v1";
const RUN = "https://run.googleapis.com/v2";
const TASKS = "https://cloudtasks.googleapis.com/v2";
const SECRETS = "https://secretmanager.googleapis.com/v1";
const AR = "https://artifactregistry.googleapis.com/v1";
const STORAGE = "https://storage.googleapis.com/storage/v1";
const CRM = "https://cloudresourcemanager.googleapis.com/v1";
const PROJECT_ROLES = ["roles/cloudbuild.builds.editor", "roles/cloudsql.client"];
const QUEUE_LIMITS = {
  rateLimits: { maxDispatchesPerSecond: 5, maxConcurrentDispatches: 4 },
  retryConfig: {
    maxAttempts: -1,
    maxRetryDuration: "259200s",
    minBackoff: "1s",
    maxBackoff: "300s",
    maxDoublings: 8,
  },
};

export function m12Names(project, prefix, runId) {
  const account = (id) => ({ id, email: `${id}@${project}.iam.gserviceaccount.com` });
  return {
    ...m11Names(project, prefix, runId),
    worker: account(`${prefix}-c-${runId}`),
    invoker: account(`${prefix}-i-${runId}`),
    sql: `${prefix}-sql-${runId}`,
    queue: `${prefix}-deploy-${runId}`,
    service: `${prefix}-worker-${runId}`,
    secret: `${prefix}-dburl-${runId}`,
  };
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

export function createM12GcpProvider({
  project,
  gateway,
  credentials = "gcloud",
  token = () => operatorToken(credentials),
  fetcher: baseFetch = fetch,
}) {
  const m11 = createM11GcpProvider({ project, gateway, credentials, token, fetcher: baseFetch });
  const fetcher = deadlineFetch(baseFetch);
  let cached;
  const accessToken = async () => {
    if (!cached || cached.until < Date.now())
      cached = { value: await token(), until: Date.now() + 3 * 60_000 };
    return cached.value;
  };
  async function api(url, method = "GET", body, { allow = [] } = {}) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetcher(url, {
          method,
          redirect: "error",
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        if (["GET", "DELETE"].includes(method) && attempt < 6) {
          await delay(10_000);
          continue;
        }
        throw new Error(`Provider ${method} ${new URL(url).host} failed (0); details suppressed`);
      }
      if (response.status === 401 && attempt === 0) {
        cached = undefined;
        continue;
      }
      if (response.status >= 500 && ["GET", "DELETE"].includes(method) && attempt < 6) {
        await delay(10_000);
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
  async function waitOperation(op, base, maxPolls = 120) {
    for (let i = 0; op && !op.done && op.status !== "DONE" && i < maxPolls; i++) {
      await delay(5000);
      op = await api(op.selfLink ?? `${base}/${op.name}`);
    }
    if (op?.error)
      throw new Error(
        `Provider operation failed (${op.error.code ?? "error"}); details suppressed`,
      );
    return op;
  }
  async function addBinding(getUrl, setUrl, role, member, { post = false, wrap = true } = {}) {
    await eventually(async () => {
      const policy = (await api(getUrl, post ? "POST" : "GET", post ? {} : undefined)) ?? {};
      policy.bindings = [...(policy.bindings ?? []), { role, members: [member] }];
      await api(setUrl, "POST", wrap ? { policy } : policy);
    });
  }
  const sa = (email) => `serviceAccount:${email}`;
  let projectNumber;
  let proxy;
  const repoHost = `${REGION}-docker.pkg.dev`;

  async function projectPolicy(edit) {
    // Read-modify-write with the policy etag; a concurrent change makes setIamPolicy fail (409).
    await eventually(async () => {
      const policy = await api(`${CRM}/projects/${project}:getIamPolicy`, "POST", {});
      edit(policy);
      await api(`${CRM}/projects/${project}:setIamPolicy`, "POST", { policy });
    });
  }

  return {
    async preflight(approval) {
      const pre = await m11.preflight(approval);
      const info = await api(`${CRM}/projects/${project}`);
      projectNumber = info.projectNumber;
      const disabled = [...(pre.disabledServices ?? [])];
      for (const service of [
        "sqladmin.googleapis.com",
        "cloudtasks.googleapis.com",
        "secretmanager.googleapis.com",
      ]) {
        const state = await api(
          `https://serviceusage.googleapis.com/v1/projects/${projectNumber}/services/${service}`,
        );
        if (state?.state !== "ENABLED") disabled.push(service);
      }
      return { disabledServices: disabled };
    },
    enableServices: (services) => m11.enableServices(services),
    projectIam: () => m11.projectIam(),
    wait: (ms) => delay(ms),
    async setUp(approval, runId) {
      const context = await m11.setUp(approval, runId);
      const n = m12Names(project, approval.prefix, runId);
      for (const [account, label] of [
        [n.worker, "deployment worker (controller)"],
        [n.invoker, "controller queue invoker"],
      ])
        await api(`${IAM}/projects/${project}/serviceAccounts`, "POST", {
          accountId: account.id,
          serviceAccount: { displayName: `Embody M12 qualification ${label} (disposable)` },
        });
      // Platform database: zonal db-f1-micro, no authorized networks, TLS only, no backups.
      const adminPassword = randomBytes(24).toString("base64url");
      const created = await api(`${SQL}/projects/${project}/instances`, "POST", {
        name: n.sql,
        databaseVersion: "POSTGRES_16",
        region: REGION,
        rootPassword: adminPassword,
        settings: {
          tier: "db-f1-micro",
          edition: "ENTERPRISE",
          availabilityType: "ZONAL",
          dataDiskType: "PD_HDD",
          dataDiskSizeGb: "10",
          backupConfiguration: { enabled: false },
          ipConfiguration: { ipv4Enabled: true, authorizedNetworks: [], sslMode: "ENCRYPTED_ONLY" },
          userLabels: { embody: "m12-qualification", run: runId },
        },
      });
      await waitOperation(created, `${SQL}/projects/${project}/operations`, 240);
      // The insert operation can finish before the instance accepts connections (run 74cea3
      // saw PENDING_CREATE and ephemeral-certificate 409s): wait for RUNNABLE itself.
      for (let i = 0; ; i++) {
        const state = (await api(`${SQL}/projects/${project}/instances/${n.sql}`))?.state;
        if (state === "RUNNABLE") break;
        if (i >= 240) throw new Error(`Cloud SQL instance not runnable (${state})`);
        await delay(5000);
      }
      // Controller queue.
      await api(`${TASKS}/projects/${project}/locations/${REGION}/queues`, "POST", {
        name: `projects/${project}/locations/${REGION}/queues/${n.queue}`,
        ...QUEUE_LIMITS,
      });
      // Secret for the worker's runtime database URL (version added once the roles exist).
      await api(`${SECRETS}/projects/${project}/secrets?secretId=${n.secret}`, "POST", {
        replication: { automatic: {} },
        labels: { embody: "m12-qualification", run: runId },
      });
      // Worker (controller) grants: the M11 controller set plus the queue, secret and SQL client.
      const worker = sa(n.worker.email);
      await projectPolicy((policy) => {
        for (const role of PROJECT_ROLES)
          policy.bindings = [...(policy.bindings ?? []), { role, members: [worker] }];
      });
      const saPolicy = (email) => [
        `${IAM}/projects/-/serviceAccounts/${email}:getIamPolicy`,
        `${IAM}/projects/-/serviceAccounts/${email}:setIamPolicy`,
      ];
      await addBinding(...saPolicy(context.builder.email), "roles/iam.serviceAccountUser", worker, {
        post: true,
      });
      await addBinding(
        ...saPolicy(context.reader.email),
        "roles/iam.serviceAccountTokenCreator",
        worker,
        { post: true },
      );
      await addBinding(...saPolicy(n.invoker.email), "roles/iam.serviceAccountUser", worker, {
        post: true,
      });
      // Cloud Tasks mints the invoker's OIDC token (M09); the operator plays the gateway
      // (actAs as project owner) and mints test ID tokens for the invoker and the runtime.
      await addBinding(
        ...saPolicy(n.invoker.email),
        "roles/iam.serviceAccountUser",
        `serviceAccount:service-${projectNumber}@gcp-sa-cloudtasks.iam.gserviceaccount.com`,
        { post: true },
      );
      const operator = await (async () => {
        const { stdout } = await exec("gcloud", ["config", "get-value", "account"]);
        const account = stdout.trim();
        return account.endsWith(".gserviceaccount.com")
          ? `serviceAccount:${account}`
          : `user:${account}`;
      })();
      for (const email of [n.invoker.email, context.runtime.email])
        await addBinding(...saPolicy(email), "roles/iam.serviceAccountTokenCreator", operator, {
          post: true,
        });
      const repo = `projects/${project}/locations/${REGION}/repositories/${context.buildsRepo}`;
      await addBinding(
        `${AR}/${repo}:getIamPolicy`,
        `${AR}/${repo}:setIamPolicy`,
        "roles/artifactregistry.repoAdmin",
        worker,
      );
      for (const bucket of [context.outputBucket, context.logsBucket])
        await eventually(async () => {
          const policy = await api(`${STORAGE}/b/${bucket}/iam`);
          policy.bindings = [
            ...(policy.bindings ?? []),
            { role: "roles/storage.objectAdmin", members: [worker] },
          ];
          await api(`${STORAGE}/b/${bucket}/iam`, "PUT", policy);
        });
      const queuePath = `${TASKS}/projects/${project}/locations/${REGION}/queues/${n.queue}`;
      await addBinding(
        `${queuePath}:getIamPolicy`,
        `${queuePath}:setIamPolicy`,
        "roles/cloudtasks.enqueuer",
        worker,
        { post: true },
      );
      const secretPath = `${SECRETS}/projects/${project}/secrets/${n.secret}`;
      await addBinding(
        `${secretPath}:getIamPolicy`,
        `${secretPath}:setIamPolicy`,
        "roles/secretmanager.secretAccessor",
        worker,
      );
      return {
        ...context,
        ...n,
        adminPassword,
        connection: `${project}:${REGION}:${n.sql}`,
        projectNumber,
        queuePath: `projects/${project}/locations/${REGION}/queues/${n.queue}`,
      };
    },
    pushRecipe: (context, dir) => m11.pushRecipe(context, dir),
    /** Builds the repository image (Dockerfile.m05) for linux/amd64 and pushes it by digest. */
    async pushWorker(context) {
      const config = await mkdtemp(join(tmpdir(), "embody-m12-docker-"));
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
        const { stdout: sha } = await exec("git", ["rev-parse", "HEAD"]);
        const tag = `${repoHost}/${project}/${context.recipeRepo}/worker:m12`;
        await new Promise((resolve, reject) => {
          const child = spawn(
            "docker",
            [
              "buildx",
              "build",
              "--platform",
              "linux/amd64",
              "--provenance=false",
              "-q",
              "--push",
              "-f",
              "Dockerfile.m05",
              "--build-arg",
              `EMBODY_SOURCE_SHA=${sha.trim()}`,
              "-t",
              tag,
              ".",
            ],
            {
              stdio: ["ignore", "ignore", "pipe"],
              env: { ...process.env, DOCKER_CONFIG: config, DOCKER_HOST: dockerHost.trim() },
            },
          );
          child.stderr.on("data", () => undefined);
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`worker image build failed (${code})`)),
          );
        });
        const images = await api(
          `${AR}/projects/${project}/locations/${REGION}/repositories/${context.recipeRepo}/dockerImages?pageSize=50`,
        );
        const image = (images?.dockerImages ?? []).find(
          (i) => i.uri.includes("/worker@") && (i.tags ?? []).includes("m12"),
        );
        if (!image) throw new Error("Worker image not found after push");
        return image.uri;
      } finally {
        await rm(config, { recursive: true, force: true });
      }
    },
    /**
     * Local Cloud SQL Auth Proxy (operator credentials), restricted maintenance/runtime roles as
     * in the M03 fixture, platform migrations, fixture tables, and the worker's secret.
     */
    async prepareDatabase(context, approval) {
      const port = await freePort();
      proxy = spawn(
        approval.proxy,
        ["--gcloud-auth", `--port=${port}`, "--address=127.0.0.1", context.connection],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      // Sanitized diagnostics only: HTTP status codes and the exit code, never the output.
      const proxyStatus = { exit: null, statuses: [], line: "" };
      const watch = (chunk) => {
        for (const match of String(chunk).matchAll(/\b(400|401|403|404|409|429|500|503)\b/g))
          if (!proxyStatus.statuses.includes(match[1])) proxyStatus.statuses.push(match[1]);
        const failure = String(chunk)
          .split("\n")
          .find((l) => /error|failed|denied/i.test(l));
        if (failure && !proxyStatus.line)
          proxyStatus.line = failure
            .replace(/[\w.%+-]+@[\w.-]+/g, "<account>")
            .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<ip>")
            .replace(/(password|token)\S*/gi, "<redacted>")
            .slice(-240);
      };
      proxy.stdout.on("data", watch);
      proxy.stderr.on("data", watch);
      proxy.on("exit", (code) => (proxyStatus.exit = code));
      const { Pool } = createRequire(
        new URL("../../../packages/gateway/package.json", import.meta.url),
      )("pg");
      const local = (user, password, database) =>
        `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
      const admin = new Pool({
        connectionString: local("postgres", context.adminPassword, "postgres"),
        max: 1,
      });
      for (let i = 0; ; i++) {
        try {
          await admin.query("SELECT 1");
          break;
        } catch (error) {
          if (i > 60)
            throw new Error(
              `Cloud SQL proxy unavailable (pg ${error?.code ?? "?"}, proxy exit ${proxyStatus.exit}, statuses ${proxyStatus.statuses.join("/") || "none"}, state ${(await api(`${SQL}/projects/${project}/instances/${context.sql}`))?.state}: ${proxyStatus.line})`,
            );
          await delay(3000);
        }
      }
      const migratorPassword = randomBytes(24).toString("base64url");
      const runtimePassword = randomBytes(24).toString("base64url");
      try {
        await admin.query(
          `CREATE ROLE embody_platform_migrator LOGIN PASSWORD '${migratorPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
        );
        await admin.query(
          `CREATE ROLE embody_platform_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
        );
        await admin.query("GRANT embody_platform_migrator TO postgres");
        await admin.query("CREATE DATABASE embody_platform OWNER embody_platform_migrator");
        await admin.query("REVOKE ALL ON DATABASE embody_platform FROM PUBLIC");
        await admin.query("GRANT CONNECT ON DATABASE embody_platform TO embody_platform_runtime");
      } finally {
        await admin.end();
      }
      const migrationUrl = local("embody_platform_migrator", migratorPassword, "embody_platform");
      const runtimeUrl = local("embody_platform_runtime", runtimePassword, "embody_platform");
      const owner = new Pool({ connectionString: migrationUrl, max: 1 });
      try {
        await owner.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
        await owner.query("GRANT USAGE ON SCHEMA public TO embody_platform_runtime");
      } finally {
        await owner.end();
      }
      const migrator = new gateway.PostgresGatewayStore(migrationUrl);
      await migrator.migrate();
      await migrator.close();
      const grant = new Pool({ connectionString: migrationUrl, max: 1 });
      try {
        const tables = await grant.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'embody_platform_%'",
        );
        for (const { tablename } of tables.rows)
          await grant.query(
            `GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public."${tablename}" TO embody_platform_runtime`,
          );
      } finally {
        await grant.end();
      }
      const fixtures = await import("../../../packages/gateway/test/fixtures/m12-fixtures.mjs");
      await fixtures.createFixtureTables(migrationUrl, "embody_platform_runtime");
      const workerUrl = `postgresql://embody_platform_runtime:${encodeURIComponent(runtimePassword)}@localhost/embody_platform`;
      await api(`${SECRETS}/projects/${project}/secrets/${context.secret}:addVersion`, "POST", {
        payload: { data: Buffer.from(workerUrl).toString("base64") },
      });
      const pool = new Pool({ connectionString: runtimeUrl, max: 2 });
      return {
        runtimeUrl,
        async plantFaults(deploymentId, points) {
          for (const point of points)
            await pool.query(
              "INSERT INTO m12_fixture_faults (deployment_key, point) VALUES ($1, $2) ON CONFLICT DO NOTHING",
              [deploymentId, point],
            );
        },
        async faultsFired(deploymentId) {
          return (
            await pool.query(
              "SELECT count(*)::int AS n FROM m12_fixture_faults WHERE deployment_key = $1 AND fired IS NOT NULL",
              [deploymentId],
            )
          ).rows[0].n;
        },
        async candidates(workspaceId) {
          return (
            await pool.query(
              "SELECT count(*)::int AS n FROM m12_fixture_resources WHERE labels->>'workspace' = $1",
              [workspaceId],
            )
          ).rows[0].n;
        },
        close: () => pool.end(),
      };
    },
    /**
     * The worker service: controller identity, Cloud SQL socket, scale to zero, at most two
     * instances. Ingress is ALL plus Cloud Run IAM so the suite can probe it from outside;
     * production uses internal ingress (Cloud Tasks reaches it, M09).
     */
    async deployWorker(context, { image, recipe }) {
      const parent = `projects/${project}/locations/${REGION}`;
      const url = `https://${context.service}-${context.projectNumber}.${REGION}.run.app`;
      const taskUrl = `${url}/_embody/tasks/deployment`;
      const env = {
        EMBODY_M12_RECIPE: JSON.stringify(recipe),
        EMBODY_M12_SOURCE_BUCKET: context.sourceBucket,
        EMBODY_M12_READ_SIGNER: context.reader.email,
        EMBODY_M12_QUEUE: context.queuePath,
        EMBODY_M12_TASK_URL: taskUrl,
        EMBODY_M12_INVOKER: context.invoker.email,
        EMBODY_SQL_CONNECTION: context.connection,
      };
      const created = await eventually(() =>
        api(`${RUN}/${parent}/services?serviceId=${context.service}`, "POST", {
          labels: { embody: "m12-qualification" },
          ingress: "INGRESS_TRAFFIC_ALL",
          template: {
            serviceAccount: context.worker.email,
            timeout: "60s",
            maxInstanceRequestConcurrency: 4,
            scaling: { minInstanceCount: 0, maxInstanceCount: 2 },
            volumes: [{ name: "cloudsql", cloudSqlInstance: { instances: [context.connection] } }],
            containers: [
              {
                image,
                command: ["node"],
                args: ["infra/mvp/m12/worker.mjs"],
                env: [
                  ...Object.entries(env).map(([name, value]) => ({ name, value })),
                  {
                    name: "EMBODY_PLATFORM_URL",
                    valueSource: {
                      secretKeyRef: { secret: context.secret, version: "latest" },
                    },
                  },
                ],
                resources: { limits: { cpu: "1", memory: "512Mi" }, cpuIdle: true },
                volumeMounts: [{ name: "cloudsql", mountPath: "/cloudsql" }],
              },
            ],
          },
        }),
      );
      await waitOperation(created, RUN, 120);
      const service = `${RUN}/${parent}/services/${context.service}`;
      await addBinding(
        `${service}:getIamPolicy`,
        `${service}:setIamPolicy`,
        "roles/run.invoker",
        sa(context.invoker.email),
      );
      return { url, taskUrl };
    },
    putSource: (context, key, bytes) => m11.putSource(context, key, bytes),
    /** The operator as the gateway: creates OIDC tasks for the worker as the invoker. */
    tasksQueue(context, worker) {
      return {
        async enqueue(task) {
          const host = await import("../../../packages/host/dist/index.js");
          return host
            .cloudTasksQueue({
              queue: context.queuePath,
              url: worker.taskUrl,
              audience: worker.taskUrl,
              invokerEmail: context.invoker.email,
              accessToken,
            })
            .enqueue(task);
        },
      };
    },
    async pauseQueue(context) {
      await api(`${TASKS}/${context.queuePath}:pause`, "POST", {});
    },
    async resumeQueue(context) {
      await api(`${TASKS}/${context.queuePath}:resume`, "POST", {});
    },
    /** Every role the worker and the invoker hold on the project and the run's resources. */
    async workerBindings(context) {
      const out = [];
      const collect = (where, policy) => {
        for (const binding of policy?.bindings ?? [])
          for (const [who, email] of [
            ["worker", context.worker.email],
            ["invoker", context.invoker.email],
          ])
            if (binding.members.includes(sa(email))) out.push(`${who}|${where}:${binding.role}`);
      };
      collect("project", await api(`${CRM}/projects/${project}:getIamPolicy`, "POST", {}));
      for (const [where, email] of [
        ["builder", context.builder.email],
        ["reader", context.reader.email],
        ["invoker", context.invoker.email],
        ["runtime", context.runtime.email],
      ])
        collect(
          where,
          await api(`${IAM}/projects/-/serviceAccounts/${email}:getIamPolicy`, "POST", {}),
        );
      collect(
        "buildsRepo",
        await api(
          `${AR}/projects/${project}/locations/${REGION}/repositories/${context.buildsRepo}:getIamPolicy`,
        ),
      );
      collect("outputBucket", await api(`${STORAGE}/b/${context.outputBucket}/iam`));
      collect("logsBucket", await api(`${STORAGE}/b/${context.logsBucket}/iam`));
      collect("sourceBucket", await api(`${STORAGE}/b/${context.sourceBucket}/iam`));
      collect("queue", await api(`${TASKS}/${context.queuePath}:getIamPolicy`, "POST", {}));
      collect(
        "secret",
        await api(`${SECRETS}/projects/${project}/secrets/${context.secret}:getIamPolicy`),
      );
      collect(
        "service",
        await api(
          `${RUN}/projects/${project}/locations/${REGION}/services/${context.service}:getIamPolicy`,
        ),
      );
      return out.sort();
    },
    /** Google-signed ID tokens: the operator's own, or minted for the invoker or runtime. */
    async idToken(context, audience, who) {
      if (who === "operator") {
        const { stdout } = await exec("gcloud", ["auth", "print-identity-token"]);
        return stdout.trim();
      }
      const email = who === "invoker" ? context.invoker.email : context.runtime.email;
      const result = await eventually(() =>
        api(
          `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${email}:generateIdToken`,
          "POST",
          {
            audience,
            includeEmail: true,
          },
        ),
      );
      return result.token;
    },
    async postTask(url, idToken, body, withOutcome = false) {
      const response = await baseFetch(url, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...(idToken ? { authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!withOutcome) return response.status;
      const parsed = await response.json().catch(() => ({}));
      return { status: response.status, outcome: parsed.outcome };
    },
    async buildStatus(buildId) {
      const build = await api(
        `https://cloudbuild.googleapis.com/v1/projects/${project}/locations/${REGION}/builds/${buildId}`,
      );
      return build?.status ?? "missing";
    },
    async buildsByTag(tag) {
      const body = await api(
        `https://cloudbuild.googleapis.com/v1/projects/${project}/locations/${REGION}/builds?pageSize=10&filter=${encodeURIComponent(`tags="${tag}"`)}`,
      );
      return (body?.builds ?? []).map((b) => b.id);
    },
    buildMinutes: (ids) => m11.buildMinutes(ids),
    async tearDown(approval, runId, context) {
      const n = m12Names(project, approval.prefix, runId);
      const removed = [];
      proxy?.kill();
      const service = `${RUN}/projects/${project}/locations/${REGION}/services/${n.service}`;
      if (await api(service)) {
        await waitOperation(await api(service, "DELETE"), RUN, 60);
        removed.push("service");
      }
      const queue = `${TASKS}/projects/${project}/locations/${REGION}/queues/${n.queue}`;
      if (await api(queue)) {
        await api(queue, "DELETE");
        removed.push("queue");
      }
      const secret = `${SECRETS}/projects/${project}/secrets/${n.secret}`;
      if (await api(secret)) {
        await api(secret, "DELETE");
        removed.push("secret");
      }
      const instance = `${SQL}/projects/${project}/instances/${n.sql}`;
      if (await api(instance)) {
        await waitOperation(
          await api(instance, "DELETE"),
          `${SQL}/projects/${project}/operations`,
          240,
        );
        removed.push("sql");
      }
      // Project grants go before the identity, or they linger as deleted:serviceAccount members.
      await projectPolicy((policy) => {
        for (const binding of policy.bindings ?? [])
          binding.members = binding.members.filter(
            (member) => member !== sa(n.worker.email) && member !== `deleted:${sa(n.worker.email)}`,
          );
        policy.bindings = (policy.bindings ?? []).filter((binding) => binding.members.length);
      });
      for (const account of [n.worker, n.invoker])
        if (await api(`${IAM}/projects/${project}/serviceAccounts/${account.email}`)) {
          await api(`${IAM}/projects/${project}/serviceAccounts/${account.email}`, "DELETE");
          removed.push(`serviceAccount:${account.id}`);
        }
      const m11Teardown = await m11.tearDown(approval, runId, context);
      return { pass: m11Teardown.pass === true, removed: [...removed, ...m11Teardown.removed] };
    },
    async inventory(approval, runId) {
      const leftovers = [...(await m11.inventory(approval, runId))];
      const instances = await api(`${SQL}/projects/${project}/instances`);
      for (const item of instances?.items ?? [])
        if (item.name.startsWith(`${approval.prefix}-sql-`)) leftovers.push(`sql:${item.name}`);
      const services = await api(`${RUN}/projects/${project}/locations/${REGION}/services`);
      for (const item of services?.services ?? [])
        if (item.name.split("/").pop().startsWith(`${approval.prefix}-worker-`))
          leftovers.push(`service:${item.name.split("/").pop()}`);
      const queues = await api(`${TASKS}/projects/${project}/locations/${REGION}/queues`);
      for (const item of queues?.queues ?? [])
        if (item.name.split("/").pop().startsWith(`${approval.prefix}-deploy-`))
          leftovers.push(`queue:${item.name.split("/").pop()}`);
      const secrets = await api(`${SECRETS}/projects/${project}/secrets`);
      for (const item of secrets?.secrets ?? [])
        if (item.name.split("/").pop().startsWith(`${approval.prefix}-dburl-`))
          leftovers.push(`secret:${item.name.split("/").pop()}`);
      const accounts = await api(`${IAM}/projects/${project}/serviceAccounts?pageSize=100`);
      for (const account of accounts?.accounts ?? [])
        if (
          /^[a-z0-9-]+-(c|i)-[a-f0-9]{6}@/.test(account.email) &&
          account.email.startsWith(`${approval.prefix}-`)
        )
          leftovers.push(`serviceAccount:${account.email}`);
      const policy = await api(`${CRM}/projects/${project}:getIamPolicy`, "POST", {});
      for (const binding of policy?.bindings ?? [])
        for (const member of binding.members)
          if (member.includes(`${approval.prefix}-c-`))
            leftovers.push(`projectBinding:${binding.role}`);
      return leftovers;
    },
  };
}
