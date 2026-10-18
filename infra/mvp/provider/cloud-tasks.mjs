// Per-app wake queue primitives (M09): one Cloud Tasks queue and one platform invoker identity
// per app, so one app's runtime can neither enqueue on another app's queue nor mint a token
// another app's drain accepts. Shared by qualification and the future controller (M12/M13).
import { setTimeout } from "node:timers";
import { appResourceNames } from "./cloud-run.mjs";
const { fetch, AbortSignal } = globalThis;

/**
 * Queue limits. Retries must outlast the longest transaction (30 s action deadline plus
 * commit): 1+2+4+8+16 s of backoff covers it within six attempts. Later attempts back off to
 * five minutes and keep trying for three days, so a drain that fails during an outage is not
 * stranded; beyond that, MD12 recovery re-enqueues overdue work on the next inbound request.
 */
export const WAKE_QUEUE_LIMITS = Object.freeze({
  rateLimits: Object.freeze({ maxDispatchesPerSecond: 5, maxConcurrentDispatches: 2 }),
  retryConfig: Object.freeze({
    maxAttempts: -1,
    maxRetryDuration: "259200s",
    minBackoff: "1s",
    maxBackoff: "300s",
    maxDoublings: 8,
  }),
});
const MARKER = "embody-m09-wake-adapter";

class ProviderError extends Error {
  constructor(method, status, accountPropagation = false) {
    super(`Provider ${method} failed (${status}); details suppressed`);
    this.status = status;
    this.accountPropagation = accountPropagation;
  }
}

export function wakeResourceNames(scope) {
  const names = appResourceNames(scope);
  const hash = names.runtime.slice(names.runtime.lastIndexOf("-") + 1);
  return {
    ...names,
    queue: `${scope.prefix}-wake-${hash}`,
    invoker: `${scope.prefix}-w-${hash}`,
  };
}

/** True when a queue's dispatch/retry settings equal the approved limits exactly. */
export function queueMatchesLimits(queue) {
  const rate = queue?.rateLimits ?? {};
  const retry = queue?.retryConfig ?? {};
  const want = WAKE_QUEUE_LIMITS;
  return (
    rate.maxDispatchesPerSecond === want.rateLimits.maxDispatchesPerSecond &&
    rate.maxConcurrentDispatches === want.rateLimits.maxConcurrentDispatches &&
    retry.maxAttempts === want.retryConfig.maxAttempts &&
    retry.maxRetryDuration === want.retryConfig.maxRetryDuration &&
    retry.minBackoff === want.retryConfig.minBackoff &&
    retry.maxBackoff === want.retryConfig.maxBackoff &&
    retry.maxDoublings === want.retryConfig.maxDoublings
  );
}

/** Rejects any binding outside `allowed` (role → permitted members); never erases foreign IAM. */
function assertOnlyBindings(policy, allowed) {
  for (const binding of policy?.bindings ?? []) {
    const members = allowed[binding.role];
    if (
      !members ||
      binding.condition ||
      !Array.isArray(binding.members) ||
      binding.members.some((member) => !members.includes(member))
    )
      throw new Error("Unexpected IAM binding; refusing to overwrite unowned policy");
  }
}

