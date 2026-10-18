// Real Google Cloud provider for the M09 suite (operator credentials). Every resource it creates
// carries the run's prefix/run ID and is removed by tearDown; inventory lists what remains by
// owned names only, never by broad project listing. Errors never include provider bodies.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { URL, URLSearchParams } from "node:url";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { createCloudRunAppProvisioner } from "../provider/cloud-run.mjs";
import { createWakeQueueProvisioner, wakeResourceNames } from "../provider/cloud-tasks.mjs";
import { taskBody } from "./queue-probe.mjs";
import { qualificationEstimate } from "./costs.mjs";
import {
  SQL_LIMITS,
  bootstrapStatements,
  schemaStatements,
  fixturePasswords,
  evaluateStorm,
  evaluateConnectDenials,
  evaluateRestore,
  FIXTURE_ROLES,
  dropStatements,
  releaseStatements,
} from "./sql.mjs";
const exec = promisify(execFile);
const { fetch, AbortSignal, AbortController, Response } = globalThis;
const MARKER = "embody-m09-qualification";
const PRIVATE = join(tmpdir(), "embody-m09-private");

/** Operator access token from the gcloud login or ADC; never printed or stored. */
export async function operatorToken(credentials = "adc") {
  const args =
    credentials === "gcloud"
      ? ["auth", "print-access-token"]
      : ["auth", "application-default", "print-access-token"];
  const { stdout } = await exec("gcloud", args);
  return stdout.trim();
}

/**
 * fetch with a hard deadline that covers the whole body. A live run hung for hours on one
 * provider call even with AbortSignal.timeout, so this races a referenced timer as well and
 * returns a fully buffered Response.
 */
