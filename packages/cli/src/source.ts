import { writeFile } from "node:fs/promises";
import {
  SOURCE_ADMISSION,
  SourceErrorCodeSchema,
  SourcePackError,
  SourceStatusSchema,
  packSource,
  sourceError,
  type SourceErrorCode,
  type SourceStatus,
} from "@embody/cloud-contracts";

export interface SourceCommandContext {
  readonly io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  readonly fetch: typeof fetch;
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly output: "json" | "table";
  readonly signal?: AbortSignal;
  readonly exit: {
    usage: number;
    auth: number;
    forbidden: number;
    notFound: number;
    remote: number;
    unavailable: number;
    internal: number;
  };
}
const USAGE =
  "Usage: embody source pack [dir] [--out <file>] | embody source upload [dir] --workspace <ws_id> --app <app_id>";
const RETRYABLE_REJECTIONS: ReadonlySet<SourceErrorCode> = new Set([
  "DIGEST_MISMATCH",
  "SIZE_MISMATCH",
  "UPLOAD_INCOMPLETE",
  "DEPENDENCY_UNAVAILABLE",
]);
const MAX_ROUNDS = SOURCE_ADMISSION.maxUploadAttempts + 2;

function options(args: string[]): { dir: string; flags: Record<string, string> } | undefined {
  const flags: Record<string, string> = {};
  let dir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--")) {
      const value = args[index + 1];
      if (!["--out", "--workspace", "--app"].includes(arg) || !value || value.startsWith("--"))
        return undefined;
      flags[arg.slice(2)] = value;
      index += 1;
    } else if (dir === undefined) dir = arg;
    else return undefined;
  }
  return { dir: dir ?? ".", flags };
}
function endpoint(base: string, path: string): URL {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
  url.search = "";
  url.hash = "";
  return url;
}
/** Upload targets come from the authenticated gateway; still refuse non-HTTPS remote URLs. */
function uploadTarget(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return url;
  } catch {
    // Fall through.
  }
  return undefined;
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `embody source` packages and uploads source only. It never submits a deployment or starts
 * a build (M12/M14), never imports project files and never prints tokens or upload URLs.
 */
