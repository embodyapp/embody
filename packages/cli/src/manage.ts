import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AppListSchema,
  AppStatusSchema,
  CapabilitiesSchema,
  DeploymentStatusSchema,
  type AppStatus,
  type Capabilities,
  type DeploymentStatus,
} from "@embody/cloud-contracts";
import { packProject, uploadPacked } from "./source.js";
import { joinUrl, resolveTarget, TargetError, type GatewayTarget } from "./target.js";

/**
 * Stable exit codes (documented in the CLI reference). Scripts branch on these, never on
 * message text.
 */
export const EXIT = {
  /** Unexpected local failure. */
  internal: 1,
  /** Invalid command, flags or local project (including source that cannot be packaged). */
  usage: 2,
  /** The credential is missing, expired, revoked or for another workspace. */
  auth: 3,
  /** The credential lacks the permission (for example a caller key used to deploy). */
  forbidden: 4,
  /** App or deployment not found, or not visible to this credential. */
  notFound: 5,
  /** The gateway or app rejected the request (invalid, conflict, action error). */
  remote: 6,
  /** Gateway unreachable, timed out, rate limited or a dependency outage; retry later. */
  unavailable: 7,
  /** The deployment ended `failed`. */
  deploymentFailed: 8,
  /** The deployment ended `cancelled`. */
  deploymentCancelled: 9,
  /** Waiting stopped at --wait-timeout; the deployment is still running on the server. */
  waitTimeout: 10,
  /** Ctrl-C: local waiting stopped. Nothing was cancelled on the server. */
  interrupted: 130,
} as const;

export interface ManageIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}
export interface ManageContext {
  readonly io: ManageIo;
  readonly fetch: typeof fetch;
  readonly baseUrl: string;
  readonly workspace?: string;
  readonly token: string | undefined;
  readonly output: "json" | "table";
  readonly signal?: AbortSignal;
  /** Per-request deadline (ms). A cold gateway or app may need several seconds to wake. */
  readonly requestTimeoutMs: number;
  /** Status polling interval while waiting (ms). */
  readonly pollMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

const TERMINAL = new Set(["active", "failed", "cancelled"]);
const APP_ID = /^app_[a-z0-9]{8,64}$/;
const APP_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const DEPLOYMENT_ID = /^dep_[a-z0-9]{8,64}$/;

class Failure extends Error {
  public constructor(
    public readonly exit: number,
    message: string,
  ) {
    super(message);
  }
}
class Interrupted extends Error {}

/** Fixed, actionable explanations of the public M02 error codes for a deployment that ended. */
const DEPLOYMENT_HINTS: Readonly<Record<string, string>> = {
  BUILD_FAILED:
    "The project did not install or build with the hosted recipe (Node 24, pnpm 11.25.0, frozen lockfile). Run `pnpm install --frozen-lockfile && pnpm build` locally, fix the error and deploy again.",
  INVALID_INPUT:
    "The source was rejected: commit a current pnpm-lock.yaml (no tarball or git dependencies), keep to supported files, and deploy again (uploads expire after 7 days).",
  UNSUPPORTED_PROFILE:
    'The built app does not match package.json "embody.hosted" (profile or workflows/events/subscriptions flags), or uses an unsupported feature. Fix the declaration and deploy again.',
  LIMIT_EXCEEDED: "The build output or the app exceeded a hosted limit (see the hosted profile).",
  CHECK_FAILED:
    "The release did not pass its readiness checks (the app did not start or report ready, its appId differs from the app's name, or a migration was refused). The previous release keeps serving.",
  STALE_GENERATION:
    "Another deployment or rollback was promoted first. Deploy again to build on the current release.",
  DEPENDENCY_UNAVAILABLE:
    "A platform dependency stayed unavailable. Deploy again with --retry to submit a new attempt.",
  ROLLBACK_INCOMPATIBLE:
    "The rollback target is no longer retained or is incompatible with current data or workflows.",
  CANCELLED: "The deployment was cancelled.",
};

const sleeper = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Interrupted());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Interrupted());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