export function deadlineFetch(fetcher = fetch, deadlineMs = 60_000, backoffMs = 5_000) {
  const once = deadlineFetchOnce(fetcher, deadlineMs);
  // 429 means the provider did not process the request, so any method may retry it.
  return async (url, options = {}) => {
    for (let attempt = 0; ; attempt++) {
      const response = await once(url, options);
      if (response.status !== 429 || attempt === 4) return response;
      await delay(backoffMs * 2 ** attempt);
    }
  };
}
function deadlineFetchOnce(fetcher, deadlineMs) {
  return async (url, options = {}) => {
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Provider ${options.method ?? "GET"} ${new URL(url).host} failed (0); details suppressed`,
        );
        controller.abort(error);
        reject(error);
      }, deadlineMs);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(url, { ...options, signal: controller.signal });
          const body = await response.arrayBuffer();
          return new Response(response.status === 204 ? null : body, {
            status: response.status,
            headers: response.headers,
          });
        })(),
        expired,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createGcpProvider({
  baseline,
  image,
  credentials = "adc",
  token = () => operatorToken(credentials),
  fetcher: rawFetch = fetch,
  now = () => new Date(),
}) {
  const { project, region, prefix } = baseline;
  if (
    region !== "us-central1" ||
    !/^[a-z0-9-]+-docker\.pkg\.dev\/.+@sha256:[a-f0-9]{64}$/.test(image ?? "")
  )
    throw new Error("M09 provider needs the baseline output and an immutable fixture image digest");
  const fetcher = deadlineFetch(rawFetch);
  const run = `https://run.googleapis.com/v2/projects/${project}/locations/${region}`;
  const tasksApi = `https://cloudtasks.googleapis.com/v2/projects/${project}/locations/${region}/queues`;
  const sqlApi = `https://sqladmin.googleapis.com/v1/projects/${project}/instances/${prefix}-postgres`;
  let cached;
  const accessToken = async () => {
    // gcloud may return a token close to expiry, so keep it only briefly.
    if (!cached || cached.until < Date.now())
      cached = { value: await token(), until: Date.now() + 3 * 60_000 };
    return cached.value;
  };
  // Reads (GET, IAM policy reads, log/metric listing) are retried on timeouts and 5xx.
  async function api(url, method = "GET", body, options = {}) {
    const idempotent =
      method === "GET" || /:getIamPolicy$|entries:list$/.test(new URL(url).pathname);
    for (let attempt = 0; ; attempt++) {
      try {
        return await apiOnce(url, method, body, options);
      } catch (error) {
        // An expired token was not used for anything: refresh it and retry any method once.
        if (/failed \(401\)/.test(error.message) && attempt === 0) {
          cached = undefined;
          continue;
        }
        const transient = /failed \((0|5\d\d)\)/.test(error.message);
        if (!idempotent || !transient || attempt === 2) throw error;
        await delay(5000 * (attempt + 1));
      }
    }
  }
  async function apiOnce(url, method, body, { allow = [] } = {}) {
    let response;
    try {
      response = await fetcher(url, {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(`Provider ${method} ${new URL(url).host} failed (0); details suppressed`);
    }
    if (allow.includes(response.status)) return { status: response.status };
    if (response.status === 404 && ["GET", "DELETE"].includes(method)) return null;
    if (!response.ok)
      throw new Error(
        `Provider ${method} ${new URL(url).host} failed (${response.status}); body suppressed`,
      );
    return response.status === 204 ? {} : response.json().catch(() => ({}));
  }
  async function operation(result, base) {
    for (let attempt = 0; attempt < 120 && result && !result.done; attempt++) {
      await delay(5000);
      result = await api(`${base}/${result.name}`);
    }
    if (!result?.done || result.error)
      throw new Error("Provider operation failed or timed out; reconcile by owned names");
    return result.response;
  }
  const apps = createCloudRunAppProvisioner({
    project,
    region,
    prefix,
    gatewayEmail: `${prefix}-gateway@${project}.iam.gserviceaccount.com`,
    accessToken,
    fetcher,
  });
  const wake = createWakeQueueProvisioner({
    project,
    region,
    prefix,
    accessToken,
    logSampling: 1,
    fetcher,
  });
  const scopes = (runId) => ({
    own: { workspaceId: `ws_m09${runId}a`, appId: "wake" },
    other: { workspaceId: `ws_m09${runId}b`, appId: "wake" },
  });
  const urlOf = (service) => `https://${service}-${baseline.project_number}.${region}.run.app`;
  const names = (scope) => wakeResourceNames({ ...scope, project, prefix });

  async function logs(filter, since) {
    const entries = [];
    let pageToken;
    do {
      const page = await api("https://logging.googleapis.com/v2/entries:list", "POST", {
        resourceNames: [`projects/${project}`],
        filter: `${filter} AND timestamp>="${since}"`,
        orderBy: "timestamp asc",
        pageSize: 1000,
        ...(pageToken ? { pageToken } : {}),
      });
      entries.push(...(page.entries ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && entries.length < 10_000);
    return entries;
  }
  const serviceFilter = (service) =>
    `resource.type="cloud_run_revision" AND resource.labels.service_name="${service}"`;

  async function deployTarget(scope, runId) {
    const n = names(scope);
    const audience = urlOf(n.service);
    const body = {
      // The Cloud Run adapter's ownership labels, so its remove() can delete this service.
      labels: {
        managed_by: "embody-m05-app-adapter",
        fixture: prefix,
        workspace: createHash("sha256").update(scope.workspaceId).digest("hex").slice(0, 32),
        app: scope.appId,
        run: runId,
      },
      ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
      invokerIamDisabled: false,
      template: {
        serviceAccount: `${n.runtime}@${project}.iam.gserviceaccount.com`,
        scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
        maxInstanceRequestConcurrency: 4,
        timeout: "60s",
        containers: [
          {
            image,
            command: ["node", "infra/mvp/m09/wake-target.mjs"],
            ports: [{ containerPort: 8080 }],
            resources: { limits: { cpu: "1", memory: "512Mi" }, cpuIdle: true },
            env: [
              { name: "EMBODY_DRAIN_AUDIENCE", value: audience },
              {
                name: "EMBODY_DRAIN_INVOKER_EMAIL",
                value: `${n.invoker}@${project}.iam.gserviceaccount.com`,
              },
            ],
          },
        ],
      },
    };
    await operation(
      await api(`${run}/services?serviceId=${n.service}`, "POST", body),
      "https://run.googleapis.com/v2",
    );
    return audience;
  }

  return {
    now,
    wait: (ms) => delay(ms),
    async projectedCostUsd() {
      return qualificationEstimate({
        sqlHours: 24,
        serviceActiveSeconds: 2 * 4 * 3600,
        jobSeconds: 3600,
        taskOperations: 10_000,
        backupGiBHours: 48,
        logGiB: 0.5,
      }).estimatedUpperUsd;
    },
    async preflight(approval) {
      if (approval.project !== project || approval.prefix !== prefix)
        throw new Error("Baseline output does not match the approved project/prefix");
      const instance = await api(sqlApi);
      const repo = await api(`https://artifactregistry.googleapis.com/v1/${baseline.repository}`);
      const checks = {
        sqlRunnable: instance?.state === "RUNNABLE",
        sqlZonalSharedCore:
          instance?.settings?.availabilityType === "ZONAL" &&
          /^db-(f1-micro|g1-small)$/.test(instance?.settings?.tier ?? ""),
        sqlNoAuthorizedNetworks:
          (instance?.settings?.ipConfiguration?.authorizedNetworks ?? []).length === 0,
        sqlEncryptedOnly: instance?.settings?.ipConfiguration?.sslMode === "ENCRYPTED_ONLY",
        sqlBackups: instance?.settings?.backupConfiguration?.enabled === true,
        repository: repo?.format === "DOCKER",
      };
      return { checks, pass: Object.values(checks).every(Boolean) };
    },
    async setUp({ runId }) {
      const { own, other } = scopes(runId);
      const fixture = {
        runId,
        own: names(own),
        other: names(other),
        createdAt: now().toISOString(),
        jobs: [],
      };
      await writePrivate(runId, { runId });
      for (const scope of [own, other]) await apps.prepare(scope);
      for (const scope of [own, other]) await deployTarget(scope, runId);
      const ownWake = await wake.prepare(own);
      const otherWake = await wake.prepare(other);
      // IAM grants can take minutes to apply, and deployment readiness checks may start an
      // instance; the probe and isolation are judged after settling.
      await delay(300_000);
      fixture.settledAt = now().toISOString();
      fixture.probe = {
        ownQueue: ownWake.queue,
        otherQueue: otherWake.queue,
        ownInvoker: ownWake.invokerEmail,
        otherInvoker: otherWake.invokerEmail,
        ownUrl: urlOf(fixture.own.service),
        otherUrl: urlOf(fixture.other.service),
        platformDbSecret: baseline.secret_names["platform-db"],
        signerSecret: baseline.secret_names.signer,
        otherAppSecret: `projects/${project}/secrets/${fixture.other.databaseSecret}`,
        gatewayEmail: baseline.identities.gateway,
        sqlInstance: `projects/${project}/instances/${prefix}-postgres`,
      };
      return fixture;
    },
    async runQueueProbe(fixture, config) {
      const job = `${prefix}-qprobe-${fixture.runId}`;
      fixture.jobs.push(job);
      const body = {
        labels: { managed_by: MARKER, fixture: prefix, run: fixture.runId },
        template: {
          taskCount: 1,
          template: {
            maxRetries: 0,
            timeout: "300s",
            serviceAccount: `${fixture.own.runtime}@${project}.iam.gserviceaccount.com`,
            containers: [
              {
                image,
                command: ["node", "infra/mvp/m09/queue-probe.mjs"],
                resources: { limits: { cpu: "1", memory: "512Mi" } },
                env: [{ name: "EMBODY_M09_PROBE", value: JSON.stringify(config) }],
              },
            ],
          },
        },
      };
      await operation(
        await api(`${run}/jobs?jobId=${job}`, "POST", body),
        "https://run.googleapis.com/v2",
      );
      const since = now().toISOString();
      // A failing probe exits nonzero and fails the execution; its report is still in the logs.
      await operation(
        await api(`${run}/jobs/${job}:run`, "POST", {}),
        "https://run.googleapis.com/v2",
      ).catch(() => undefined);
      for (let attempt = 0; attempt < 12; attempt++) {
        const entries = await logs(
          `resource.type="cloud_run_job" AND resource.labels.job_name="${job}" AND jsonPayload.message="embody.m09.queueProbe"`,
          since,
        );
        if (entries.length) return entries.at(-1).jsonPayload;
        await delay(10_000);
      }
      return null;
    },
    async wakes(fixture, which) {
      const entries = await logs(
        `${serviceFilter(fixture[which].service)} AND jsonPayload.message="embody.m09.wake"`,
        fixture.createdAt,
      );
      return entries.map((entry) => entry.jsonPayload);
    },
    async starts(fixture, which) {
      const entries = await logs(
        // Cloud Run's own system log records every instance start, whatever the app does.
        `${serviceFilter(fixture[which].service)} AND logName="projects/${project}/logs/run.googleapis.com%2Fvarlog%2Fsystem" AND textPayload:"Starting new instance"`,
        fixture.createdAt,
      );
      return entries.map((entry) => entry.timestamp);
    },
    async requests(fixture, which) {
      const entries = await logs(
        `${serviceFilter(fixture[which].service)} AND logName="projects/${project}/logs/run.googleapis.com%2Frequests"`,
        fixture.createdAt,
      );
      return entries.map((entry) => ({
        at: entry.timestamp,
        status: entry.httpRequest?.status ?? 0,
      }));
    },
    async instanceSeries(fixture, which, since) {
      const query = new URLSearchParams({
        filter: `metric.type="run.googleapis.com/container/instance_count" AND resource.labels.service_name="${fixture[which].service}"`,
        "interval.startTime": since,
        "interval.endTime": now().toISOString(),
        "aggregation.alignmentPeriod": "60s",
        "aggregation.perSeriesAligner": "ALIGN_MAX",
        "aggregation.crossSeriesReducer": "REDUCE_SUM",
        "aggregation.groupByFields": "resource.labels.service_name",
      });
      const result = await api(
        `https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${query}`,
      );
      return (result.timeSeries ?? []).flatMap((series) =>
        // Gauge points are instants; each aligned point stands for the minute ending at it.
        (series.points ?? []).map((point) => ({
          start: new Date(Date.parse(point.interval.endTime) - 60_000).toISOString(),
          end: point.interval.endTime,
          value: Number(point.value.int64Value ?? point.value.doubleValue ?? NaN),
        })),
      );
    },
    async serviceConfig(fixture, which) {
      const service = await api(`${run}/services/${fixture[which].service}`);
      const revision = await api(`https://run.googleapis.com/v2/${service.latestReadyRevision}`);
      return { service: { ...service, scaling: service.scaling }, revision };
    },
    async recreateTask(fixture, name) {
      const { status } = await api(
        `${tasksApi}/${fixture.own.queue}/tasks`,
        "POST",
        taskBody({
          queue: fixture.probe.ownQueue,
          name,
          url: fixture.probe.ownUrl,
          invoker: fixture.probe.ownInvoker,
          probe: "own-now",
        }),
        { allow: [200, 409] },
      );
      return status;
    },
    async enqueueOperatorTask(fixture, probe) {
      await api(
        `${tasksApi}/${fixture.own.queue}/tasks`,
        "POST",
        taskBody({
          queue: fixture.probe.ownQueue,
          name: `m09-${fixture.runId}-${probe}-${randomBytes(6).toString("hex")}`,
          url: fixture.probe.ownUrl,
          invoker: fixture.probe.ownInvoker,
          probe,
        }),
      );
    },
    pause: (fixture) => wake.pause(scopes(fixture.runId).own),
    resume: (fixture) => wake.resume(scopes(fixture.runId).own),
    async externalCalls(fixture) {
      const before = (await this.wakes(fixture, "own")).length;
      const call = async (headers) =>
        (
          await fetcher(`${fixture.probe.ownUrl}/_embody/drain`, {
            method: "POST",
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify({ probe: "external" }),
          })
        ).status;
      const anonymous = await call({});
      // A valid Google access token that is not the platform invoker's OIDC token.
      const operator = await call({ authorization: `Bearer ${await accessToken()}` });
      await delay(60_000);
      const reached = (await this.wakes(fixture, "own")).length - before;
      return {
        anonymous,
        operator,
        reachedTarget: reached,
        pass: [403, 404].includes(anonymous) && [401, 403, 404].includes(operator) && reached === 0,
      };
    },
    async iamInventory(fixture) {
      const builder = `${prefix}-builder@${project}.iam.gserviceaccount.com`;
      const policies = [
        {
          resource: `projects/${project}`,
          policy: await api(
            `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`,
            "POST",
            { options: { requestedPolicyVersion: 3 } },
          ),
        },
        {
          resource: baseline.repository,
          policy: await api(
            `https://artifactregistry.googleapis.com/v1/${baseline.repository}:getIamPolicy`,
          ),
        },
      ];
      for (const secret of Object.values(baseline.secret_names ?? {}))
        policies.push({
          resource: secret,
          policy: await api(`https://secretmanager.googleapis.com/v1/${secret}:getIamPolicy`),
        });
      for (const which of ["own", "other"]) {
        const n = fixture[which];
        policies.push(
          {
            resource: `queue/${n.queue}`,
            policy: await api(`${tasksApi}/${n.queue}:getIamPolicy`, "POST", {}),
          },
          {
            resource: `service/${n.service}`,
            policy: await api(`${run}/services/${n.service}:getIamPolicy`),
          },
          {
            resource: `secret/${n.databaseSecret}`,
            policy: await api(
              `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${n.databaseSecret}:getIamPolicy`,
            ),
          },
        );
      }
      return { policies, builder, repository: baseline.repository };
    },
    sql: (fixture) => qualifySql(fixture),
    async tearDown(fixture) {
      for (const job of fixture.jobs ?? [`${prefix}-qprobe-${fixture.runId}`]) {
        const deletion = await api(`${run}/jobs/${job}`, "DELETE");
        if (deletion?.name) await operation(deletion, "https://run.googleapis.com/v2");
      }
      for (const scope of Object.values(scopes(fixture.runId))) {
        await wake.remove(scope);
        await apps.remove(scope);
      }
      await removeSqlJob(fixture.runId);
      await rm(join(PRIVATE, `${fixture.runId}.json`), { force: true });
    },
    async inventory({ runId }) {
      const { own, other } = scopes(runId);
      const left = { services: [], jobs: [], queues: [], identities: [], secrets: [] };
      for (const n of [names(own), names(other)]) {
        if (await api(`${run}/services/${n.service}`)) left.services.push(n.service);
        const queue = await api(`${tasksApi}/${n.queue}`);
        // A deleted queue's name stays reserved; only a live (non-deleted) queue is a leftover.
        if (queue && queue.state !== "DISABLED") left.queues.push(n.queue);
        for (const id of [n.runtime, n.migrator, n.invoker])
          if (
            await api(
              `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${id}@${project}.iam.gserviceaccount.com`,
            )
          )
            left.identities.push(id);
        for (const secret of [n.databaseSecret, n.migrationSecret])
          if (
            await api(
              `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secret}`,
            )
          )
            left.secrets.push(secret);
      }
      if (await api(`${run}/jobs/${prefix}-qprobe-${runId}`))
        left.jobs.push(`${prefix}-qprobe-${runId}`);
      const sqlt = sqlJobId(runId);
      if (await api(`${run}/jobs/${sqlt}`)) left.jobs.push(sqlt);
      if (await api(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${sqlt}`))
        left.secrets.push(sqlt);
      if (
        await api(
          `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${sqlt}@${project}.iam.gserviceaccount.com`,
        )
      )
        left.identities.push(sqlt);
      const projectPolicy = await api(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`,
        "POST",
        { options: { requestedPolicyVersion: 3 } },
      );
      left.projectBindings = (projectPolicy.bindings ?? [])
        .filter((binding) => binding.condition?.title === `m09-sqlt-${runId}`)
        .map((binding) => binding.role);
      return left;
    },
    async measuredUsage(fixture) {
      const instance = await api(sqlApi);
      const sqlHours = (+now() - Date.parse(instance.createTime)) / 3_600_000;
      const lifetime = fixture ? (+now() - Date.parse(fixture.createdAt)) / 1000 : 0;
      return {
        sqlHours,
        tier: instance.settings.tier,
        serviceActiveSeconds: 2 * lifetime,
        jobSeconds: fixture ? 600 * fixture.jobs.length : 0,
        taskOperations: 10_000,
        backupGiBHours: 10 * sqlHours,
        logGiB: 0.5,
      };
    },
  };

  async function writePrivate(runId, data) {
    await mkdir(PRIVATE, { recursive: true, mode: 0o700 });
    await writeFile(join(PRIVATE, `${runId}.json`), JSON.stringify(data), { mode: 0o600 });
  }

  /**
   * SQL qualification through a local Cloud SQL Auth Proxy (IAM-authorized operator, loopback
   * port). Fixture roles/databases are created with random passwords and dropped afterwards.
   */
  async function qualifySql(fixture) {
    const proxyBinary = process.env.EMBODY_CLOUD_SQL_PROXY;
    if (!proxyBinary)
      throw new Error("EMBODY_CLOUD_SQL_PROXY (Cloud SQL Auth Proxy binary) required");
    const port = 55000 + (Number.parseInt(fixture.runId.slice(0, 4), 16) % 900);
    const proxy = spawn(
      proxyBinary,
      [
        `--port=${port}`,
        "--address=127.0.0.1",
        ...(credentials === "gcloud" ? ["--gcloud-auth"] : []),
        `${project}:${region}:${prefix}-postgres`,
      ],
      { stdio: "ignore" },
    );
    const { Client } = createRequire(
      new URL("../../../packages/storage/package.json", import.meta.url),
    )("pg");
    const passwords = fixturePasswords([
      "postgres",
      "embody_migrator",
      "embody_runtime",
      "embody_other",
      "embody_platform_migrator",
      "embody_platform_runtime",
    ]);
    await writePrivate(fixture.runId, { runId: fixture.runId, passwords });
    const url = (role, database) =>
      `postgresql://${role}:${encodeURIComponent(passwords[role])}@127.0.0.1:${port}/${database}`;
    const connect = async (role, database) => {
      const client = new Client({
        connectionString: url(role, database),
        connectionTimeoutMillis: 15_000,
      });
      await client.connect();
      return client;
    };
    const attempt = async (role, database) => {
      const started = performance.now();
      try {
        const client = await connect(role, database);
        return { ok: true, client, ms: performance.now() - started };
      } catch (error) {
        return { ok: false, code: error?.code ?? null, ms: performance.now() - started };
      }
    };
    const results = {};
    try {
      await delay(3000);
      await api(`${sqlApi}/users?name=postgres`, "PUT", {
        name: "postgres",
        password: passwords.postgres,
      });
      await waitSqlOperations();
      // A run that was interrupted can leave its fixture behind; start clean.
      await dropFixture(connect);
      const admin = await connect("postgres", "postgres");
      try {
        for (const statement of bootstrapStatements(passwords)) await admin.query(statement);
      } finally {
        await admin.end();
      }
      for (const [database, statements] of Object.entries(schemaStatements())) {
        const client = await connect("postgres", database);
        try {
          for (const statement of statements) await client.query(statement);
        } finally {
          await client.end();
        }
      }
      const release = await connect("postgres", "postgres");
      try {
        for (const statement of releaseStatements()) await release.query(statement);
      } finally {
        await release.end();
      }
      // Storage/gateway-store suites and latency run in-region (see sql-suite.mjs).
      const job = await runSqlJob(fixture, passwords);
      for (const [id, gate] of [
        ["storage", job?.storage],
        ["gateway-store", job?.gatewayStore],
      ])
        results[id] = {
          exit: gate?.exit ?? null,
          status: gate?.status ?? "missing",
          counts: gate?.counts ?? null,
          postgresVersion: gate?.postgresVersion ?? null,
          pass: gate?.exit === 0 && gate?.status === "passed" && gate?.counts?.skipped === 0,
        };
      results["cold-latency"] =
        job?.latency?.trials === 20
          ? {
              ...job.latency,
              from: "Cloud Run job in us-central1 through the Cloud SQL Auth Proxy",
              databaseWarm: true,
              note: "new connection per trial; Cloud SQL does not suspend",
              pass: true,
            }
          : { trials: job?.latency?.trials ?? 0, pass: false };
      const denials = [];
      for (const target of ["embody_other", "embody_platform"]) {
        const result = await attempt("embody_runtime", target);
        if (result.ok) await result.client.end();
        denials.push({ target, code: result.ok ? "connected" : result.code });
      }
      results["connect-denials"] = evaluateConnectDenials(denials);
      const storm = await Promise.all(
        Array.from({ length: SQL_LIMITS.runtimeConnectionLimit + 5 }, () =>
          attempt("embody_runtime", "embody_test"),
        ),
      );
      const platform = await attempt("embody_platform_runtime", "embody_platform");
      if (platform.ok) await platform.client.end();
      await Promise.all(storm.filter((result) => result.ok).map((result) => result.client.end()));
      const again = await attempt("embody_runtime", "embody_test");
      if (again.ok) await again.client.end();
      results.storm = evaluateStorm({
        results: storm,
        limit: SQL_LIMITS.runtimeConnectionLimit,
        platformDuringStorm: platform.ok,
        releasedAfter: again.ok,
      });
      results.restore = await restoreCheck(connect);
    } finally {
      await removeSqlJob(fixture.runId).catch(() => undefined);
      await dropFixture(connect).catch(() => undefined);
      proxy.kill();
    }
    return results;
  }

  function sqlJobId(runId) {
    return `${prefix}-sqlt-${runId}`;
  }
  async function sqlClientBinding(email, runId, add) {
    const projectUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`;
    const policy = await api(`${projectUrl}:getIamPolicy`, "POST", {
      options: { requestedPolicyVersion: 3 },
    });
    const title = `m09-sqlt-${runId}`;
    const bindings = (policy.bindings ?? []).filter(
      (binding) => binding.condition?.title !== title,
    );
    if (!add && bindings.length === (policy.bindings ?? []).length) return;
    if (add)
      bindings.push({
        role: "roles/cloudsql.client",
        members: [`serviceAccount:${email}`],
        condition: {
          title,
          expression: `resource.name.endsWith('/instances/${prefix}-postgres')`,
        },
      });
    await withAccountPropagation(() =>
      api(`${projectUrl}:setIamPolicy`, "POST", {
        policy: { ...policy, version: 3, bindings },
      }),
    );
  }
  async function withAccountPropagation(operation) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!/failed \(400\)/.test(error.message) || attempt === 5) throw error;
        await delay(5000 * (attempt + 1));
      }
    }
  }
  /**
   * In-region SQL suites: a run-scoped identity with Cloud SQL client on this instance only
   * (conditional binding, as in M05), the fixture URLs in a run-scoped secret only it can read,
   * and a job that runs sql-suite.mjs. Everything is removed by removeSqlJob.
   */
  async function runSqlJob(fixture, passwords) {
    const id = sqlJobId(fixture.runId);
    const email = `${id}@${project}.iam.gserviceaccount.com`;
    const description = JSON.stringify({ managed_by: MARKER, run: fixture.runId });
    await api(`https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`, "POST", {
      accountId: id,
      serviceAccount: { displayName: id, description },
    });
    await sqlClientBinding(email, fixture.runId, true);
    const secrets = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets`;
    await api(`${secrets}?secretId=${id}`, "POST", {
      labels: { managed_by: MARKER, fixture: prefix, run: fixture.runId },
      replication: { userManaged: { replicas: [{ location: region }] } },
    });
    const local = (role, database) =>
      `postgresql://${role}:${encodeURIComponent(passwords[role])}@127.0.0.1:5432/${database}`;
    const payload = {
      instance: `${project}:${region}:${prefix}-postgres`,
      urls: {
        EMBODY_POSTGRES_URL: local("embody_runtime", "embody_test"),
        EMBODY_POSTGRES_MIGRATION_URL: local("embody_migrator", "embody_test"),
        EMBODY_POSTGRES_OTHER_URL: local("embody_other", "embody_other"),
        EMBODY_PLATFORM_URL: local("embody_platform_runtime", "embody_platform"),
        EMBODY_PLATFORM_MIGRATION_URL: local("embody_platform_migrator", "embody_platform"),
      },
    };
    await api(`${secrets}/${id}:addVersion`, "POST", {
      payload: { data: Buffer.from(JSON.stringify(payload)).toString("base64") },
    });
    await withAccountPropagation(() =>
      api(`${secrets}/${id}:setIamPolicy`, "POST", {
        policy: {
          bindings: [
            { role: "roles/secretmanager.secretAccessor", members: [`serviceAccount:${email}`] },
          ],
        },
      }),
    );
    await delay(60_000);
    await operation(
      await api(`${run}/jobs?jobId=${id}`, "POST", {
        labels: { managed_by: MARKER, fixture: prefix, run: fixture.runId },
        template: {
          taskCount: 1,
          template: {
            maxRetries: 0,
            timeout: "3600s",
            serviceAccount: email,
            containers: [
              {
                image,
                command: ["node", "infra/mvp/m09/sql-suite.mjs"],
                resources: { limits: { cpu: "2", memory: "4Gi" } },
                env: [
                  {
                    name: "EMBODY_M09_SQL",
                    valueSource: { secretKeyRef: { secret: id, version: "1" } },
                  },
                ],
              },
            ],
          },
        },
      }),
      "https://run.googleapis.com/v2",
    );
    const since = now().toISOString();
    await operation(
      await api(`${run}/jobs/${id}:run`, "POST", {}),
      "https://run.googleapis.com/v2",
    ).catch(() => undefined);
    for (let attempt = 0; attempt < 12; attempt++) {
      const entries = await logs(
        `resource.type="cloud_run_job" AND resource.labels.job_name="${id}" AND jsonPayload.message="embody.m09.sqlSuite"`,
        since,
      );
      if (entries.length) return entries.at(-1).jsonPayload;
      await delay(10_000);
    }
    return null;
  }
  async function removeSqlJob(runId) {
    const id = sqlJobId(runId);
    const email = `${id}@${project}.iam.gserviceaccount.com`;
    const deletion = await api(`${run}/jobs/${id}`, "DELETE");
    if (deletion?.name) await operation(deletion, "https://run.googleapis.com/v2");
    await sqlClientBinding(email, runId, false);
    await api(
      `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${id}`,
      "DELETE",
    );
    const account = await api(
      `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${email}`,
    );
    if (account && account.description === JSON.stringify({ managed_by: MARKER, run: runId }))
      await api(
        `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${email}`,
        "DELETE",
      );
  }
  async function waitSqlOperations() {
    for (let attempt = 0; attempt < 240; attempt++) {
      const { items = [] } = await api(
        `https://sqladmin.googleapis.com/v1/projects/${project}/operations?instance=${prefix}-postgres&maxResults=5`,
      );
      if (items.every((item) => item.status === "DONE")) return;
      await delay(5000);
    }
    throw new Error("Cloud SQL operation did not finish");
  }
  async function checksum(connect) {
    const client = await connect("embody_migrator", "embody_test");
    try {
      await client.query(
        "CREATE TABLE IF NOT EXISTS m09_restore (id integer PRIMARY KEY, value text NOT NULL)",
      );
      const { rows } = await client.query(
        "SELECT coalesce(string_agg(id || ':' || value, ',' ORDER BY id), '') AS data FROM m09_restore",
      );
      return createHash("sha256").update(rows[0].data).digest("hex");
    } finally {
      await client.end();
    }
  }
  async function restoreCheck(connect) {
    const seed = await connect("embody_migrator", "embody_test");
    try {
      await seed.query(
        "CREATE TABLE IF NOT EXISTS m09_restore (id integer PRIMARY KEY, value text NOT NULL)",
      );
      await seed.query(
        "INSERT INTO m09_restore SELECT g, md5(g::text) FROM generate_series(1, 1000) g ON CONFLICT DO NOTHING",
      );
    } finally {
      await seed.end();
    }
    const checksumAtBackup = await checksum(connect);
    const backup = await api(`${sqlApi}/backupRuns`, "POST", {
      description: `${MARKER} restore check`,
    });
    await waitSqlOperations();
    const runs = await api(`${sqlApi}/backupRuns?maxResults=5`);
    const target = (runs.items ?? []).find(
      (item) => item.description === `${MARKER} restore check` && item.status === "SUCCESSFUL",
    );
    if (!backup || !target) throw new Error("On-demand backup did not succeed");
    const marker = await connect("embody_migrator", "embody_test");
    try {
      await marker.query("INSERT INTO m09_restore VALUES (100001, 'after-backup')");
    } finally {
      await marker.end();
    }
    const started = Date.now();
    await api(`${sqlApi}/restoreBackup`, "POST", {
      restoreBackupContext: { backupRunId: target.id, instanceId: `${prefix}-postgres`, project },
    });
    await waitSqlOperations();
    const seconds = (Date.now() - started) / 1000;
    const check = await connect("embody_migrator", "embody_test");
    let markerAfterRestore;
    try {
      markerAfterRestore =
        (await check.query("SELECT count(*)::int AS n FROM m09_restore WHERE id = 100001")).rows[0]
          .n > 0;
    } finally {
      await check.end();
    }
    const result = evaluateRestore({
      checksumAtBackup,
      checksumAfterRestore: await checksum(connect),
      markerAfterRestore,
      seconds,
    });
    await api(`${sqlApi}/backupRuns/${target.id}`, "DELETE").catch(() => undefined);
    return result;
  }
  async function dropFixture(connect) {
    const admin = await connect("postgres", "postgres");
    try {
      const { rows } = await admin.query(
        "SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
        [FIXTURE_ROLES],
      );
      for (const statement of dropStatements(rows.map((row) => row.rolname)))
        await admin.query(statement);
    } finally {
      await admin.end();
    }
  }
}

export async function loadBaseline(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  return value.baseline?.value ?? value.value ?? value;
}
