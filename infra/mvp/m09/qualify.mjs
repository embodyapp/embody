// M09 qualification suite: case evaluators and the ordered live run. The provider (real GCP in
// ./gcp.mjs, a fake in tests) does all cloud I/O; this module decides pass/fail and always
// tears down. Mocked runs exercise the logic only and are never provider evidence.
import { randomBytes } from "node:crypto";
import { WAKE_QUEUE_LIMITS } from "../provider/cloud-tasks.mjs";
import { qualificationEstimate } from "./costs.mjs";
import { IDENTITY_CASES, QUEUE_CASES } from "./queue-probe.mjs";

export const M09_LIMITS = Object.freeze({
  maxBudgetUsd: 25,
  maxInstances: 1,
  concurrency: 4,
  delaySeconds: 2400,
  fail503: 5,
  // Cloud Run usually reaches zero within ~15 min idle; require a full minute of zero.
  minZeroSeconds: 60,
  // Retries must outlast the longest transaction: 30 s action deadline plus margin.
  longestTransactionSeconds: 35,
  // Live run: a pause took seconds to stop dispatch, so the check waits before enqueueing.
  pausePropagationMs: 60_000,
});

/** Our own provider errors carry only a method, host and status; anything else is reduced to its class. */
export function safeError(error) {
  const message = error instanceof Error ? error.message : "";
  return /^(Provider [A-Z]+ [a-z0-9.-]+ failed \(\d{1,3}\); (body|details) suppressed|[A-Za-z ,;/.()-]{1,120})$/.test(
    message,
  ) && !/token|password|secret|postgres(ql)?:/i.test(message)
    ? message
    : (error?.name ?? "Error");
}

/** Every provider method the suite calls; the real provider must implement them all. */
export const SUITE_PROVIDER_METHODS = Object.freeze([
  "now",
  "wait",
  "projectedCostUsd",
  "preflight",
  "setUp",
  "runQueueProbe",
  "wakes",
  "starts",
  "requests",
  "instanceSeries",
  "serviceConfig",
  "recreateTask",
  "pause",
  "resume",
  "enqueueOperatorTask",
  "externalCalls",
  "iamInventory",
  "sql",
  "tearDown",
  "inventory",
  "measuredUsage",
]);

/** Guards shared by `test:mvp:cloud` and the operator CLI. Throws before any cloud call. */
export function m09Approval(env) {
  const budget = Number(env.EMBODY_MVP_CLOUD_BUDGET_USD);
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(env.EMBODY_MVP_CLOUD_PROJECT ?? "") ||
    !/^embody-test-[a-z0-9-]{1,3}$/u.test(env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX ?? "") ||
    !Number.isFinite(budget) ||
    budget <= 0 ||
    env.EMBODY_MVP_CLOUD_BUDGET_APPROVED !== "true"
  )
    throw new Error(
      "Cloud gate requires an explicit test project, embody-test resource prefix and approved positive budget",
    );
  if (budget > M09_LIMITS.maxBudgetUsd)
    throw new Error(
      "M09 qualification budget is at most $25 (MD06); approve a separate budget for more",
    );
  return {
    project: env.EMBODY_MVP_CLOUD_PROJECT,
    prefix: env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX,
    budgetUsd: budget,
  };
}

/** M09.d: effective request-only scaling of a service and its serving revision. */
export function evaluateScaling({ service, revision }) {
  const scaling = revision?.scaling ?? {};
  const container = revision?.containers?.[0] ?? {};
  const checks = {
    minZero:
      (scaling.minInstanceCount ?? 0) === 0 && (service?.scaling?.minInstanceCount ?? 0) === 0,
    maxBounded:
      Number.isInteger(scaling.maxInstanceCount) &&
      scaling.maxInstanceCount >= 1 &&
      scaling.maxInstanceCount <= M09_LIMITS.maxInstances,
    requestBilling: container.resources?.cpuIdle === true,
    concurrencyBounded:
      Number.isInteger(revision?.maxInstanceRequestConcurrency) &&
      revision.maxInstanceRequestConcurrency <= M09_LIMITS.concurrency,
    privateIngress: service?.ingress === "INGRESS_TRAFFIC_INTERNAL_ONLY",
    invokerIam: service?.invokerIamDisabled !== true,
  };
  return { checks, pass: Object.values(checks).every(Boolean) };
}

/**
 * Zero intervals from Monitoring instance_count points ({start, end, value} per alignment
 * period, max aligner). Gaps in the series are NOT treated as zero.
 */
