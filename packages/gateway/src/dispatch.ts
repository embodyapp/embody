import {
  EmbodyError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnavailableError,
  type EmbodyErrorCode,
  type Principal,
  type ProgressUpdate,
  type ValidationIssue,
} from "@embody/core";

/** Client surface that initiated an execution; recorded in audit. */
export type DispatchSurface = "http" | "stream" | "mcp";

/** Sanitized, bounded error that is safe to show to API and MCP clients. */
export interface PublicError {
  readonly code: EmbodyErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly details?: readonly ValidationIssue[];
  readonly retryAfterSeconds?: number;
}

export type ExecutionStreamEvent =
  | { readonly type: "progress"; readonly update: ProgressUpdate }
  | { readonly type: "result"; readonly value: unknown }
  | { readonly type: "error"; readonly error: PublicError };

const ERROR_CODES: ReadonlySet<string> = new Set<EmbodyErrorCode>([
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "HOOK_VETO",
  "DEPENDENCY_ERROR",
  "DUPLICATE_REGISTRATION",
  "UNAVAILABLE",
  "INTERNAL_ERROR",
]);
const MAX_MESSAGE = 2_000;
const MAX_ISSUES = 50;
const MAX_PATH = 20;
const MAX_SEGMENT = 200;
const MAX_FRAME = 64 * 1024;
// C0/C1 controls except tab and newline, plus bidirectional override/isolate characters.
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const UNSAFE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

/** Strips control/bidi characters and bounds length so relayed text is safe to display. */
export function sanitizeText(value: string, max = MAX_MESSAGE): string {
  const clean = value.replace(UNSAFE, "");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function issues(value: unknown): readonly ValidationIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: ValidationIssue[] = [];
  for (const item of value.slice(0, MAX_ISSUES)) {
    if (item === null || typeof item !== "object") continue;
    const { path, message } = item as { path?: unknown; message?: unknown };
    if (!Array.isArray(path) || typeof message !== "string") continue;
    const segments = path
      .slice(0, MAX_PATH)
      .filter(
        (segment): segment is string | number =>
          typeof segment === "number" || typeof segment === "string",
      )
      .map((segment) =>
        typeof segment === "string" ? sanitizeText(segment, MAX_SEGMENT) : segment,
      );
    result.push({ path: segments, message: sanitizeText(message) });
  }
  return result.length > 0 ? result : undefined;
}

/** Internal fallback used whenever a host response cannot be trusted as a public envelope. */
export function internalError(requestId: string): PublicError {
  return { code: "INTERNAL_ERROR", message: "Tool execution failed", requestId };
}

/**
 * Parses an app host error envelope (`{ error: { code, message, requestId, details? } }`).
 * Hosts already sanitize envelopes for their environment; anything malformed or unknown
 * becomes INTERNAL_ERROR so no unexpected host text reaches clients.
 */
export function parseErrorEnvelope(value: unknown, requestId: string): PublicError {
  if (value === null || typeof value !== "object" || !("error" in value))
    return internalError(requestId);
  const envelope = value.error;
  if (envelope === null || typeof envelope !== "object") return internalError(requestId);
  const { code, message, details } = envelope as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (typeof code !== "string" || !ERROR_CODES.has(code) || typeof message !== "string")
    return internalError(requestId);
  const parsedIssues = issues(details);
  return {
    code: code as EmbodyErrorCode,
    message: sanitizeText(message),
    requestId,
    ...(parsedIssues === undefined ? {} : { details: parsedIssues }),
  };
}

/** Converts a gateway-side failure (before or around the host call) into a public error. */
export function publicErrorFrom(error: unknown, requestId: string): PublicError {
  if (!(error instanceof EmbodyError)) return internalError(requestId);
  const parsedIssues = issues(error.details);
  return {
    code: error.code,
    message: sanitizeText(error.message),
    requestId,
    ...(parsedIssues === undefined ? {} : { details: parsedIssues }),
    ...(error instanceof DispatchRateLimitedError
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
  };
}

/** Rate-limit failure that carries the retry delay to every surface. */
export class DispatchRateLimitedError extends RateLimitedError {
  public constructor(public readonly retryAfterSeconds: number) {
    super(`Rate limited; retry after ${retryAfterSeconds} seconds`);
  }
}

interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/** Incremental, bounded `text/event-stream` frame decoder. */
export class SseFrameDecoder {
  private readonly decoder = new TextDecoder();
  private pending = "";

  public push(chunk: Uint8Array): readonly SseFrame[] {
    this.pending += this.decoder.decode(chunk, { stream: true });
    if (this.pending.length > MAX_FRAME) throw new UnavailableError("Remote frame is too large");
    const frames: SseFrame[] = [];
    let boundary: number;
    while ((boundary = this.pending.indexOf("\n\n")) >= 0) {
      const frame = this.pending.slice(0, boundary);
      this.pending = this.pending.slice(boundary + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (event && data) frames.push({ event, data });
    }
    return frames;
  }
}

/** Interprets one decoded host frame. Unknown events are ignored. */
export function interpretFrame(
  frame: SseFrame,
  requestId: string,
): ExecutionStreamEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(frame.data);
  } catch {
    return frame.event === "progress"
      ? undefined
      : { type: "error", error: internalError(requestId) };
  }
  if (frame.event === "progress") {
    const update = value as { percent?: unknown; message?: unknown } | null;
    if (!update || typeof update.message !== "string") return undefined;
    return {
      type: "progress",
      update: {
        message: update.message,
        ...(typeof update.percent === "number" ? { percent: update.percent } : {}),
      },
    };
  }
  if (frame.event === "result") return { type: "result", value };
  if (frame.event === "error")
    return { type: "error", error: parseErrorEnvelope(value, requestId) };
  return undefined;
}

