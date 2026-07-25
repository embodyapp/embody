/**
 * One error taxonomy for the HTTP surface.
 *
 * `Executor.invoke` throws raw — a ZodError, an AuthorizationError, a hook's veto, a
 * bug. A browser needs those to arrive as distinguishable, actionable outcomes, because
 * the UI's response differs completely: re-render a form (invalid_input), disable a
 * control (denied), show the rule's own words in a toast (veto), send the user to log
 * in (unauthenticated).
 *
 * **Disclosure rule.** `veto`, `denied`, `not_found` and `unknown_tool` messages are
 * written for humans by the plugin author, and cross the wire verbatim — surfacing a
 * domain rule's reason IS the feature (Decision D7: another plugin's rule reaches the
 * UI without the UI knowing it exists). Everything else is redacted to "Internal
 * error"; the original goes to the logger only. Never widen that.
 */
import { ZodError } from "zod";
import { AuthorizationError, HookVetoError } from "@embody/kernel";
import { EntityNotFoundError } from "@embody/plugin-sdk";

export type ApiErrorKind =
  /** No principal could be resolved: no session, no dev identity. */
  | "unauthenticated"
  /** Authenticated, but RBAC says no. */
  | "denied"
  /** A domain rule rejected the operation. The message is the rule's own. */
  | "veto"
  /** No such row in this org. RLS makes "hidden" and "missing" identical on purpose. */
  | "not_found"
  /** No tool by that name in this deployment (apps are selectable per deployment). */
  | "unknown_tool"
  /** The input failed the tool's Zod schema. `details` carries the issues. */
  | "invalid_input"
  /** The route exists but is switched off in this configuration. */
  | "unavailable"
  /** A bug. Message redacted. */
  | "internal";

export interface ApiError {
  kind: ApiErrorKind;
  message: string;
  /** The tool being invoked, when the failure happened during a tool call. */
  tool?: string;
  /** Machine-readable extras: Zod issues, or the vetoing hook + plugin. */
  details?: unknown;
}

export interface ApiErrorBody {
  error: ApiError;
}

export interface HttpErrorResult {
  status: number;
  body: ApiErrorBody;
  /** Present only when something must be logged: the un-redacted original. */
  logAs?: unknown;
}

/** An identity could not be resolved. Thrown by the API layer, not the executor. */
export class UnauthenticatedError extends Error {
  constructor(message = "Not signed in") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/** A route that exists but is disabled in this configuration (e.g. dev-only login). */
export class UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnavailableError";
  }
}

/**
 * A postgres.js error (or any driver error) rather than a domain decision. Duck-typed
 * because @embody/host must not depend on the driver just to classify a failure.
 */
function isDriverError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; severity?: unknown };
  return typeof e.code === "string" && typeof e.severity === "string";
}

function internal(err: unknown, tool?: string): HttpErrorResult {
  return {
    status: 500,
    body: { error: { kind: "internal", message: "Internal error", ...(tool ? { tool } : {}) } },
    logAs: err,
  };
}

/** Map a thrown error to an HTTP status + a typed body. Pure; safe to unit test. */
export function toHttpError(err: unknown, tool?: string): HttpErrorResult {
  const withTool = (error: ApiError): ApiErrorBody => ({
    error: tool ? { ...error, tool } : error,
  });

  // A hook threw. The kernel wraps EVERY handler throw, so this arrives for domain
  // vetoes *and* for bugs and for framework errors raised inside a rule. Unwrap first:
  // a rule that called req.assert, or looked up a missing row, is not a veto.
  if (err instanceof HookVetoError) {
    const cause = err.cause;
    if (
      cause instanceof AuthorizationError ||
      cause instanceof EntityNotFoundError ||
      cause instanceof ZodError
    ) {
      return toHttpError(cause, tool);
    }
    if (isDriverError(cause)) return internal(err, tool);
    return {
      // 409: the request was well-formed and permitted, but conflicts with the current
      // state of the world. Retrying it unchanged will fail again — which is exactly
      // what "close this deal before its security review" means.
      status: 409,
      body: withTool({
        kind: "veto",
        // The rule's own sentence, not the kernel's wrapper around it: this string goes
        // straight into a toast, and `Hook "x" vetoed by plugin "y":` is machine detail
        // that `details` already carries.
        message: cause instanceof Error ? cause.message : err.message,
        details: { hook: err.hook, plugin: err.pluginId },
      }),
    };
  }

  if (err instanceof AuthorizationError) {
    return { status: 403, body: withTool({ kind: "denied", message: err.message }) };
  }

  if (err instanceof EntityNotFoundError) {
    return { status: 404, body: withTool({ kind: "not_found", message: err.message }) };
  }

  if (err instanceof ZodError) {
    return {
      status: 400,
      body: withTool({
        kind: "invalid_input",
        message: "Invalid input for this tool",
        details: err.issues,
      }),
    };
  }

  if (err instanceof UnauthenticatedError) {
    return { status: 401, body: withTool({ kind: "unauthenticated", message: err.message }) };
  }

  if (err instanceof UnavailableError) {
    return { status: 501, body: withTool({ kind: "unavailable", message: err.message }) };
  }

  // `Executor.invoke` signals an unknown tool with a plain Error; matching its message
  // is the seam between the two. Kept narrow so an unrelated Error can't slip through.
  if (err instanceof Error && /^Unknown tool "/.test(err.message)) {
    return { status: 404, body: withTool({ kind: "unknown_tool", message: err.message }) };
  }

  return internal(err, tool);
}