/** Small flag parser: `values` take one argument, `booleans` none; anything else is an error. */
function parse(
  args: readonly string[],
  values: readonly string[],
  booleans: readonly string[],
): { positionals: string[]; values: Record<string, string>; flags: Set<string> } {
  const positionals: string[] = [];
  const parsed: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (booleans.includes(name)) flags.add(name);
    else if (values.includes(name)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Failure(EXIT.usage, `Missing value for --${name}`);
      parsed[name] = value;
      index += 1;
    } else throw new Failure(EXIT.usage, `Unknown option: --${name}`);
  }
  return { positionals, values: parsed, flags };
}
/** `--<name> <seconds>` as milliseconds; `fallbackSeconds` when absent. */
function seconds(value: string | undefined, name: string, fallbackSeconds: number): number {
  if (value === undefined) return fallbackSeconds * 1000;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 86_400)
    throw new Failure(EXIT.usage, `--${name} must be a number of seconds between 0 and 86400`);
  return n * 1000;
}

/**
 * Reads the static hosted declaration from `package.json` (`embody.hosted`). The CLI never
 * imports or runs project code; the isolated build checks the declaration against the built app.
 */
export async function hostedCapabilities(dir: string): Promise<Capabilities> {
  const help =
    'Declare the hosted profile in package.json, for example "embody": { "hosted": { "profile": "request-only-v1" } } or { "profile": "durable-v1", "workflows": true, "events": false, "subscriptions": true }. create-embody-app writes it.';
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch (error) {
    throw new Failure(
      EXIT.usage,
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "No package.json in the project directory."
        : "package.json is not valid JSON.",
    );
  }
  const declared = (manifest as { embody?: { hosted?: unknown } } | null)?.embody?.hosted;
  if (declared === undefined) throw new Failure(EXIT.usage, `No hosted declaration. ${help}`);
  const value = declared as Record<string, unknown>;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Failure(EXIT.usage, `Invalid hosted declaration. ${help}`);
  const flags = ["workflows", "events", "subscriptions"];
  const known = new Set(["profile", ...flags]);
  if (Object.keys(value).some((key) => !known.has(key)))
    throw new Failure(EXIT.usage, `Unknown key in the hosted declaration. ${help}`);
  const base = {
    crud: true,
    boundedActions: true,
    schedules: false,
    appToAppRpc: false,
    persistentLocalState: false,
    genui: false,
  };
  if (value["profile"] === "request-only-v1" && Object.keys(value).length > 1)
    throw new Failure(
      EXIT.usage,
      `The request-only profile takes no workflows/events/subscriptions flags. ${help}`,
    );
  const candidate =
    value["profile"] === "request-only-v1"
      ? { profile: "request-only-v1", ...base, workflows: false, subscriptions: false }
      : value["profile"] === "durable-v1"
        ? {
            profile: "durable-v1",
            ...base,
            workflows: value["workflows"] ?? false,
            events: value["events"] ?? false,
            subscriptions: value["subscriptions"] ?? false,
          }
        : undefined;
  const parsed = CapabilitiesSchema.safeParse(candidate);
  if (!parsed.success) throw new Failure(EXIT.usage, `Invalid hosted declaration. ${help}`);
  return parsed.data;
}