/** Parses a host `/execute/stream` body into ordered events, ending at the first terminal event. */
export async function* parseExecutionStream(
  body: ReadableStream<Uint8Array>,
  requestId: string,
): AsyncGenerator<ExecutionStreamEvent> {
  const decoder = new SseFrameDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) throw new UnavailableError("Invalid remote stream");
      for (const frame of decoder.push(bytes)) {
        const event = interpretFrame(frame, requestId);
        if (!event) continue;
        yield event;
        if (event.type !== "progress") return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditOutcome = "success" | "failure" | "cancelled";

export interface AuditRecord {
  readonly requestId: string;
  readonly orgId?: string;
  readonly appId?: string;
  readonly target?: string;
  readonly actorId?: string;
  readonly surface?: DispatchSurface;
  readonly outcome: AuditOutcome | (string & {});
  readonly errorCode?: EmbodyErrorCode;
  readonly durationMs: number;
}

/** Destination for gateway audit records. Implementations must not throw. */
export interface AuditSink {
  append(record: AuditRecord): void;
}

/** In-memory sink for tests and development. */
export class MemoryAuditLog implements AuditSink {
  public readonly records: AuditRecord[] = [];
  append(record: AuditRecord): void {
    this.records.push(Object.freeze(record));
  }
}

/** Writes one JSON object per line, for log pipelines. */
export function jsonLineAuditSink(
  write: (line: string) => void = (line) => void process.stdout.write(line),
): AuditSink {
  return {
    append(record) {
      try {
        write(`${JSON.stringify({ type: "embody.audit", ...record })}\n`);
      } catch {
        // Audit output must never fail a request.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface DispatchTarget {
  readonly endpoint: string;
  readonly status: string;
  readonly actions: Readonly<Record<string, unknown>>;
}

export interface DispatchDeps {
  readonly lookup: (appId: string) => DispatchTarget | undefined;
  readonly scopeAllows: (principal: Principal, appId: string, target: string) => boolean;
  readonly limit?: (key: string) => number | undefined;
  readonly issueToken: (principal: Principal, appId: string, requestId: string) => Promise<string>;
  readonly audit: AuditSink;
  readonly now?: () => number;
}

export interface DispatchContext {
  readonly principal: Principal;
  readonly appId: string;
  readonly target: string;
  readonly requestId: string;
  readonly surface: DispatchSurface;
}

export interface PreparedDispatch {
  readonly endpoint: URL;
  readonly headers: Readonly<Record<string, string>>;
  /** Records the audit entry exactly once. */
  finish(outcome: { readonly outcome: AuditOutcome; readonly errorCode?: EmbodyErrorCode }): void;
}

/**
 * Shared preflight for every execution surface: registry health, advertised target, scope,
 * rate limit and downstream token. Failures are audited before the error is rethrown.
 */
export async function prepareDispatch(
  context: DispatchContext,
  deps: DispatchDeps,
): Promise<PreparedDispatch> {
  const now = deps.now ?? Date.now;
  const started = now();
  let finished = false;
  const finish: PreparedDispatch["finish"] = ({ outcome, errorCode }) => {
    if (finished) return;
    finished = true;
    deps.audit.append({
      requestId: context.requestId,
      orgId: context.principal.orgId,
      appId: context.appId,
      target: context.target,
      actorId: context.principal.actorId,
      surface: context.surface,
      outcome,
      ...(errorCode === undefined ? {} : { errorCode }),
      durationMs: now() - started,
    });
  };
  try {
    const registered = deps.lookup(context.appId);
    if (!registered || registered.status !== "healthy")
      throw new UnavailableError(`${context.appId} is temporarily unavailable`);
    if (!(context.target in registered.actions))
      throw new NotFoundError("Target is not advertised");
    if (!deps.scopeAllows(context.principal, context.appId, context.target))
      throw new ForbiddenError(`Not authorized for ${context.appId}.${context.target}`);
    const retry = deps.limit?.(
      `${context.principal.orgId}:${context.principal.actorId}:${context.appId}:${context.target}`,
    );
    if (retry !== undefined) throw new DispatchRateLimitedError(retry);
    const token = await deps.issueToken(context.principal, context.appId, context.requestId);
    return {
      endpoint: new URL(registered.endpoint),
      headers: {
        "content-type": "application/json",
        "x-request-id": context.requestId,
        "x-gateway-auth": `Bearer ${token}`,
      },
      finish,
    };
  } catch (error) {
    finish({
      outcome: "failure",
      errorCode: error instanceof EmbodyError ? error.code : "INTERNAL_ERROR",
    });
    throw error;
  }
}