export function zeroIntervals(points, minSeconds = M09_LIMITS.minZeroSeconds) {
  const sorted = [...points].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const intervals = [];
  let current;
  for (const point of sorted) {
    const zero = point.value === 0;
    if (zero && current && Date.parse(point.start) <= Date.parse(current.end))
      current.end = point.end;
    else if (zero) intervals.push((current = { start: point.start, end: point.end }));
    else current = undefined;
  }
  return intervals.filter(
    (interval) => (Date.parse(interval.end) - Date.parse(interval.start)) / 1000 >= minSeconds,
  );
}

/** M09.e: the delayed task woke the service from an observed zero, never before it was due. */
export function evaluateDelayedWake({ scheduleAt, wakes, starts, points }) {
  const due = Date.parse(scheduleAt);
  const deliveries = wakes.filter((wake) => wake.probe === "own-delayed");
  const early = deliveries.filter((wake) => Date.parse(wake.receivedAt) < due);
  const first = deliveries.map((wake) => Date.parse(wake.receivedAt)).sort((a, b) => a - b)[0];
  const zeroBeforeDue = zeroIntervals(points).some(
    (interval) => Date.parse(interval.start) < due && Date.parse(interval.end) >= due - 60_000,
  );
  const coldStart = starts.some(
    (at) => Date.parse(at) >= due - 5_000 && Date.parse(at) <= (first ?? 0),
  );
  const pass =
    deliveries.length >= 1 &&
    early.length === 0 &&
    deliveries.every((wake) => wake.verified && wake.status === 200) &&
    zeroBeforeDue &&
    coldStart;
  return {
    deliveries: deliveries.length,
    early: early.length,
    wakeDelaySeconds: first === undefined ? null : (first - due) / 1000,
    zeroBeforeDue,
    coldStart,
    pass,
  };
}

/** Retries after 503: every attempt arrives, backoff never shrinks, and the window is long enough. */
export function evaluateRetries({ wakes, fail503 }) {
  const attempts = wakes
    .filter((wake) => wake.probe === "own-retry")
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  const gaps = attempts
    .slice(1)
    .map(
      (wake, index) =>
        (Date.parse(wake.receivedAt) - Date.parse(attempts[index].receivedAt)) / 1000,
    );
  const statuses = attempts.map((wake) => wake.status);
  const sequence = attempts.map((wake) => wake.retryCount);
  // Retry budget from queue config: unlimited attempts within maxRetryDuration.
  const retryWindowSeconds = Number.parseInt(WAKE_QUEUE_LIMITS.retryConfig.maxRetryDuration, 10);
  const pass =
    attempts.length === fail503 + 1 &&
    statuses.slice(0, fail503).every((status) => status === 503) &&
    statuses[fail503] === 200 &&
    sequence.every((count, index) => count === index) &&
    gaps.every((gap, index) => index === 0 || gap >= gaps[index - 1] * 0.8) &&
    retryWindowSeconds > M09_LIMITS.longestTransactionSeconds;
  return { attempts: attempts.length, statuses, gapsSeconds: gaps, retryWindowSeconds, pass };
}

/** OIDC claims: every delivered token verified and carried email + email_verified for the invoker. */
export function evaluateOidc({ wakes }) {
  const delivered = wakes.filter((wake) => wake.claims);
  const pass =
    delivered.length > 0 &&
    delivered.every(
      (wake) =>
        wake.verified &&
        wake.claims.hasEmail &&
        wake.claims.emailMatches &&
        wake.claims.emailVerified &&
        wake.claims.audienceMatches &&
        ["https://accounts.google.com", "accounts.google.com"].includes(wake.claims.issuer) &&
        wake.claims.lifetimeSeconds <= 3600,
    );
  return {
    tokens: delivered.length,
    hasEmail: delivered.every((wake) => wake.claims.hasEmail),
    emailVerified: delivered.every((wake) => wake.claims.emailVerified),
    pass,
  };
}

/** The queue probe's own cases, judged against QUEUE_CASES; missing cases fail. */
export function evaluateQueueProbe(report) {
  const results = report?.results ?? [];
  const expected = [
    ...Object.keys(QUEUE_CASES),
    ...IDENTITY_CASES,
    "adapter-created",
    "adapter-duplicate",
  ];
  const missing = expected.filter((id) => !results.some((result) => result.case === id));
  return {
    subject: report?.subject ?? null,
    cases: results.map(({ case: id, status, expected: want, pass }) => ({
      case: id,
      status,
      expected: want,
      pass,
    })),
    missing,
    pass: report?.pass === true && missing.length === 0 && results.every((result) => result.pass),
  };
}

