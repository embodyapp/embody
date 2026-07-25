/**
 * The vocabulary shared by the client, the cache and the hooks.
 *
 * Nothing here imports from another @embody package. That is deliberate: @embody/auth
 * and @embody/kernel pull in hono, postgres and the whole server graph, none of which
 * belongs in a browser bundle. The few shapes that must agree with the server (Principal,
 * Permission, the error kinds) are re-declared and pinned by tests.
 */

/**
 * Why a call failed, in the terms a UI acts on.
 *
 * Mirrors `ApiErrorKind` in @embody/host, plus `network` for failures that never
 * reached the server at all.
 */
export type EmbodyErrorKind =
  | "unauthenticated"
  | "denied"
  | "veto"
  | "not_found"
  | "unknown_tool"
  | "invalid_input"
  | "unavailable"
  | "internal"
  /** The request never got an answer: offline, DNS, CORS, connection reset. */
  | "network";

/**
 * A failed tool call.
 *
 * `message` is safe to show a user for `veto`, `denied`, `not_found` and
 * `unknown_tool` — the server sends the rule's own words for exactly that purpose. For
 * `internal` it is already redacted server-side.
 */
export class EmbodyError extends Error {
  readonly kind: EmbodyErrorKind;
  /** HTTP status, or 0 when the request never reached the server. */
  readonly status: number;
  readonly tool: string | undefined;
  /** Zod issues for `invalid_input`; `{hook, plugin}` for `veto`. */
  readonly details: unknown;

  constructor(init: {
    kind: EmbodyErrorKind;
    message: string;
    status?: number;
    tool?: string | undefined;
    details?: unknown;
  }) {
    super(init.message);
    this.name = "EmbodyError";
    this.kind = init.kind;
    this.status = init.status ?? 0;
    this.tool = init.tool;
    this.details = init.details;
  }

  /** True when re-authenticating is the fix. */
  get isAuthProblem(): boolean {
    return this.kind === "unauthenticated";
  }

  /** True when a domain rule refused: show `message`, don't retry unchanged. */
  get isVeto(): boolean {
    return this.kind === "veto";
  }
}

export interface Principal {
  readonly userId: string;
  readonly orgId: string;
  readonly roles: readonly string[];
}

export interface Permission {
  readonly action: string;
  readonly resource: string;
}

/** How the server established this principal. Informational; useful in demos. */
export type IdentitySource = "session" | "header" | "env";

export interface Identity {
  readonly principal: Principal;
  readonly permissions: readonly Permission[];
  readonly source: IdentitySource;
}

/** One tool as published by `GET /api/tools`. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  /** JSON Schema (draft 7) for the tool's input. */
  readonly inputSchema: unknown;
}

/**
 * Typed tool inputs and outputs, opt-in.
 *
 * Empty here, so an un-augmented app compiles with `unknown` and works. An app that
 * wants autocomplete and type-checked inputs augments it:
 *
 * ```ts
 * declare module "@embody/react" {
 *   interface ToolMap {
 *     crm_query_deals: { input: { stage?: string; limit?: number }; output: DealRow[] };
 *   }
 * }
 * ```
 *
 * No codegen step, and nothing to keep in sync beyond the declaration itself.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ToolMap {}

/** Any tool name; augmenting ToolMap adds autocomplete without closing the set. */
export type ToolName = (keyof ToolMap & string) | (string & {});

export type InputOf<N> = N extends keyof ToolMap
  ? ToolMap[N] extends { input: infer I }
    ? I
    : unknown
  : unknown;

export type OutputOf<N> = N extends keyof ToolMap
  ? ToolMap[N] extends { output: infer O }
    ? O
    : unknown
  : unknown;

export type QueryStatus = "idle" | "loading" | "success" | "error";

/**
 * The outcome of a mutation.
 *
 * Mutations resolve with this instead of rejecting: a rejected promise in an onClick is
 * the most common source of unhandled rejections, and a veto is an ordinary outcome of
 * a correct request, not an exception. Matches the `{ ok, error }` shape the demo CRMs
 * already use.
 */
export type Result<T> = { ok: true; data: T } | { ok: false; error: EmbodyError };
