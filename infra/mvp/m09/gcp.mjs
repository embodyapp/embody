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
import { URL, URLSearchParams } from "node:url";
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
  latencySummary,
} from "./sql.mjs";
const exec = promisify(execFile);
const { fetch, AbortSignal } = globalThis;
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

export function createGcpProvider({
  baseline,
  image,
  credentials = "adc",
  token = () => operatorToken(credentials),
  fetcher = fetch,
  now = () => new Date(),
}) {
  const { project, region, prefix } = baseline;
  if (
    region !== "us-central1" ||
    !/^[a-z0-9-]+-docker\.pkg\.dev\/.+@sha256:[a-f0-9]{64}$/.test(image ?? "")
  )
    throw new Error("M09 provider needs the baseline output and an immutable fixture image digest");
  const run = `https://run.googleapis.com/v2/projects/${project}/locations/${region}`;
  const tasksApi = `https://cloudtasks.googleapis.com/v2/projects/${project}/locations/${region}/queues`;
  const sqlApi = `https://sqladmin.googleapis.com/v1/projects/${project}/instances/${prefix}-postgres`;
  let cached;
  const accessToken = async () => {
    if (!cached || cached.until < Date.now())
      cached = { value: await token(), until: Date.now() + 30 * 60_000 };
    return cached.value;
  };
  async function api(url, method = "GET", body, { allow = [] } = {}) {
    const response = await fetcher(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
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
  });
  const wake = createWakeQueueProvisioner({ project, region, prefix, accessToken, logSampling: 1 });
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
      // Deployment readiness checks may start an instance; isolation is judged after settling.
      await delay(120_000);
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
        `${serviceFilter(fixture[which].service)} AND jsonPayload.message="embody.m09.start"`,
        fixture.createdAt,
      );
      return entries.map((entry) => entry.jsonPayload.at);
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
        (series.points ?? []).map((point) => ({
          start: point.interval.startTime ?? point.interval.endTime,
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
      const env = {
        ...process.env,
        EMBODY_POSTGRES_URL: url("embody_runtime", "embody_test"),
        EMBODY_POSTGRES_MIGRATION_URL: url("embody_migrator", "embody_test"),
        EMBODY_POSTGRES_OTHER_URL: url("embody_other", "embody_other"),
        EMBODY_PLATFORM_URL: url("embody_platform_runtime", "embody_platform"),
        EMBODY_PLATFORM_MIGRATION_URL: url("embody_platform_migrator", "embody_platform"),
        EMBODY_POSTGRES_PROVIDER_INSTANCE: `${project}:${region}:${prefix}-postgres`,
      };
      delete env.EMBODY_POSTGRES_TEST_CONTAINER;
      for (const [id, script] of [
        ["storage", "scripts/test-postgres.mjs"],
        ["gateway-store", "scripts/test-gateway-store.mjs"],
      ]) {
        const child = await exec(process.execPath, [script], {
          env,
          maxBuffer: 50 * 1024 * 1024,
        }).then(
          () => 0,
          (error) => error.code ?? 1,
        );
        results[id] = { exit: child, pass: child === 0 };
      }
      const denials = [];
      for (const target of ["embody_other", "embody_platform"]) {
        const result = await attempt("embody_runtime", target);
        if (result.ok) await result.client.end();
        denials.push({ target, code: result.ok ? "connected" : result.code });
      }
      results["connect-denials"] = evaluateConnectDenials(denials);
      const samples = [];
      for (let index = 0; index < 20; index++) {
        const result = await attempt("embody_runtime", "embody_test");
        if (result.ok) {
          await result.client.query("SELECT 1");
          samples.push(result.ms);
          await result.client.end();
        }
      }
      results["cold-latency"] =
        samples.length === 20
          ? {
              ...latencySummary(samples),
              databaseWarm: true,
              note: "new connection through the Auth Proxy; Cloud SQL does not suspend",
              pass: true,
            }
          : { trials: samples.length, pass: false };
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
      await dropFixture(connect).catch(() => undefined);
      proxy.kill();
    }
    return results;
  }
  async function waitSqlOperations() {
    for (let attempt = 0; attempt < 120; attempt++) {
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
      for (const database of ["embody_test", "embody_other", "embody_platform"])
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      for (const role of [
        "embody_migrator",
        "embody_runtime",
        "embody_other",
        "embody_platform_migrator",
        "embody_platform_runtime",
      ])
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally {
      await admin.end();
    }
  }
}

export async function loadBaseline(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  return value.baseline?.value ?? value.value ?? value;
}