/**
 * Isolation (M09.b/e): the other app was never woken by app A's tasks. IAM denials happen at
 * the Cloud Run front end (403, unbilled) before any instance starts.
 */
export function evaluateIsolation({ otherWakes, otherRequests, otherStarts, since }) {
  const after = (at) => Date.parse(at) >= Date.parse(since);
  const woken = otherWakes.filter((wake) => after(wake.receivedAt));
  const allowed = otherRequests.filter((request) => after(request.at) && request.status < 400);
  const denied = otherRequests.filter((request) => after(request.at) && request.status === 403);
  const started = otherStarts.filter(after);
  return {
    woken: woken.length,
    allowedRequests: allowed.length,
    deniedRequests: denied.length,
    starts: started.length,
    pass: woken.length === 0 && allowed.length === 0 && denied.length >= 1 && started.length === 0,
  };
}

/** M09.b: a principal's bindings across inventoried policies, by resource. */
export function principalBindings(policies, member) {
  return policies.flatMap(({ resource, policy }) =>
    (policy?.bindings ?? [])
      .filter((binding) => binding.members?.includes(member))
      .map((binding) => ({ resource, role: binding.role })),
  );
}
export function evaluateBuilder({ policies, builder, repository }) {
  const bindings = principalBindings(policies, `serviceAccount:${builder}`);
  const pass =
    bindings.length === 1 &&
    bindings[0].resource === repository &&
    bindings[0].role === "roles/artifactregistry.writer";
  return { bindings, pass };
}

/** M09.a: every owned resource is gone; anything left is listed by name. */
export function evaluateCleanup(inventory) {
  const leftovers = Object.entries(inventory).flatMap(([kind, names]) =>
    names.map((name) => `${kind}:${name}`),
  );
  return { leftovers, pass: leftovers.length === 0 };
}

async function until(provider, deadlineMs, check, everyMs = 15_000) {
  const end = +provider.now() + deadlineMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (+provider.now() >= end) return null;
    await provider.wait(everyMs);
  }
}

/**
 * The ordered live run. Spend starts at `setUp`; `tearDown` runs on every path after it.
 * Returns the case map; throws only for guard failures before anything is created.
 */
