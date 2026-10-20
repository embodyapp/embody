import { createHash } from "node:crypto";
import { UnauthenticatedError } from "@embody/core";
import type { PlatformInvokerVerifier } from "@embody/auth";

/**
 * Shared queue and task-ingress infrastructure (M12 step 6). App wake-ups (M20), the deployment
 * controller (M12) and the event relay (M21) all use this one path: a named task, created on a
 * Cloud Tasks queue, delivered as an HTTPS POST carrying the provider's OIDC token for a platform
 * invoker identity. See docs/mvp/DEPLOYMENTS.md and docs/mvp/DURABLE.md.
 */

/** One task: a deterministic name, the time it is due and a JSON body. */
export interface QueueTask<Body = unknown> {
  /** Deterministic; the queue rejects a name it has seen, which counts as success. */
  readonly name: string;
  readonly scheduleAt: string;
  readonly body: Body;
}
/** The queue port. Production uses {@link cloudTasksQueue}; tests use {@link MemoryTaskQueue}. */
export interface TaskQueue<Body = unknown> {
  /** Creates the task, or reports that one with this name already exists. Throws on failure. */
  enqueue(task: QueueTask<Body>): Promise<"created" | "duplicate">;
}

/** Task names: `<kind>-<40 hex>`, at most 63 characters, valid for Cloud Tasks. */
export function deterministicTaskName(
  kind: string,
  ...parts: readonly (string | number | undefined)[]
): string {
  if (!/^[a-z][a-z0-9]{0,20}$/.test(kind)) throw new TypeError("Invalid task kind");
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u0000"))
    .digest("hex")
    .slice(0, 40);
  return `${kind}-${digest}`;
}

/** In-memory queue with Cloud Tasks name semantics, for tests and local development. */
export class MemoryTaskQueue<Body = unknown> implements TaskQueue<Body> {
  /** Every task created, in creation order. */
  public readonly tasks: QueueTask<Body>[] = [];
  /** When true, every enqueue fails, as during a queue outage. */
  public outage = false;
  private readonly names = new Set<string>();
  private readonly delivered = new Set<string>();
  public enqueue(task: QueueTask<Body>): Promise<"created" | "duplicate"> {
    if (this.outage) return Promise.reject(new Error("Task queue unavailable"));
    if (this.names.has(task.name)) return Promise.resolve("duplicate");
    this.names.add(task.name);
    this.tasks.push(task);
    return Promise.resolve("created");
  }
  /** Tasks due at `now` that have not been delivered yet, oldest first. */
  public due(now: Date = new Date()): readonly QueueTask<Body>[] {
    return this.tasks
      .filter((task) => !this.delivered.has(task.name) && Date.parse(task.scheduleAt) <= +now)
      .sort((a, b) => Date.parse(a.scheduleAt) - Date.parse(b.scheduleAt));
  }
  /** Tasks not yet delivered, whatever their due time. */
  public pending(): readonly QueueTask<Body>[] {
    return this.tasks.filter((task) => !this.delivered.has(task.name));
  }
  /** Marks a task delivered, as the queue does after a 2xx response. */
  public acknowledge(name: string): void {
    this.delivered.add(name);
  }
  /** Drops a task without delivering it (an operator purge, or retries exhausted). */
  public lose(name: string): void {
    this.delivered.add(name);
  }
}

export interface CloudTasksQueueOptions {
  /** `projects/<project>/locations/<location>/queues/<queue>`. */
  readonly queue: string;
  /** The task target (HTTPS). */
  readonly url: string;
  /** The platform invoker identity Cloud Tasks signs the OIDC token as. */
  readonly invokerEmail: string;
  /** The OIDC token audience the receiver verifies. */
  readonly audience: string;
  /** OAuth access token for the Cloud Tasks API. Defaults to the workload metadata server. */
  readonly accessToken?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  /** Request deadline (default 5 s). */
  readonly timeoutMs?: number;
}