export async function runSourceCommand(
  argv: readonly string[],
  context: SourceCommandContext,
): Promise<number> {
  const { io, exit } = context;
  const fail = (message: string, code: number) => {
    io.stderr.write(`${message}\n`);
    return code;
  };
  const [command, ...rest] = argv;
  const parsed = options(rest);
  if (!parsed || (command !== "pack" && command !== "upload")) return fail(USAGE, exit.usage);
  let packed: Awaited<ReturnType<typeof packSource>>;
  try {
    packed = await packSource(parsed.dir);
  } catch (error) {
    if (error instanceof SourcePackError)
      return fail(`Packaging failed: ${error.message}`, exit.usage);
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return fail("Packaging failed: source directory not found", exit.usage);
    return fail("Packaging failed", exit.internal);
  }
  const summary = {
    digest: packed.digest,
    bytes: packed.bytes,
    files: packed.files.length,
    expandedBytes: packed.expandedBytes,
    excluded: packed.excluded.length,
  };
  if (command === "pack") {
    if (parsed.flags["out"]) await writeFile(parsed.flags["out"], packed.archive, { mode: 0o600 });
    if (context.output === "json")
      io.stdout.write(
        `${JSON.stringify({ ...summary, included: packed.files, excludedPaths: packed.excluded })}\n`,
      );
    else {
      io.stdout.write(`${packed.digest} ${packed.bytes} bytes, ${packed.files.length} files\n`);
      for (const file of packed.files) io.stdout.write(`  + ${file}\n`);
      for (const item of packed.excluded) io.stdout.write(`  - ${item.path} (${item.reason})\n`);
    }
    return 0;
  }
  const workspace = parsed.flags["workspace"];
  const app = parsed.flags["app"];
  if (
    !workspace ||
    !app ||
    !/^ws_[a-z0-9]{8,64}$/.test(workspace) ||
    !/^app_[a-z0-9]{8,64}$/.test(app)
  )
    return fail(USAGE, exit.usage);
  if (!context.token)
    return fail("Authentication token is required (EMBODY_TOKEN or --token)", exit.auth);
  try {
    if (!/^https?:$/.test(new URL(context.baseUrl).protocol)) throw new TypeError();
  } catch {
    return fail("A valid gateway URL is required (EMBODY_GATEWAY_URL or --base-url)", exit.usage);
  }
  const base = `v1/workspaces/${workspace}/apps/${app}/sources`;
  const headers = { authorization: `Bearer ${context.token}`, "content-type": "application/json" };
  // Deterministic archives give a stable key: every retry rebinds to the same upload ID.
  const body = JSON.stringify({
    version: 1,
    workspaceId: workspace,
    appId: app,
    idempotencyKey: `sha256_${packed.digest.slice(7)}`,
    format: SOURCE_ADMISSION.format,
    digest: packed.digest,
    bytes: packed.bytes,
  });
  type Reply = { status: number; source?: SourceStatus; code?: SourceErrorCode };
  const call = async (path: string, init: RequestInit): Promise<Reply> => {
    const response = await context.fetch(endpoint(context.baseUrl, path), {
      ...init,
      headers,
      redirect: "error",
      ...(context.signal ? { signal: context.signal } : {}),
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    const value = (json ?? {}) as { error?: { code?: unknown }; source?: unknown };
    const direct = SourceStatusSchema.safeParse(json);
    const nested = SourceStatusSchema.safeParse(value.source);
    const code = SourceErrorCodeSchema.safeParse(value.error?.code);
    return {
      status: response.status,
      ...(direct.success ? { source: direct.data } : nested.success ? { source: nested.data } : {}),
      ...(code.success ? { code: code.data } : {}),
    };
  };
  const httpFailure = (reply: Reply): number | undefined => {
    if (reply.status === 401) return fail("Authentication failed", exit.auth);
    if (reply.status === 403) return fail(sourceError("FORBIDDEN").message, exit.forbidden);
    if (reply.status === 404) return fail(sourceError("NOT_FOUND").message, exit.notFound);
    return undefined;
  };
  let last: SourceErrorCode | undefined;
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    if (round > 1) await delay(Math.min(2000, 250 * round));
    let created: Reply;
    try {
      created = await call(base, { method: "POST", body });
    } catch {
      if (context.signal?.aborted) return 130;
      last = "DEPENDENCY_UNAVAILABLE";
      continue;
    }
    const denied = httpFailure(created);
    if (denied !== undefined) return denied;
    if (!created.source) {
      last = created.code ?? "DEPENDENCY_UNAVAILABLE";
      if (created.code && !["DEPENDENCY_UNAVAILABLE", "LIMIT_EXCEEDED"].includes(created.code))
        break;
      continue;
    }
    let status = created.source;
    if (status.state === "rejected") {
      last = status.error?.code;
      break;
    }
    if (status.state === "pending") {
      const target = status.upload && uploadTarget(status.upload.url);
      if (!status.upload || !target)
        return fail("Gateway returned an invalid upload target", exit.unavailable);
      try {
        // Storage gets only the signed headers: never the Embody token.
        const put = await context.fetch(target, {
          method: "PUT",
          headers: status.upload.headers,
          body: new Uint8Array(packed.archive),
          redirect: "error",
          signal: context.signal
            ? AbortSignal.any([context.signal, AbortSignal.timeout(120_000)])
            : AbortSignal.timeout(120_000),
        });
        await put.body?.cancel();
        // 412: an earlier attempt already stored the object; completion verifies it.
        if (!put.ok && put.status !== 412) {
          last = "UPLOAD_INCOMPLETE";
          continue;
        }
      } catch {
        if (context.signal?.aborted) return 130;
        last = "UPLOAD_INCOMPLETE";
        continue;
      }
      let completed: Reply;
      try {
        completed = await call(`${base}/${status.uploadId}/complete`, {
          method: "POST",
          body: "{}",
        });
      } catch {
        if (context.signal?.aborted) return 130;
        last = "DEPENDENCY_UNAVAILABLE";
        continue;
      }
      const deniedComplete = httpFailure(completed);
      if (deniedComplete !== undefined) return deniedComplete;
      if (!completed.source || completed.source.state !== "verified") {
        last = completed.source?.error?.code ?? completed.code ?? "DEPENDENCY_UNAVAILABLE";
        if (RETRYABLE_REJECTIONS.has(last)) continue;
        break;
      }
      status = completed.source;
    }
    const result = {
      workspaceId: status.workspaceId,
      appId: status.appId,
      uploadId: status.uploadId,
      state: status.state,
      digest: status.digest,
      bytes: status.bytes,
      files: status.files,
      excluded: packed.excluded.length,
      retainUntil: status.retainUntil,
    };
    io.stdout.write(
      context.output === "json"
        ? `${JSON.stringify(result)}\n`
        : `Source ${result.uploadId} verified (${result.files} files, ${result.bytes} bytes); retained until ${result.retainUntil}. No deployment was submitted.\n`,
    );
    return 0;
  }
  const code = last ?? "DEPENDENCY_UNAVAILABLE";
  return fail(
    `Source upload failed: ${code} (${sourceError(code).message})`,
    RETRYABLE_REJECTIONS.has(code) || code === "LIMIT_EXCEEDED" ? exit.unavailable : exit.remote,
  );
}