export async function runM09Suite(env, provider) {
  const approval = m09Approval(env);
  const missing = SUITE_PROVIDER_METHODS.filter((name) => typeof provider[name] !== "function");
  if (missing.length) throw new Error(`Provider is missing ${missing.join(", ")}; nothing created`);
  const runId = env.EMBODY_M09_RUN_ID ?? randomBytes(4).toString("hex");
  const projected = await provider.projectedCostUsd();
  if (!(projected > 0) || projected > approval.budgetUsd)
    throw new Error("Projected qualification cost exceeds the approved budget; nothing created");
  const baseline = await provider.preflight(approval);
  const startedAt = provider.now().toISOString();
  const cases = {};
  const record = (id, result) => {
    cases[id] = result;
  };
  let fixture;
  let failure;
  let step = "setUp";
  const at = (name) => {
    step = name;
  };
  try {
    record("M09.a.baseline", { ...baseline.checks, pass: baseline.pass === true });
    fixture = await provider.setUp({ ...approval, runId });
    const probeConfig = {
      runId,
      delaySeconds: M09_LIMITS.delaySeconds,
      fail503: M09_LIMITS.fail503,
      ...fixture.probe,
    };
    at("runQueueProbe");
    const report = await provider.runQueueProbe(fixture, probeConfig);
    record("M09.e.queue-probe", evaluateQueueProbe(report));
    const scheduleAt = report?.results?.find((result) => result.case === "own-delayed")?.scheduleAt;
    const executed = report?.results?.find((result) => result.case === "own-now")?.task;

    at("dedup");
    // Duplicate names stay rejected after the task executed (de-duplication window).
    const ran = await until(provider, 10 * 60_000, async () =>
      (await provider.wakes(fixture, "own")).some(
        (wake) => wake.probe === "own-now" && wake.status === 200,
      ),
    );
    const recreated = ran && executed ? await provider.recreateTask(fixture, executed) : null;
    record("M09.e.dedup-after-execution", {
      executed: Boolean(ran),
      status: recreated,
      pass: recreated === 409,
    });

    at("retry");
    await until(provider, 15 * 60_000, async () =>
      (await provider.wakes(fixture, "own")).some(
        (wake) => wake.probe === "own-retry" && wake.status === 200,
      ),
    );
    record(
      "M09.e.retry-503",
      evaluateRetries({ wakes: await provider.wakes(fixture, "own"), fail503: M09_LIMITS.fail503 }),
    );

    // Emergency stop: a paused queue keeps tasks and dispatches none until resumed.
    at("emergency-stop");
    const pausedAt = provider.now();
    await provider.pause(fixture);
    await provider.wait(M09_LIMITS.pausePropagationMs);
    await provider.enqueueOperatorTask(fixture, "pause-check");
    await provider.wait(120_000);
    const duringPause = (await provider.wakes(fixture, "own")).filter(
      (wake) => wake.probe === "pause-check",
    );
    await provider.resume(fixture);
    const afterResume = await until(provider, 10 * 60_000, async () =>
      (await provider.wakes(fixture, "own")).some((wake) => wake.probe === "pause-check"),
    );
    record("M09.d.emergency-stop", {
      pausedAt: pausedAt.toISOString(),
      deliveredWhilePaused: duringPause.length,
      deliveredAfterResume: Boolean(afterResume),
      pass: duringPause.length === 0 && Boolean(afterResume),
    });

    at("externalCalls");
    record("M09.e.unauthenticated", await provider.externalCalls(fixture));

    // Wait for the delayed wake, then judge it from logs and provider metrics.
    const due = Date.parse(scheduleAt ?? "");
    if (Number.isFinite(due)) await provider.wait(Math.max(0, due - +provider.now() + 5 * 60_000));
    at("delayed-wake");
    const wakes = await provider.wakes(fixture, "own");
    const points = await provider.instanceSeries(fixture, "own", startedAt);
    record(
      "M09.e.delayed-wake",
      evaluateDelayedWake({
        scheduleAt: scheduleAt ?? "invalid",
        wakes,
        starts: await provider.starts(fixture, "own"),
        points,
      }),
    );
    record("M09.e.oidc-claims", evaluateOidc({ wakes }));
    record("M09.d.scaling", evaluateScaling(await provider.serviceConfig(fixture, "own")));
    record("M09.d.zero", {
      intervals: zeroIntervals(points),
      pass: zeroIntervals(points).length > 0,
    });
    record(
      "M09.b.cross-app",
      evaluateIsolation({
        otherWakes: await provider.wakes(fixture, "other"),
        otherRequests: await provider.requests(fixture, "other"),
        otherStarts: await provider.starts(fixture, "other"),
        since: fixture.settledAt ?? startedAt,
      }),
    );
    at("iamInventory");
    record("M09.b.builder", evaluateBuilder(await provider.iamInventory(fixture)));
    at("sql");
    const sql = await provider.sql(fixture);
    for (const [id, result] of Object.entries(sql)) record(`M09.c.${id}`, result);
  } catch (error) {
    failure = error;
  } finally {
    // setUp may fail part-way, so tear down by run ID whether or not it returned.
    {
      // One retry: teardown is repeatable and a transient provider error must not strand resources.
      let lastError;
      for (let attempt = 0; attempt < 2 && !cases["M09.a.teardown"]?.pass; attempt++) {
        try {
          await provider.tearDown(fixture ?? { runId });
          record(
            "M09.a.teardown",
            evaluateCleanup(await provider.inventory({ ...approval, runId })),
          );
        } catch (error) {
          lastError = error;
          record("M09.a.teardown", {
            pass: false,
            error: `teardown failed (${safeError(error)}); reconcile by owned names`,
          });
        }
      }
      void lastError;
    }
  }
  const measured = await provider.measuredUsage(fixture).catch(() => null);
  const cost = measured ? qualificationEstimate(measured) : null;
  const pass =
    !failure &&
    Object.values(cases).length > 0 &&
    Object.values(cases).every((result) => result.pass === true);
  return {
    runId,
    startedAt,
    finishedAt: provider.now().toISOString(),
    projectedUsd: projected,
    cost,
    cases,
    error: failure ? `suite aborted at ${step}: ${safeError(failure)}` : null,
    pass: pass && cost !== null && cost.estimatedUpperUsd <= approval.budgetUsd,
  };
}