/** One authenticated management API call. Never logs or returns the token or the URL. */
class Api {
  public constructor(
    private readonly context: ManageContext,
    public readonly target: GatewayTarget & { workspaceId: string },
    private readonly token: string,
  ) {}
  public async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown; retryAfter: string | null }> {
    const timeout = AbortSignal.timeout(this.context.requestTimeoutMs);
    const signal = this.context.signal ? AbortSignal.any([this.context.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.context.fetch(
        joinUrl(this.target.root, `v1/workspaces/${this.target.workspaceId}/${path}`),
        {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal,
        },
      );
    } catch {
      if (this.context.signal?.aborted) throw new Interrupted();
      if (timeout.aborted)
        throw new Failure(
          EXIT.unavailable,
          `The gateway did not answer within ${this.context.requestTimeoutMs / 1000} s (it may be starting from zero instances). Retry, or raise --request-timeout.`,
        );
      throw new Failure(EXIT.unavailable, "Gateway unreachable; check the gateway URL and retry.");
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    return { status: response.status, json, retryAfter: response.headers.get("retry-after") };
  }
}

/** A non-2xx management reply as a stable exit code and an actionable message. */
function rejection(
  reply: { status: number; json: unknown; retryAfter: string | null },
  scope: { permission: string; app?: string; workspace: string },
): Failure {
  const code = (reply.json as { error?: { code?: unknown } } | undefined)?.error?.code;
  const app = scope.app ? ` for app ${scope.app}` : "";
  switch (reply.status) {
    case 401:
      return new Failure(
        EXIT.auth,
        `Authentication failed: the credential is missing, expired, revoked or not for workspace ${scope.workspace}. Ask your workspace operator for a new key and update your profile (EMBODY_TOKEN, --token or --profile).`,
      );
    case 403:
      return new Failure(
        EXIT.forbidden,
        `Permission denied: this credential lacks ${scope.permission}${app}, or the app is disabled. Deploying needs a deployer credential (app-caller keys can only call actions), for example --profile <deployer-profile>.`,
      );
    case 404:
      return new Failure(
        EXIT.notFound,
        `Not found${app} in workspace ${scope.workspace}, or not visible to this credential. List visible apps with \`embody apps status\`.`,
      );
    case 409:
      if (code === "IDEMPOTENCY_CONFLICT")
        return new Failure(
          EXIT.remote,
          "A different submission already uses this deployment key (the upload changed). Deploy again with --retry to submit a new deployment.",
        );
      if (code === "ROLLBACK_INCOMPATIBLE")
        return new Failure(
          EXIT.remote,
          `ROLLBACK_INCOMPATIBLE: ${DEPLOYMENT_HINTS["ROLLBACK_INCOMPATIBLE"]}`,
        );
      if (code === "STALE_GENERATION")
        return new Failure(
          EXIT.remote,
          "The app changed while submitting (another deployment or rollback was promoted). Run the command again.",
        );
      return new Failure(
        EXIT.remote,
        "The request conflicts with the deployment's current state; check it with `embody deployments status`.",
      );
    case 413:
      return new Failure(EXIT.remote, "The request is larger than the hosted limit.");
    case 429:
      return new Failure(
        EXIT.unavailable,
        `Hosted limit reached (at most 3 deployments in progress per app and 10 per workspace, plus request quotas). Wait for running deployments${reply.retryAfter ? ` or retry after ${reply.retryAfter} s` : ""}.`,
      );
    case 400:
    case 415:
      return new Failure(
        EXIT.remote,
        code === "UNSUPPORTED_PROFILE"
          ? 'The gateway refused the hosted profile or capabilities; check package.json "embody.hosted".'
          : "The gateway rejected the request as invalid.",
      );
    default:
      return reply.status >= 500
        ? new Failure(
            EXIT.unavailable,
            "The gateway or one of its dependencies is unavailable; retry. A deployment that was already submitted is not lost: check it with `embody deployments status`.",
          )
        : new Failure(EXIT.remote, `Unexpected gateway response (HTTP ${reply.status}).`);
  }
}

function parseStatus(json: unknown): DeploymentStatus {
  const parsed = DeploymentStatusSchema.safeParse(json);
  if (!parsed.success) throw new Failure(EXIT.unavailable, "Unexpected deployment status reply.");
  return parsed.data;
}

export async function runManageCommand(
  argv: readonly string[],
  context: ManageContext,
): Promise<number> {
  const { io } = context;
  try {
    const [command, sub] = argv;
    if (command === "deploy") return await deploy(argv.slice(1), context);
    if (command === "deployments" && (sub === "status" || sub === "cancel"))
      return await deployments(sub, argv.slice(2), context);
    if (command === "apps" && sub === "status") return await appsStatus(argv.slice(2), context);
    if (command === "rollback") return await rollback(argv.slice(1), context);
    if (command === "mcp" && sub === "setup") return await mcpSetup(argv.slice(2), context);
    throw new Failure(EXIT.usage, USAGE);
  } catch (error) {
    if (error instanceof Interrupted) {
      io.stderr.write("Interrupted.\n");
      return EXIT.interrupted;
    }
    if (error instanceof Failure) {
      io.stderr.write(`${error.message}\n`);
      return error.exit;
    }
    io.stderr.write("Unexpected CLI error.\n");
    return EXIT.internal;
  }
}

export const USAGE = [
  "Usage:",
  "  embody deploy [dir] --app <name|app_id> [--workspace <ws>] [--no-wait] [--wait-timeout <s>] [--retry]",
  "  embody deployments status <dep_id> --app <name|app_id> [--wait] [--wait-timeout <s>]",
  "  embody deployments cancel <dep_id> --app <name|app_id>",
  "  embody rollback <name|app_id> <rel_id> [--no-wait] [--wait-timeout <s>]",
  "  embody apps status [name|app_id]",
  "  embody mcp setup [--app <name>] [--write <file>]",
].join("\n");

function api(context: ManageContext, workspace?: string): Api {
  let target: GatewayTarget;
  try {
    target = resolveTarget(context.baseUrl, workspace ?? context.workspace);
  } catch (error) {
    throw new Failure(EXIT.usage, error instanceof TargetError ? error.message : USAGE);
  }
  if (!target.workspaceId)
    throw new Failure(
      EXIT.usage,
      "A workspace is required: use a gateway URL ending in /w/<ws_id>, --workspace, EMBODY_WORKSPACE or a profile workspace.",
    );
  if (!context.token)
    throw new Failure(
      EXIT.auth,
      "Authentication token is required (EMBODY_TOKEN, --token or a protected profile).",
    );
  return new Api(context, target as GatewayTarget & { workspaceId: string }, context.token);
}

async function listApps(client: Api): Promise<AppStatus[]> {
  const reply = await client.call("GET", "apps");
  if (reply.status !== 200)
    throw rejection(reply, { permission: "app:read", workspace: client.target.workspaceId });
  const parsed = AppListSchema.safeParse(reply.json);
  if (!parsed.success) throw new Failure(EXIT.unavailable, "Unexpected app list reply.");
  return parsed.data.apps;
}

/** `--app` takes the app ID or its name (namespace); names are resolved through the app list. */
async function resolveApp(client: Api, app: string | undefined): Promise<AppStatus> {
  if (!app) throw new Failure(EXIT.usage, "--app <name|app_id> is required");
  if (APP_ID.test(app)) {
    const reply = await client.call("GET", `apps/${app}`);
    if (reply.status !== 200)
      throw rejection(reply, {
        permission: "app:read",
        app,
        workspace: client.target.workspaceId,
      });
    const parsed = AppStatusSchema.safeParse(reply.json);
    if (!parsed.success) throw new Failure(EXIT.unavailable, "Unexpected app status reply.");
    return parsed.data;
  }
  if (!APP_NAME.test(app)) throw new Failure(EXIT.usage, "--app must be an app name or app_… ID");
  const found = (await listApps(client)).find((entry) => entry.name === app);
  if (!found)
    throw new Failure(
      EXIT.notFound,
      `No app named ${app} in workspace ${client.target.workspaceId} is visible to this credential. Your workspace operator reserves apps; list them with \`embody apps status\`.`,
    );
  return found;
}

function label(app: AppStatus): string {
  return app.name ? `${app.name} (${app.appId})` : app.appId;
}
function hints(deploymentId: string, app: AppStatus): string {
  const ref = app.name ?? app.appId;
  return `  Status: embody deployments status ${deploymentId} --app ${ref} --wait\n  Cancel: embody deployments cancel ${deploymentId} --app ${ref}`;
}

/**
 * Waits for a terminal state by polling status (the server holds the job; the CLI holds
 * nothing). Ctrl-C and --wait-timeout stop only the local wait.
 */
async function wait(
  client: Api,
  app: AppStatus,
  first: DeploymentStatus,
  context: ManageContext,
  timeoutMs: number,
): Promise<{ status: DeploymentStatus; outcome: "terminal" | "interrupted" | "timeout" }> {
  const now = context.now ?? Date.now;
  const sleep = context.sleep ?? sleeper;
  const deadline = now() + timeoutMs;
  let status = first;
  let shown = first.state;
  let pollMs = context.pollMs ?? 2_000;
  let unavailable = false;
  context.io.stderr.write(`  state: ${status.state}\n`);
  while (!TERMINAL.has(status.state)) {
    if (now() >= deadline) return { status, outcome: "timeout" };
    try {
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())), context.signal);
      if (context.signal?.aborted) throw new Interrupted();
      const reply = await client.call(
        "GET",
        `apps/${status.appId}/deployments/${status.deploymentId}`,
      );
      if (reply.status !== 200)
        throw rejection(reply, {
          permission: "deployment:read",
          app: label(app),
          workspace: client.target.workspaceId,
        });
      status = parseStatus(reply.json);
      unavailable = false;
      pollMs = context.pollMs ?? 2_000;
    } catch (error) {
      if (error instanceof Interrupted || context.signal?.aborted)
        return { status, outcome: "interrupted" };
      if (!(error instanceof Failure) || error.exit !== EXIT.unavailable) throw error;
      // Disconnected or cold: keep polling; the deployment continues server-side.
      if (!unavailable)
        context.io.stderr.write("  status temporarily unavailable; still waiting…\n");
      unavailable = true;
      pollMs = Math.min(15_000, pollMs * 2);
      continue;
    }
    if (status.state !== shown) {
      context.io.stderr.write(
        `  state: ${status.state}${status.stageAttempt > 1 ? ` (attempt ${status.stageAttempt})` : ""}\n`,
      );
      shown = status.state;
    }
  }
  return { status, outcome: "terminal" };
}

