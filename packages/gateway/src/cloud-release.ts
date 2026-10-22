import { cloudRunInvocationToken } from "./cloud-run.js";
import { metadataAccessToken } from "./source-storage.js";
import {
  CANDIDATE_LABELS,
  type AppIdentityAdmin,
  type AppIdentityProvider,
  type CandidateProvider,
  type CandidateSpec,
  type CandidateState,
  type HealthProbe,
} from "./release-stages.js";

/**
 * M13 Google Cloud adapters: Cloud Run candidates (Admin API v2), runtime and invoker service
 * accounts (IAM), the runtime database secret (Secret Manager, metadata and new versions only;
 * the controller never reads a payload) and durable wake queues (Cloud Tasks). Every call uses
 * the controller's workload token, has a deadline, follows no redirects and maps failures to an
 * opaque error. Resource names come from `release-stages` naming only.
 */
export class ReleaseProviderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReleaseProviderError";
  }
}
export interface GoogleReleaseProviderOptions {
  readonly project: string;
  readonly region: string;
  /** For Cloud Run's deterministic service URLs. */
  readonly projectNumber: string;
  /** The platform resource prefix: only candidates labelled with it are listed. */
  readonly prefix: string;
  /** The shared Cloud SQL instance name: runtimes may use the connector for it only. */
  readonly sqlInstance?: string;
  /** The deployment worker service (the wake route): app invokers get `run.invoker` on it. */
  readonly wakeService?: string;
  /** `INGRESS_TRAFFIC_INTERNAL_ONLY` when the gateway reaches apps over the VPC (M05). */
  readonly ingress?: "INGRESS_TRAFFIC_ALL" | "INGRESS_TRAFFIC_INTERNAL_ONLY";
  readonly accessToken?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Retries of a 429 answer (backoff 1, 2, 4, 8 s), bounded by the caller's signal. */
  readonly rateLimitRetries?: number;
  /** Test seam: the first backoff (default 1 s). */
  readonly rateLimitBaseMs?: number;
}
const RUN = "https://run.googleapis.com/v2";
const IAM = "https://iam.googleapis.com/v1";
const SECRETS = "https://secretmanager.googleapis.com/v1";
const TASKS = "https://cloudtasks.googleapis.com/v2";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record(value)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

/**
 * One HTTP client for both sides; authority comes from the credentials it runs with. The
 * deployment worker uses the candidate methods and `account`/secret versions/`mintIdToken`; app
 * provisioning (`AppIdentityAdmin`) runs with an identity-admin credential at reservation.
 */
