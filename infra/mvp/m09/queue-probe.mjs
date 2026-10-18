// Run ONLY as a Cloud Run job under app A's runtime identity (metadata server credentials).
// Operator credentials, ADC or impersonation would prove nothing about the app's IAM.
// Emits one `embody.m09.queueProbe` JSON line: statuses only, never tokens or provider bodies.
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
const { fetch, AbortSignal } = globalThis;

const QUEUE =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/us-central1\/queues\/embody-test-[a-z0-9-]+$/;
export function validateProbeConfig(config) {
  const fields = ["ownQueue", "otherQueue"];
  if (
    !config ||
    fields.some((field) => !QUEUE.test(config[field] ?? "")) ||
    config.ownQueue === config.otherQueue ||
    !/^embody-test-[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(
      config.ownInvoker ?? "",
    ) ||
    !/^embody-test-[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(
      config.otherInvoker ?? "",
    ) ||
    config.ownInvoker === config.otherInvoker ||
    ![config.ownUrl, config.otherUrl].every((url) =>
      /^https:\/\/embody-test-[a-z0-9-]+\.[a-z0-9.-]+\.run\.app$/.test(url ?? ""),
    ) ||
    config.ownUrl === config.otherUrl ||
    !/^[a-z0-9]{6,16}$/.test(config.runId ?? "") ||
    !(
      Number.isInteger(config.delaySeconds) &&
      config.delaySeconds >= 900 &&
      config.delaySeconds <= 3600
    ) ||
    !(Number.isInteger(config.fail503) && config.fail503 >= 1 && config.fail503 <= 8)
  )
    throw new Error("Queue probe requires two distinct embody-test queues, invokers and services");
  const secrets = [config.platformDbSecret, config.signerSecret, config.otherAppSecret];
  if (
    secrets.some(
      (name) =>
        !/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/secrets\/embody-test-[a-z0-9-]+$/.test(
          name ?? "",
        ),
    ) ||
    new Set(secrets).size !== 3 ||
    !/^embody-test-[a-z0-9-]+-gateway@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(
      config.gatewayEmail ?? "",
    ) ||
    !/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/instances\/embody-test-[a-z0-9-]+$/.test(
      config.sqlInstance ?? "",
    )
  )
    throw new Error(
      "Queue probe requires the platform/other secrets, gateway identity and SQL instance",
    );
  return config;
}

/**
 * M05 runtime-identity negatives deferred to M09: the app runtime cannot read platform or other
 * apps' secrets, sign as the gateway, call the deploy API or administer SQL. Each must be 403.
 */
export function identityPlan(config) {
  const [project] = config.ownQueue.split("/").slice(1, 2);
  const secret = (name) => `https://secretmanager.googleapis.com/v1/${name}/versions/latest:access`;
  return [
    { id: "identity-secret-platform-db", method: "GET", url: secret(config.platformDbSecret) },
    { id: "identity-secret-signer", method: "GET", url: secret(config.signerSecret) },
    { id: "identity-secret-other-app", method: "GET", url: secret(config.otherAppSecret) },
    {
      id: "identity-sign-as-gateway",
      method: "POST",
      url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.gatewayEmail}:signJwt`,
      body: { payload: JSON.stringify({ sub: "m09-denied" }) },
    },
    {
      id: "identity-deploy-api",
      method: "POST",
      url: `https://run.googleapis.com/v2/projects/${project}/locations/us-central1/services?serviceId=embody-test-denied-${config.runId}&validateOnly=true`,
      body: { template: { containers: [{ image: "us-docker.pkg.dev/cloudrun/container/hello" }] } },
    },
    {
      id: "identity-sql-admin",
      method: "GET",
      url: `https://sqladmin.googleapis.com/v1/${config.sqlInstance}`,
    },
  ];
}
export const IDENTITY_CASES = Object.freeze([
  "identity-secret-platform-db",
  "identity-secret-signer",
  "identity-secret-other-app",
  "identity-sign-as-gateway",
  "identity-deploy-api",
  "identity-sql-admin",
]);

/** Expected outcome per case. `created` means HTTP 200 from tasks.create. */
export const QUEUE_CASES = Object.freeze({
  "own-now": 200,
  "own-duplicate": 409,
  "own-delayed": 200,
  "own-retry": 200,
  "own-horizon-inside": 200,
  "own-horizon-outside": 400,
  "other-queue": 403,
  "other-invoker": 403,
  "cross-app-target": 200,
});

export function taskBody({ queue, name, url, invoker, scheduleAt, probe, fail503 = 0 }) {
  return {
    task: {
      name: `${queue}/tasks/${name}`,
      ...(scheduleAt ? { scheduleTime: scheduleAt } : {}),
      httpRequest: {
        httpMethod: "POST",
        url: `${url}/_embody/drain`,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ probe, fail503 })).toString("base64"),
        oidcToken: { serviceAccountEmail: invoker, audience: url },
      },
    },
  };
}