export function createWakeQueueProvisioner({
  project,
  region,
  prefix,
  accessToken,
  logSampling = 0,
  fetcher = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (
    region !== "us-central1" ||
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project ?? "") ||
    !/^embody-test-[a-z0-9-]+$/.test(prefix ?? "") ||
    prefix.length > 15 ||
    typeof accessToken !== "function" ||
    !(logSampling >= 0 && logSampling <= 1)
  )
    throw new Error("Invalid provider authority");
  const tasks = `https://cloudtasks.googleapis.com/v2/projects/${project}/locations/${region}/queues`;
  const iam = `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`;
  const run = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services`;
  const email = (id) => `${id}@${project}.iam.gserviceaccount.com`;

  async function request(url, method = "GET", body) {
    let response;
    try {
      response = await fetcher(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ProviderError(method, 0);
    }
    if (response.status === 404 && ["GET", "DELETE"].includes(method)) return null;
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new ProviderError(
        method,
        response.status,
        response.status === 400 &&
          /service account.*(does not exist|not found)/i.test(details.error?.message ?? ""),
      );
    }
    return response.status === 204 ? {} : response.json().catch(() => ({}));
  }
  // New service accounts take seconds to become visible to other IAM policies.
  async function withPropagation(operation) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof ProviderError) || !error.accountPropagation || attempt === 4)
          throw error;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }
  let agent;
  async function tasksAgent() {
    if (agent) return agent;
    const info = await request(
      `https://cloudresourcemanager.googleapis.com/v3/projects/${project}`,
    );
    if (info?.projectId !== project || !/^projects\/\d+$/.test(info.name ?? ""))
      throw new Error("Project number identity mismatch");
    agent = `service-${info.name.split("/")[1]}@gcp-sa-cloudtasks.iam.gserviceaccount.com`;
    return agent;
  }
  function context(scope) {
    const names = wakeResourceNames({ ...scope, project, prefix });
    const description = JSON.stringify({ managed_by: MARKER, fixture: prefix, app: scope.appId });
    return {
      names,
      description,
      runtime: email(names.runtime),
      invoker: email(names.invoker),
      queue: `projects/${project}/locations/${region}/queues/${names.queue}`,
    };
  }

  /**
   * Creates (or reconciles) the app's invoker identity and queue and binds exactly:
   * runtime → enqueuer on its own queue; runtime and the Cloud Tasks agent → actAs on its own
   * invoker; invoker → run.invoker on its own service (beside the gateway, if present).
   */
  async function prepare(scope) {
    const { names, description, runtime, invoker, queue } = context(scope);
    if (!(await request(`${iam}/${runtime}`)))
      throw new Error("Prepare the app runtime identity first");
    let account = await request(`${iam}/${invoker}`);
    if (!account)
      account = await request(iam, "POST", {
        accountId: names.invoker,
        serviceAccount: { displayName: names.invoker, description },
      });
    if (account.email !== invoker || account.description !== description)
      throw new Error("Invoker identity ownership mismatch");

    const actAs = [`serviceAccount:${runtime}`, `serviceAccount:${await tasksAgent()}`];
    const accountPolicy = await request(`${iam}/${invoker}:getIamPolicy`, "POST");
    assertOnlyBindings(accountPolicy, { "roles/iam.serviceAccountUser": actAs });
    await withPropagation(() =>
      request(`${iam}/${invoker}:setIamPolicy`, "POST", {
        policy: {
          ...(accountPolicy?.etag ? { etag: accountPolicy.etag } : {}),
          bindings: [{ role: "roles/iam.serviceAccountUser", members: actAs }],
        },
      }),
    );

    let current = await request(`${tasks}/${names.queue}`);
    if (!current)
      current = await request(tasks, "POST", {
        name: queue,
        ...WAKE_QUEUE_LIMITS,
        stackdriverLoggingConfig: { samplingRatio: logSampling },
      });
    if (current.name !== queue || !queueMatchesLimits(current))
      throw new Error("Queue settings differ from the approved limits; refusing adoption");
    const enqueue = { "roles/cloudtasks.enqueuer": [`serviceAccount:${runtime}`] };
    const queuePolicy = await request(`${tasks}/${names.queue}:getIamPolicy`, "POST", {});
    assertOnlyBindings(queuePolicy, enqueue);
    await withPropagation(() =>
      request(`${tasks}/${names.queue}:setIamPolicy`, "POST", {
        policy: {
          ...(queuePolicy?.etag ? { etag: queuePolicy.etag } : {}),
          bindings: [{ role: "roles/cloudtasks.enqueuer", members: [`serviceAccount:${runtime}`] }],
        },
      }),
    );

    const service = await request(`${run}/${names.service}`);
    if (!service?.uri) throw new Error("Deploy the app service before binding its wake invoker");
    if (service.template?.serviceAccount !== runtime)
      throw new Error("App service does not run as the app runtime identity");
    const gateway = `serviceAccount:${email(`${prefix}-gateway`)}`;
    const invokers = [gateway, `serviceAccount:${invoker}`];
    const servicePolicy = await request(`${run}/${names.service}:getIamPolicy`);
    assertOnlyBindings(servicePolicy, { "roles/run.invoker": invokers });
    const members = [
      ...new Set([
        ...(servicePolicy?.bindings ?? []).flatMap((binding) => binding.members),
        `serviceAccount:${invoker}`,
      ]),
    ];
    await withPropagation(() =>
      request(`${run}/${names.service}:setIamPolicy`, "POST", {
        policy: {
          ...(servicePolicy?.etag ? { etag: servicePolicy.etag } : {}),
          bindings: [{ role: "roles/run.invoker", members }],
        },
      }),
    );
    return { queue, invokerEmail: invoker, runtimeEmail: runtime, audience: service.uri };
  }

  /** Emergency admission stop for wake-ups: a paused queue keeps tasks and dispatches none. */
  async function setPaused(scope, paused) {
    const { names, queue } = context(scope);
    const current = await request(`${tasks}/${names.queue}`);
    if (current?.name !== queue || !queueMatchesLimits(current))
      throw new Error("Queue ownership mismatch");
    const result = await request(
      `${tasks}/${names.queue}:${paused ? "pause" : "resume"}`,
      "POST",
      {},
    );
    return { queue, state: result.state };
  }

  /** Removes the app's queue, invoker identity and its run.invoker binding. Repeatable. */
  async function remove(scope) {
    const { names, description, invoker, queue } = context(scope);
    const account = await request(`${iam}/${invoker}`);
    if (account && account.description !== description)
      throw new Error("Invoker identity ownership mismatch; refusing deletion");
    const current = await request(`${tasks}/${names.queue}`);
    if (current && (current.name !== queue || !queueMatchesLimits(current)))
      throw new Error("Queue ownership mismatch; refusing deletion");
    const service = await request(`${run}/${names.service}`);
    if (service) {
      const policy = await request(`${run}/${names.service}:getIamPolicy`);
      const member = `serviceAccount:${invoker}`;
      if ((policy?.bindings ?? []).some((binding) => binding.members?.includes(member)))
        await request(`${run}/${names.service}:setIamPolicy`, "POST", {
          policy: {
            ...(policy.etag ? { etag: policy.etag } : {}),
            bindings: policy.bindings
              .map((binding) => ({
                ...binding,
                members: binding.members.filter((value) => value !== member),
              }))
              .filter((binding) => binding.members.length),
          },
        });
    }
    // A deleted queue name stays reserved for up to seven days; fixtures use fresh scopes.
    if (current) await request(`${tasks}/${names.queue}`, "DELETE");
    if (account) await request(`${iam}/${invoker}`, "DELETE");
    return { queue, invoker, removed: true };
  }
  return {
    prepare,
    remove,
    pause: (scope) => setPaused(scope, true),
    resume: (scope) => setPaused(scope, false),
  };
}