/** Prints the final status and returns its exit code. */
function finish(
  context: ManageContext,
  app: AppStatus,
  result: { status: DeploymentStatus; outcome: "terminal" | "interrupted" | "timeout" },
): number {
  const { io } = context;
  const { status } = result;
  if (context.output === "json") io.stdout.write(`${JSON.stringify(status)}\n`);
  if (result.outcome === "interrupted") {
    io.stderr.write(
      `Stopped waiting. Deployment ${status.deploymentId} was NOT cancelled and continues on the server.\n${hints(status.deploymentId, app)}\n`,
    );
    return EXIT.interrupted;
  }
  if (result.outcome === "timeout") {
    io.stderr.write(
      `Still ${status.state} after --wait-timeout; the deployment continues on the server.\n${hints(status.deploymentId, app)}\n`,
    );
    return EXIT.waitTimeout;
  }
  if (status.state === "active") {
    if (context.output !== "json")
      io.stdout.write(
        `Deployment ${status.deploymentId} is active: release ${status.releaseId} of ${label(app)}.\n  Discover: embody apps list\n  Call:     embody ${app.name ?? "<app>"} <entity|action> …\n  MCP:      embody mcp setup --app ${app.name ?? "<app>"}\n`,
      );
    return 0;
  }
  if (status.state === "cancelled") {
    if (context.output !== "json")
      io.stdout.write(`Deployment ${status.deploymentId} was cancelled.\n`);
    io.stderr.write(
      "The previous release (if any) keeps serving. Database migrations already applied are not undone.\n",
    );
    return EXIT.deploymentCancelled;
  }
  const code = status.error?.code ?? "DEPENDENCY_UNAVAILABLE";
  if (context.output !== "json")
    io.stdout.write(`Deployment ${status.deploymentId} failed: ${code}.\n`);
  io.stderr.write(
    `${code}: ${status.error?.message ?? ""} ${DEPLOYMENT_HINTS[code] ?? ""}\nThe previous release (if any) keeps serving.\n`,
  );
  return EXIT.deploymentFailed;
}