const QUEUE_PATH =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/queues\/[A-Za-z0-9-]{1,100}$/;
const TASK_NAME = /^[A-Za-z0-9_-]{1,500}$/;

/** Workload access token from the local metadata server, cached until a minute before expiry. */
export function metadataAccessToken(fetcher: typeof fetch = fetch): () => Promise<string> {
  let cached: { readonly token: string; readonly until: number } | undefined;
  return async () => {
    if (cached !== undefined && cached.until > Date.now()) return cached.token;
    const response = await fetcher(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: { "metadata-flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok || response.headers.get("metadata-flavor") !== "Google")
      throw new Error("Workload access token is unavailable");
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number")
      throw new Error("Workload access token is invalid");
    cached = { token: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    return cached.token;
  };
}

/**
 * Cloud Tasks adapter. The target URL, invoker identity and audience are fixed by the platform
 * when the adapter is built; a task contributes only its name, due time and JSON body, so no
 * caller can redirect a task or choose the identity it is delivered with.
 */
export function cloudTasksQueue<Body = unknown>(options: CloudTasksQueueOptions): TaskQueue<Body> {
  if (!QUEUE_PATH.test(options.queue)) throw new TypeError("Invalid Cloud Tasks queue path");
  if (!options.url.startsWith("https:") || !options.audience.startsWith("https:"))
    throw new TypeError("Cloud Tasks target URL and audience must be HTTPS");
  if (!/^[a-z0-9-]+@[a-z0-9.-]+$/.test(options.invokerEmail))
    throw new TypeError("Invalid Cloud Tasks invoker identity");
  const fetcher = options.fetch ?? fetch;
  const accessToken = options.accessToken ?? metadataAccessToken(fetcher);
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    async enqueue(task: QueueTask<Body>): Promise<"created" | "duplicate"> {
      if (!TASK_NAME.test(task.name) || !Number.isFinite(Date.parse(task.scheduleAt)))
        throw new TypeError("Invalid task");
      const response = await fetcher(
        `https://cloudtasks.googleapis.com/v2/${options.queue}/tasks`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            task: {
              name: `${options.queue}/tasks/${task.name}`,
              scheduleTime: task.scheduleAt,
              httpRequest: {
                httpMethod: "POST",
                url: options.url,
                headers: { "content-type": "application/json" },
                body: Buffer.from(JSON.stringify(task.body)).toString("base64"),
                oidcToken: {
                  serviceAccountEmail: options.invokerEmail,
                  audience: options.audience,
                },
              },
            },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (response.ok) return "created";
      if (response.status === 409) return "duplicate";
      throw new Error(`Task queue rejected the task (${response.status})`);
    },
  };
}

/** Largest accepted bearer token on task ingress (provider OIDC tokens are about 1 KiB). */
export const MAX_TASK_TOKEN_BYTES = 4096;

/**
 * Authenticated task ingress: the request must carry exactly one `Authorization: Bearer` header
 * with a provider OIDC token that the platform invoker verifier accepts (issuer, signature, exact
 * audience, verified invoker email, short lifetime, not expired). Gateway principal tokens
 * (`X-Gateway-Auth`) never authorize a task, and other headers (Cloud Tasks' `X-CloudTasks-*`,
 * forwarding headers) are never trusted: they can be set by any caller. Resolves only for a
 * current platform invoker token; rejects with {@link UnauthenticatedError} otherwise.
 */
export async function authenticateTask(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  verifier: PlatformInvokerVerifier,
): Promise<void> {
  const authorization = headers["authorization"];
  if (typeof authorization !== "string")
    throw new UnauthenticatedError("Platform invoker token is required");
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(authorization);
  if (!match?.[1] || match[1].length > MAX_TASK_TOKEN_BYTES)
    throw new UnauthenticatedError("Platform invoker token is required");
  await verifier.verify(match[1]);
}