export class GoogleReleaseProvider
  implements CandidateProvider, AppIdentityProvider, AppIdentityAdmin
{
  private readonly fetcher: typeof fetch;
  private readonly token: () => Promise<string>;
  private readonly timeoutMs: number;
  private readonly rateLimitRetries: number;
  private readonly rateLimitBaseMs: number;
  public constructor(private readonly options: GoogleReleaseProviderOptions) {
    if (
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project) ||
      !/^\d{6,20}$/.test(options.projectNumber)
    )
      throw new TypeError("Invalid project");
    this.fetcher = options.fetch ?? fetch;
    this.token = options.accessToken ?? metadataAccessToken(this.fetcher);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.rateLimitRetries = options.rateLimitRetries ?? 4;
    this.rateLimitBaseMs = options.rateLimitBaseMs ?? 1000;
  }
  private get location(): string {
    return `projects/${this.options.project}/locations/${this.options.region}`;
  }
  private async api(
    url: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const token = await this.token();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ReleaseProviderError("Release provider request failed");
    }
    const text = await response.text().catch(() => "");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? record(JSON.parse(text)) : {};
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed };
  }
  private async ok(
    url: string,
    method: string,
    body: unknown,
    signal: AbortSignal | undefined,
    allow: readonly number[] = [],
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    // Google APIs rate-limit bursts (live run 6: 429 from IAM during app provisioning). Retry a
    // few times with backoff, never past the caller's signal; anything else is the caller's.
    let result = await this.api(url, method, body, signal);
    for (let attempt = 0; result.status === 429 && attempt < this.rateLimitRetries; attempt++) {
      const wait = Math.min(2 ** attempt * this.rateLimitBaseMs, 8 * this.rateLimitBaseMs);
      if (signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, wait).unref());
      result = await this.api(url, method, body, signal);
    }
    if ((result.status < 200 || result.status >= 300) && !allow.includes(result.status))
      throw new ReleaseProviderError(`Release provider returned ${result.status}`);
    return result;
  }
  private email(accountId: string): string {
    return `${accountId}@${this.options.project}.iam.gserviceaccount.com`;
  }
  /** Cloud Run's deterministic URL for a service name in this project and region. */
  public endpointOf(name: string): string {
    return `https://${name}-${this.options.projectNumber}.${this.options.region}.run.app`;
  }

  // Candidates ----------------------------------------------------------------------------

  /** Readiness from the provider's own conditions: the newest revision is the ready one. */
  public static stateOf(service: Record<string, unknown>, endpoint: string): CandidateState {
    const name = text(service["name"]).split("/").at(-1) ?? "";
    const containers = record(service["template"])["containers"];
    const image = Array.isArray(containers) ? record(containers[0])["image"] : undefined;
    const condition = record(service["terminalCondition"]);
    const reconciling = service["reconciling"] === true;
    const created = service["latestCreatedRevision"];
    const ready = service["latestReadyRevision"];
    const urls = Array.isArray(service["urls"]) ? service["urls"] : [];
    const state =
      condition["state"] === "CONDITION_FAILED" && !reconciling
        ? "failed"
        : condition["state"] === "CONDITION_SUCCEEDED" &&
            !reconciling &&
            !!created &&
            created === ready
          ? "ready"
          : "pending";
    return {
      name,
      ...(urls.includes(endpoint) || service["uri"] === endpoint ? { endpoint } : {}),
      ...(typeof image === "string" ? { image } : {}),
      status: state,
      labels: strings(service["labels"]),
      annotations: strings(service["annotations"]),
    };
  }
  public async get(name: string, signal: AbortSignal): Promise<CandidateState | null> {
    const result = await this.ok(
      `${RUN}/${this.location}/services/${name}`,
      "GET",
      undefined,
      signal,
      [404],
    );
    if (result.status === 404) return null;
    return GoogleReleaseProvider.stateOf(result.body, this.endpointOf(name));
  }
  public async create(spec: CandidateSpec, signal: AbortSignal): Promise<void> {
    if (!/@sha256:[a-f0-9]{64}$/.test(spec.image))
      throw new ReleaseProviderError("Candidates deploy digest references only");
    await this.ok(
      `${RUN}/${this.location}/services?serviceId=${spec.name}`,
      "POST",
      {
        labels: spec.labels,
        annotations: spec.annotations,
        ingress: this.options.ingress ?? "INGRESS_TRAFFIC_ALL",
        ...(spec.customAudiences?.length ? { customAudiences: [...spec.customAudiences] } : {}),
        template: {
          serviceAccount: spec.serviceAccount,
          timeout: "60s",
          maxInstanceRequestConcurrency: 4,
          scaling: { minInstanceCount: 0, maxInstanceCount: spec.maxInstances },
          ...(spec.cloudSqlConnection
            ? {
                volumes: [
                  { name: "cloudsql", cloudSqlInstance: { instances: [spec.cloudSqlConnection] } },
                ],
              }
            : {}),
          containers: [
            {
              image: spec.image,
              env: spec.env.map((variable) =>
                variable.secret
                  ? {
                      name: variable.name,
                      valueSource: {
                        secretKeyRef: {
                          secret: variable.secret.secret,
                          version: variable.secret.version,
                        },
                      },
                    }
                  : { name: variable.name, value: variable.value ?? "" },
              ),
              resources: { limits: { cpu: "1", memory: "512Mi" }, cpuIdle: true },
              ...(spec.cloudSqlConnection
                ? { volumeMounts: [{ name: "cloudsql", mountPath: "/cloudsql" }] }
                : {}),
            },
          ],
        },
      },
      signal,
      // An existing service is adopted by the caller after its ownership check.
      [409],
    );
  }
  public async setInvokers(
    name: string,
    members: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    await this.ok(
      `${RUN}/${this.location}/services/${name}:setIamPolicy`,
      "POST",
      { policy: { bindings: [{ role: "roles/run.invoker", members: [...members].sort() }] } },
      signal,
    );
  }
  public async remove(name: string, signal: AbortSignal): Promise<void> {
    await this.ok(`${RUN}/${this.location}/services/${name}`, "DELETE", undefined, signal, [404]);
  }
  /**
   * Every candidate of this platform: follows `nextPageToken` (review B2 of `a561eaf`), bounded
   * at 10 pages of 200, which is more than the regional Cloud Run service quota.
   */
  public async list(signal: AbortSignal): Promise<readonly CandidateState[]> {
    const states: CandidateState[] = [];
    let token = "";
    for (let page = 0; page < 10; page++) {
      const result = await this.ok(
        `${RUN}/${this.location}/services?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
        "GET",
        undefined,
        signal,
      );
      const services = Array.isArray(result.body["services"]) ? result.body["services"] : [];
      for (const service of services) {
        const value = record(service);
        const name = text(value["name"]).split("/").at(-1) ?? "";
        const state = GoogleReleaseProvider.stateOf(value, this.endpointOf(name));
        if (state.labels[CANDIDATE_LABELS.platform] === this.options.prefix) states.push(state);
      }
      token = text(result.body["nextPageToken"]);
      if (!token) break;
    }
    return states;
  }

  // Identities, secrets, queues -------------------------------------------------------------

  public emailOf(accountId: string): string {
    return this.email(accountId);
  }
  public queuePath(queueId: string): string {
    return `${this.location}/queues/${queueId}`;
  }
  /** The provisioned identity, or null (needs only `iam.serviceAccounts.get`). */
  public async account(accountId: string, signal: AbortSignal): Promise<{ email: string } | null> {
    const email = this.email(accountId);
    const found = await this.ok(
      `${IAM}/projects/${this.options.project}/serviceAccounts/${email}`,
      "GET",
      undefined,
      signal,
      [404, 403],
    );
    return found.status === 200 ? { email } : null;
  }
  /** Adds `member` to `role` on one service account (etag-guarded read-modify-write). */
  public async grantOnAccount(
    email: string,
    role: string,
    member: string,
    signal: AbortSignal,
  ): Promise<void> {
    const resource = `${IAM}/projects/-/serviceAccounts/${email}`;
    const { body: policy } = await this.ok(`${resource}:getIamPolicy`, "POST", {}, signal);
    const bindings = Array.isArray(policy["bindings"])
      ? (policy["bindings"] as Record<string, unknown>[])
      : [];
    const current = bindings.find((binding) => binding["role"] === role && !binding["condition"]);
    const members = Array.isArray(current?.["members"]) ? (current["members"] as string[]) : [];
    if (members.includes(member)) return;
    const next = current
      ? bindings.map((binding) =>
          binding === current ? { ...binding, members: [...members, member] } : binding,
        )
      : [...bindings, { role, members: [member] }];
    await this.ok(
      `${resource}:setIamPolicy`,
      "POST",
      { policy: { ...policy, bindings: next } },
      signal,
    );
  }
  public async ensureAccount(
    accountId: string,
    displayName: string,
    signal: AbortSignal,
  ): Promise<{ email: string } | "pending"> {
    const email = this.email(accountId);
    const found = await this.ok(
      `${IAM}/projects/${this.options.project}/serviceAccounts/${email}`,
      "GET",
      undefined,
      signal,
      [404],
    );
    if (found.status !== 404) return { email };
    await this.ok(
      `${IAM}/projects/${this.options.project}/serviceAccounts`,
      "POST",
      { accountId, serviceAccount: { displayName: displayName.slice(0, 100) } },
      signal,
      [409],
    );
    // IAM is eventually consistent: use the account from the next step on.
    return "pending";
  }
  /**
   * Adds the runtime to the project's `roles/cloudsql.client` binding **conditioned on the one
   * shared instance** (review note 1), with an etag-guarded read-modify-write at policy version 3;
   * a concurrent change fails this step and the next one retries. The controller's own project
   * IAM grant is conditioned to modify this role only. Each app adds one member: a project allow
   * policy holds at most 1,500 principals, which bounds apps per project (RELEASES).
   */
  public async ensureDatabaseClient(email: string, signal: AbortSignal): Promise<void> {
    if (!this.options.sqlInstance) throw new ReleaseProviderError("SQL instance not configured");
    const resource = `https://cloudresourcemanager.googleapis.com/v1/projects/${this.options.project}`;
    const member = `serviceAccount:${email}`;
    const role = "roles/cloudsql.client";
    const expression = `resource.name == "projects/${this.options.project}/instances/${this.options.sqlInstance}"`;
    const { body: policy } = await this.ok(
      `${resource}:getIamPolicy`,
      "POST",
      { options: { requestedPolicyVersion: 3 } },
      signal,
    );
    const bindings = Array.isArray(policy["bindings"])
      ? (policy["bindings"] as Record<string, unknown>[])
      : [];
    const ours = bindings.find(
      (binding) =>
        binding["role"] === role &&
        (binding["condition"] as { expression?: unknown } | undefined)?.expression === expression,
    );
    const members = Array.isArray(ours?.["members"]) ? (ours["members"] as string[]) : [];
    if (members.includes(member)) return;
    const next = ours
      ? bindings.map((binding) =>
          binding === ours ? { ...binding, members: [...members, member] } : binding,
        )
      : [
          ...bindings,
          {
            role,
            members: [member],
            condition: { title: "embody app runtimes: shared instance only", expression },
          },
        ];
    await this.ok(
      `${resource}:setIamPolicy`,
      "POST",
      { policy: { ...policy, version: 3, bindings: next } },
      signal,
    );
  }
  /** Allows an app's wake invoker to call the platform wake route on the worker service. */
  public async ensureWakeRoute(invokerEmail: string, signal: AbortSignal): Promise<void> {
    if (!this.options.wakeService) throw new ReleaseProviderError("Wake route not configured");
    const service = `${RUN}/${this.location}/services/${this.options.wakeService}`;
    const member = `serviceAccount:${invokerEmail}`;
    const { body: policy } = await this.ok(`${service}:getIamPolicy`, "GET", undefined, signal);
    const bindings = Array.isArray(policy["bindings"])
      ? (policy["bindings"] as Record<string, unknown>[])
      : [];
    const invoker = bindings.find((binding) => binding["role"] === "roles/run.invoker");
    const members = Array.isArray(invoker?.["members"]) ? (invoker["members"] as string[]) : [];
    if (members.includes(member)) return;
    const next = invoker
      ? bindings.map((binding) =>
          binding === invoker ? { ...binding, members: [...members, member] } : binding,
        )
      : [...bindings, { role: "roles/run.invoker", members: [member] }];
    await this.ok(
      `${service}:setIamPolicy`,
      "POST",
      { policy: { ...policy, bindings: next } },
      signal,
    );
  }
  /** An ID token as `email` for `audience` (the wake forwarder, IAM credentials API). */
  public async mintIdToken(email: string, audience: string, signal: AbortSignal): Promise<string> {
    const result = await this.ok(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${email}:generateIdToken`,
      "POST",
      { audience, includeEmail: true },
      signal,
    );
    const token = text(result.body["token"]);
    if (!token) throw new ReleaseProviderError("Invalid ID token response");
    return token;
  }
  public async ensureSecret(
    secretId: string,
    accessorEmail: string,
    signal: AbortSignal,
  ): Promise<void> {
    const secret = `${SECRETS}/projects/${this.options.project}/secrets/${secretId}`;
    const found = await this.ok(secret, "GET", undefined, signal, [404]);
    if (found.status === 404)
      await this.ok(
        `${SECRETS}/projects/${this.options.project}/secrets?secretId=${secretId}`,
        "POST",
        {
          replication: { automatic: {} },
          labels: { [CANDIDATE_LABELS.platform]: this.options.prefix },
        },
        signal,
        [409],
      );
    await this.ok(
      `${secret}:setIamPolicy`,
      "POST",
      {
        policy: {
          bindings: [
            {
              role: "roles/secretmanager.secretAccessor",
              members: [`serviceAccount:${accessorEmail}`],
            },
          ],
        },
      },
      signal,
    );
  }
  public async latestSecretVersion(secretId: string, signal: AbortSignal): Promise<string | null> {
    const result = await this.ok(
      `${SECRETS}/projects/${this.options.project}/secrets/${secretId}/versions/latest`,
      "GET",
      undefined,
      signal,
      [404, 400],
    );
    if (result.status !== 200 || result.body["state"] !== "ENABLED") return null;
    return text(result.body["name"]).split("/").at(-1) || null;
  }
  public async addSecretVersion(
    secretId: string,
    payload: string,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await this.ok(
      `${SECRETS}/projects/${this.options.project}/secrets/${secretId}:addVersion`,
      "POST",
      { payload: { data: Buffer.from(payload).toString("base64") } },
      signal,
    );
    const version = text(result.body["name"]).split("/").at(-1);
    if (!version || !/^\d+$/.test(version))
      throw new ReleaseProviderError("Invalid secret version");
    return version;
  }
  public async ensureWakeQueue(
    queueId: string,
    invokerAccount: string,
    runtimeEmail: string,
    signal: AbortSignal,
  ): Promise<{ queue: string; invokerEmail: string } | "pending"> {
    const invoker = await this.ensureAccount(
      invokerAccount,
      `embody wake invoker ${queueId}`,
      signal,
    );
    if (invoker === "pending") return "pending";
    const queue = `${this.location}/queues/${queueId}`;
    const found = await this.ok(`${TASKS}/${queue}`, "GET", undefined, signal, [404]);
    if (found.status === 404) {
      await this.ok(
        `${TASKS}/${this.location}/queues`,
        "POST",
        {
          name: queue,
          rateLimits: { maxDispatchesPerSecond: 5, maxConcurrentDispatches: 2 },
          retryConfig: {
            maxAttempts: -1,
            maxRetryDuration: "259200s",
            minBackoff: "1s",
            maxBackoff: "300s",
          },
        },
        signal,
        [409],
      );
      return "pending";
    }
    // The runtime may enqueue only on its own queue and mint OIDC tokens only as its invoker.
    await this.ok(
      `${TASKS}/${queue}:setIamPolicy`,
      "POST",
      {
        policy: {
          bindings: [
            { role: "roles/cloudtasks.enqueuer", members: [`serviceAccount:${runtimeEmail}`] },
          ],
        },
      },
      signal,
    );
    // The runtime creates OIDC tasks as the invoker, and Cloud Tasks' own service agent mints
    // them (as for the M09/M12 invokers). Added, never overwriting other grants.
    for (const member of [
      `serviceAccount:${runtimeEmail}`,
      `serviceAccount:service-${this.options.projectNumber}@gcp-sa-cloudtasks.iam.gserviceaccount.com`,
    ])
      await this.grantOnAccount(invoker.email, "roles/iam.serviceAccountUser", member, signal);
    return { queue, invokerEmail: invoker.email };
  }
}

/**
 * Readiness probe with the controller's own identity (it holds `run.invoker` on its candidates
 * only): `GET <endpoint>/health` must answer `ready: true`. Bounded, no redirects, small body.
 */
export function cloudRunHealthProbe(options: {
  readonly serviceAccountEmail: string;
  readonly fetch?: typeof fetch;
}): HealthProbe {
  const fetcher = options.fetch ?? fetch;
  const token = cloudRunInvocationToken({
    serviceAccountEmail: options.serviceAccountEmail,
    fetch: fetcher,
  });
  return {
    async ready(endpoint, signal) {
      try {
        const response = await fetcher(`${endpoint}/health`, {
          headers: { authorization: `Bearer ${await token(endpoint)}` },
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        });
        if (!response.ok) return false;
        const text = await response.text();
        if (text.length > 4096) return false;
        return (JSON.parse(text) as { ready?: unknown }).ready === true;
      } catch {
        return false;
      }
    },
  };
}