async function deploy(args: readonly string[], context: ManageContext): Promise<number> {
  const { io } = context;
  const options = parse(args, ["app", "workspace", "wait-timeout"], ["no-wait", "wait", "retry"]);
  if (options.positionals.length > 1) throw new Failure(EXIT.usage, USAGE);
  const dir = options.positionals[0] ?? ".";
  const waitTimeout = seconds(options.values["wait-timeout"], "wait-timeout", 1_800);
  // Local checks first: nothing is sent for a project that cannot deploy.
  const capabilities = await hostedCapabilities(dir);
  const packedResult = await packProject(dir);
  if (!packedResult.ok)
    throw new Failure(packedResult.internal ? EXIT.internal : EXIT.usage, packedResult.message);
  const packed = packedResult.packed;
  const client = api(context, options.values["workspace"]);
  const app = await resolveApp(client, options.values["app"]);
  if (app.status !== "enabled")
    throw new Failure(
      EXIT.forbidden,
      `App ${label(app)} is ${app.status}; it cannot be deployed. Ask your workspace operator.`,
    );
  io.stderr.write(
    `Packaged ${packed.files.length} files (${packed.bytes} bytes, ${packed.excluded.length} excluded) as ${packed.digest}.\n`,
  );
  const uploaded = await uploadPacked(packed, {
    fetch: context.fetch,
    root: client.target.root,
    workspace: client.target.workspaceId,
    app: app.appId,
    token: context.token!,
    timeoutMs: context.requestTimeoutMs,
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (!uploaded.ok) {
    if (uploaded.exit === "interrupted") throw new Interrupted();
    throw new Failure(EXIT[uploaded.exit], uploaded.message);
  }
  io.stderr.write(`Uploaded source ${uploaded.status.uploadId}.\n`);
  // The key binds source and app generation: rerunning after a lost reply resumes the same
  // deployment instead of building again. --retry asks for a new attempt.
  const nonce = options.flags.has("retry") ? `_r${randomBytes(6).toString("hex")}` : "";
  const submission = {
    version: 1,
    workspaceId: client.target.workspaceId,
    appId: app.appId,
    idempotencyKey: `deploy_${packed.digest.slice(7, 39)}_g${app.generation}${nonce}`,
    source: {
      uploadId: uploaded.status.uploadId,
      digest: packed.digest,
      bytes: packed.bytes,
    },
    expectedGeneration: app.generation,
    capabilities,
    secretReferences: [],
  };
  let reply;
  try {
    reply = await client.call("POST", `apps/${app.appId}/deployments`, submission);
  } catch (error) {
    if (
      error instanceof Interrupted ||
      (error instanceof Failure && error.exit === EXIT.unavailable)
    )
      throw new Failure(
        error instanceof Interrupted ? EXIT.interrupted : EXIT.unavailable,
        "No answer to the deployment submission; it may or may not have been accepted. Run the same command again: it resumes the same deployment (same source and app generation) instead of starting another.",
      );
    throw error;
  }
  if (reply.status !== 200 && reply.status !== 202)
    throw rejection(reply, {
      permission: "deployment:submit",
      app: label(app),
      workspace: client.target.workspaceId,
    });
  const status = parseStatus(reply.json);
  io.stderr.write(
    `${reply.status === 200 ? "Resuming existing" : "Submitted"} deployment ${status.deploymentId} for ${label(app)}.\n${hints(status.deploymentId, app)}\n`,
  );
  if (options.flags.has("no-wait")) {
    io.stdout.write(
      context.output === "json"
        ? `${JSON.stringify(status)}\n`
        : `${status.deploymentId} ${status.state}\n`,
    );
    return 0;
  }
  return finish(context, app, await wait(client, app, status, context, waitTimeout));
}

/**
 * M13 rollback through the gateway: a new fenced deployment of a retained release's artifact
 * (fresh candidate and checks), followed like a deploy. A retry at the same generation replays it.
 */
async function rollback(args: readonly string[], context: ManageContext): Promise<number> {
  const options = parse(args, ["workspace", "wait-timeout"], ["no-wait"]);
  const [appRef, releaseId] = options.positionals;
  if (options.positionals.length !== 2 || !releaseId || !/^rel_[a-z0-9]{8,64}$/.test(releaseId))
    throw new Failure(EXIT.usage, `An app and a release ID (rel_…) are required.\n${USAGE}`);
  const waitTimeout = seconds(options.values["wait-timeout"], "wait-timeout", 1_800);
  const client = api(context, options.values["workspace"]);
  const app = await resolveApp(client, appRef);
  const reply = await client.call("POST", `apps/${app.appId}/rollback`, {
    version: 1,
    workspaceId: client.target.workspaceId,
    appId: app.appId,
    operation: "rollback",
    expectedGeneration: app.generation,
    releaseId,
  });
  if (reply.status !== 200 && reply.status !== 202)
    throw rejection(reply, {
      permission: "app:rollback",
      app: label(app),
      workspace: client.target.workspaceId,
    });
  const status = parseStatus(reply.json);
  context.io.stderr.write(
    `${reply.status === 200 ? "Resuming existing" : "Submitted"} rollback ${status.deploymentId} of ${label(app)} to ${releaseId}.\n${hints(status.deploymentId, app)}\n`,
  );
  if (options.flags.has("no-wait")) {
    context.io.stdout.write(
      context.output === "json"
        ? `${JSON.stringify(status)}\n`
        : `${status.deploymentId} ${status.state}\n`,
    );
    return 0;
  }
  return finish(context, app, await wait(client, app, status, context, waitTimeout));
}

async function deployments(
  sub: "status" | "cancel",
  args: readonly string[],
  context: ManageContext,
): Promise<number> {
  const options = parse(args, ["app", "workspace", "wait-timeout"], ["wait"]);
  const id = options.positionals[0];
  if (options.positionals.length !== 1 || !id || !DEPLOYMENT_ID.test(id))
    throw new Failure(EXIT.usage, `A deployment ID (dep_…) is required.\n${USAGE}`);
  const client = api(context, options.values["workspace"]);
  const app = await resolveApp(client, options.values["app"]);
  const scope = {
    app: label(app),
    workspace: client.target.workspaceId,
  };
  const read = async () => {
    const reply = await client.call("GET", `apps/${app.appId}/deployments/${id}`);
    if (reply.status !== 200) throw rejection(reply, { ...scope, permission: "deployment:read" });
    return parseStatus(reply.json);
  };
  const current = await read();
  if (sub === "status") {
    if (options.flags.has("wait"))
      return finish(
        context,
        app,
        await wait(
          client,
          app,
          current,
          context,
          seconds(options.values["wait-timeout"], "wait-timeout", 1_800),
        ),
      );
    context.io.stdout.write(
      context.output === "json"
        ? `${JSON.stringify(current)}\n`
        : `${current.deploymentId} ${current.state}${current.releaseId ? ` release ${current.releaseId}` : ""}${current.error ? ` ${current.error.code}: ${current.error.message}` : ""}\n`,
    );
    return 0;
  }
  // Explicit cancellation: one fenced server-side transaction (M02/M12). It either wins and the
  // deployment can no longer promote, or promotion already won and cancellation conflicts.
  if (current.state === "cancelled") {
    context.io.stdout.write(
      context.output === "json"
        ? `${JSON.stringify(current)}\n`
        : `Deployment ${id} is already cancelled.\n`,
    );
    return 0;
  }
  if (TERMINAL.has(current.state))
    throw new Failure(
      EXIT.remote,
      `Deployment ${id} already ended ${current.state}; nothing to cancel.${current.state === "active" ? " Use a rollback to return to an earlier release." : ""}`,
    );
  const reply = await client.call("POST", `apps/${app.appId}/deployments/${id}/cancel`, {
    version: 1,
    workspaceId: client.target.workspaceId,
    appId: app.appId,
    operation: "cancel",
    deploymentId: id,
    cancellationFence: current.cancellationFence,
  });
  if (reply.status === 409) {
    const after = await read();
    if (after.state === "cancelled") {
      context.io.stdout.write(
        context.output === "json"
          ? `${JSON.stringify(after)}\n`
          : `Deployment ${id} is already cancelled.\n`,
      );
      return 0;
    }
    throw new Failure(
      EXIT.remote,
      `Cancellation lost the race: deployment ${id} is ${after.state}.${after.state === "active" ? " Use a rollback to return to an earlier release." : ""}`,
    );
  }
  if (reply.status !== 200) throw rejection(reply, { ...scope, permission: "deployment:cancel" });
  const cancelled = parseStatus(reply.json);
  context.io.stdout.write(
    context.output === "json"
      ? `${JSON.stringify(cancelled)}\n`
      : `Deployment ${id} cancelled on the server. It can no longer be promoted; database migrations already applied are not undone.\n`,
  );
  return 0;
}

async function appsStatus(args: readonly string[], context: ManageContext): Promise<number> {
  const options = parse(args, ["workspace"], []);
  if (options.positionals.length > 1) throw new Failure(EXIT.usage, USAGE);
  const client = api(context, options.values["workspace"]);
  const apps = options.positionals[0]
    ? [await resolveApp(client, options.positionals[0])]
    : await listApps(client);
  if (context.output === "json")
    context.io.stdout.write(
      `${JSON.stringify(options.positionals[0] ? apps[0] : { version: 1, workspaceId: client.target.workspaceId, apps })}\n`,
    );
  else
    for (const app of apps)
      context.io.stdout.write(
        `${(app.name ?? "-").padEnd(24)} ${app.appId}  ${app.status}  generation ${app.generation}  ${app.activeReleaseId ?? "no release yet"}\n`,
      );
  return 0;
}

/**
 * Prints the supported MCP client setup for this workspace (MD07: Claude Code 2.1.296, direct
 * HTTP). It never prints the credential: `--write` stores it in a private (0600) config file.
 */
async function mcpSetup(args: readonly string[], context: ManageContext): Promise<number> {
  const options = parse(args, ["app", "workspace", "write", "name"], []);
  if (options.positionals.length) throw new Failure(EXIT.usage, USAGE);
  let target: GatewayTarget;
  try {
    target = resolveTarget(context.baseUrl, options.values["workspace"] ?? context.workspace);
  } catch (error) {
    throw new Failure(EXIT.usage, error instanceof TargetError ? error.message : USAGE);
  }
  if (!target.workspaceId)
    throw new Failure(
      EXIT.usage,
      "A workspace is required: use a gateway URL ending in /w/<ws_id>, --workspace, EMBODY_WORKSPACE or a profile workspace.",
    );
  const app = options.values["app"];
  if (app !== undefined && !APP_NAME.test(app))
    throw new Failure(EXIT.usage, "--app must be the app's name (its MCP namespace)");
  const name = options.values["name"] ?? "embody";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
    throw new Failure(EXIT.usage, "--name must be letters, digits, '-' or '_'");
  const url = joinUrl(target.workspaceBase, app ? `mcp/${app}` : "mcp").href;
  const config = (authorization: string) => ({
    mcpServers: { [name]: { type: "http", url, headers: { Authorization: authorization } } },
  });
  const placeholder = "Bearer <workspace credential>";
  const launch = (file: string) =>
    `claude --strict-mcp-config --mcp-config ${file}  # Claude Code 2.1.296 (qualified client)`;
  if (options.values["write"]) {
    if (!context.token)
      throw new Failure(
        EXIT.auth,
        "Authentication token is required to write the config (EMBODY_TOKEN, --token or a profile).",
      );
    const file = options.values["write"];
    await writeFile(file, `${JSON.stringify(config(`Bearer ${context.token}`), null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      throw new Failure(
        EXIT.usage,
        error.code === "EEXIST"
          ? `${file} already exists; choose a new path (it will hold the credential).`
          : `Cannot write ${file}.`,
      );
    });
    await chmod(file, 0o600);
    context.io.stdout.write(
      context.output === "json"
        ? `${JSON.stringify({ url, client: "claude-code@2.1.296", configFile: file })}\n`
        : `Wrote a private MCP config (mode 0600, contains the credential) to ${file}.\n  ${launch(file)}\nDelete the file when you no longer need it.\n`,
    );
    return 0;
  }
  if (context.output === "json")
    context.io.stdout.write(
      `${JSON.stringify({ url, client: "claude-code@2.1.296", config: config(placeholder) })}\n`,
    );
  else
    context.io.stdout.write(
      `MCP endpoint: ${url}\nSend the workspace credential as "Authorization: Bearer …" on every request; there is no MCP session.\n\nClaude Code 2.1.296 (the qualified client): save this as a private file (chmod 600) with your credential in place of the placeholder, or run \`embody mcp setup --write <file>\` to do that without printing it:\n${JSON.stringify(config(placeholder), null, 2)}\n  ${launch("<file>")}\nOther MCP clients are not qualified.\n`,
    );
  return 0;
}