/** Builds the ordered case plan. Names hash-like, like M20's, never sequential timestamps. */
export function probePlan(config, now) {
  const at = (seconds) => new Date(+now + seconds * 1000).toISOString();
  const name = (label) => `m09-${config.runId}-${label}-${randomBytes(6).toString("hex")}`;
  const own = { queue: config.ownQueue, url: config.ownUrl, invoker: config.ownInvoker };
  const first = name("now");
  const day = 24 * 3600;
  return [
    { id: "own-now", ...own, name: first, probe: "own-now" },
    { id: "own-duplicate", ...own, name: first, probe: "own-now" },
    {
      id: "own-delayed",
      ...own,
      name: name("delayed"),
      probe: "own-delayed",
      scheduleAt: at(config.delaySeconds),
    },
    { id: "own-retry", ...own, name: name("retry"), probe: "own-retry", fail503: config.fail503 },
    {
      id: "own-horizon-inside",
      ...own,
      name: name("inside"),
      probe: "own-horizon",
      scheduleAt: at(30 * day - 600),
    },
    {
      id: "own-horizon-outside",
      ...own,
      name: name("outside"),
      probe: "own-horizon",
      scheduleAt: at(30 * day + 3600),
    },
    {
      id: "other-queue",
      ...own,
      queue: config.otherQueue,
      name: name("otherq"),
      probe: "other-queue",
    },
    {
      id: "other-invoker",
      ...own,
      invoker: config.otherInvoker,
      name: name("otheri"),
      probe: "other-invoker",
    },
    {
      id: "cross-app-target",
      ...own,
      url: config.otherUrl,
      name: name("cross"),
      probe: "cross-app-target",
    },
  ];
}

export async function runQueueProbe(
  config,
  { fetcher = fetch, now = () => new Date(), adapter = undefined } = {},
) {
  validateProbeConfig(config);
  const tokenResponse = await fetcher(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    {
      headers: { "metadata-flavor": "Google" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!tokenResponse.ok) throw new Error("Workload token unavailable");
  const { access_token: token } = await tokenResponse.json();
  const identity = await fetcher(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email",
    {
      headers: { "metadata-flavor": "Google" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    },
  );
  const subject = identity.ok ? (await identity.text()).trim() : null;
  const results = [];
  for (const step of probePlan(config, now())) {
    let status = 0;
    try {
      const response = await fetcher(`https://cloudtasks.googleapis.com/v2/${step.queue}/tasks`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(taskBody(step)),
      });
      status = response.status;
      await response.body?.cancel();
    } catch {
      status = 0;
    }
    results.push({
      case: step.id,
      task: step.name,
      scheduleAt: step.scheduleAt ?? null,
      status,
      expected: QUEUE_CASES[step.id],
      pass: status === QUEUE_CASES[step.id],
    });
  }
  for (const step of identityPlan(config)) {
    let status = 0;
    try {
      const response = await fetcher(step.url, {
        method: step.method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(step.body ? { body: JSON.stringify(step.body) } : {}),
      });
      status = response.status;
      await response.body?.cancel();
    } catch {
      status = 0;
    }
    results.push({
      case: step.id,
      task: null,
      scheduleAt: null,
      status,
      expected: 403,
      pass: status === 403,
    });
  }
  // The real M20 Cloud Tasks adapter: created once, then the same name reports "duplicate".
  if (adapter) {
    const name = `m09-${config.runId}-adapter-${randomBytes(6).toString("hex")}`;
    const task = { name, scheduleAt: now().toISOString(), body: { probe: "adapter", fail503: 0 } };
    for (const [id, expected] of [
      ["adapter-created", "created"],
      ["adapter-duplicate", "duplicate"],
    ]) {
      let outcome;
      try {
        outcome = await adapter.enqueue(task);
      } catch {
        outcome = "failed";
      }
      results.push({
        case: id,
        task: name,
        scheduleAt: null,
        status: outcome,
        expected,
        pass: outcome === expected,
      });
    }
  }
  return {
    message: "embody.m09.queueProbe",
    runId: config.runId,
    subject,
    at: now().toISOString(),
    results,
    pass: results.every((result) => result.pass),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = validateProbeConfig(JSON.parse(process.env.EMBODY_M09_PROBE ?? "null"));
  const { cloudTasksWakeQueue } = await import("../../../packages/host/dist/index.js");
  const adapter = cloudTasksWakeQueue({
    queue: config?.ownQueue,
    url: `${config?.ownUrl}/_embody/drain`,
    invokerEmail: config?.ownInvoker,
    audience: config?.ownUrl,
  });
  runQueueProbe(config, { adapter })
    .then((report) => {
      console.log(JSON.stringify(report));
      if (!report.pass) process.exitCode = 1;
    })
    .catch(() => {
      console.log(
        JSON.stringify({
          message: "embody.m09.queueProbe",
          pass: false,
          error: "probe failed; details suppressed",
        }),
      );
      process.exitCode = 1;
    });
}
