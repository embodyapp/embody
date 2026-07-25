/**
 * The transport: `fetch` over the host's `/api` bridge, with the wire envelopes and
 * error taxonomy turned into typed values. No React here — it is usable from a plain
 * script, a test, or a non-React framework.
 */
import { EmbodyError } from "./types.ts";
import type {
  Identity,
  InputOf,
  OutputOf,
  ToolDescriptor,
  ToolName,
} from "./types.ts";

export interface EmbodyClientOptions {
  /**
   * Where the bridge is mounted. Defaults to "/api" — same-origin, which is what the
   * demo's Vite proxy provides and what makes the session cookie work with no CORS.
   */
  baseUrl?: string;
  /** Injectable for tests and SSR. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Extra headers per request, e.g. `x-embody-*` during local development. Called on
   * every call so a token can be refreshed without rebuilding the client.
   */
  headers?: () => Record<string, string>;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface EmbodyClient {
  readonly baseUrl: string;
  /** Invoke a tool. Rejects with an EmbodyError. */
  call<N extends ToolName>(name: N, input?: InputOf<N>, opts?: CallOptions): Promise<OutputOf<N>>;
  /** The tools this deployment enables, with JSON Schema for each input. */
  tools(opts?: CallOptions): Promise<ToolDescriptor[]>;
  /** The caller's identity, or null when not signed in. */
  me(opts?: CallOptions): Promise<Identity | null>;
  login(body: { orgId: string; userId: string; roles?: string[] }): Promise<Identity>;
  logout(): Promise<void>;
}

interface WireError {
  error?: { kind?: string; message?: string; details?: unknown; tool?: string };
}

const KINDS = new Set([
  "unauthenticated",
  "denied",
  "veto",
  "not_found",
  "unknown_tool",
  "invalid_input",
  "unavailable",
  "internal",
]);

/** Turn a non-2xx response into a typed error, tolerating a non-JSON body. */
async function errorFrom(res: Response, tool?: string): Promise<EmbodyError> {
  let body: WireError = {};
  try {
    body = (await res.json()) as WireError;
  } catch {
    // A proxy or a crash can answer with HTML. Fall through to the status-based guess.
  }
  const wire = body.error;
  const kind =
    wire?.kind && KINDS.has(wire.kind)
      ? (wire.kind as EmbodyError["kind"])
      : res.status === 401
        ? "unauthenticated"
        : res.status === 403
          ? "denied"
          : res.status === 404
            ? "not_found"
            : "internal";
  return new EmbodyError({
    kind,
    message: wire?.message ?? `Request failed with status ${res.status}`,
    status: res.status,
    tool: wire?.tool ?? tool,
    details: wire?.details,
  });
}

export function createEmbodyClient(opts: EmbodyClientOptions = {}): EmbodyClient {
  const baseUrl = (opts.baseUrl ?? "/api").replace(/\/$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const extraHeaders = opts.headers;

  const request = async (
    path: string,
    init: RequestInit,
    tool?: string,
  ): Promise<Response> => {
    try {
      return await doFetch(`${baseUrl}${path}`, {
        // Explicit, though it is the default for same-origin: this is how the session
        // cookie travels, and it should survive someone pointing baseUrl elsewhere.
        credentials: "same-origin",
        ...init,
        headers: { ...(extraHeaders?.() ?? {}), ...(init.headers as Record<string, string>) },
      });
    } catch (err) {
      // An aborted request is a caller's decision, not a failure — let it through
      // unchanged so the cache can tell the two apart.
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new EmbodyError({
        kind: "network",
        message: err instanceof Error ? err.message : "Network request failed",
        status: 0,
        tool,
      });
    }
  };

  const json = { "content-type": "application/json" };

  return {
    baseUrl,

    async call(name, input, callOpts) {
      const res = await request(
        `/tools/${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: json,
          body: JSON.stringify({ input: input ?? {} }),
          ...(callOpts?.signal ? { signal: callOpts.signal } : {}),
        },
        name,
      );
      if (!res.ok) throw await errorFrom(res, name);
      const body = (await res.json()) as { result: unknown };
      return body.result as never;
    },

    async tools(callOpts) {
      const res = await request("/tools", {
        ...(callOpts?.signal ? { signal: callOpts.signal } : {}),
      });
      if (!res.ok) throw await errorFrom(res);
      const body = (await res.json()) as { tools: ToolDescriptor[] };
      return body.tools;
    },

    async me(callOpts) {
      const res = await request("/me", {
        ...(callOpts?.signal ? { signal: callOpts.signal } : {}),
      });
      // Anonymous is an ordinary state, not an error: it is what a login screen is for.
      if (res.status === 401) return null;
      if (!res.ok) throw await errorFrom(res);
      return (await res.json()) as Identity;
    },

    async login(body) {
      const res = await request("/session", {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await errorFrom(res);
      return (await res.json()) as Identity;
    },

    async logout() {
      const res = await request("/session", { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw await errorFrom(res);
    },
  };
}
