import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { GenUiController, GenUiDelivery } from "./controller.js";
import type { GenUiDocument } from "./document.js";
import { resolveGenUiPayload, type GenUiPayloadBinding } from "./payload.js";
import { z } from "zod";
export interface GenUiBrowserOptions {
  readonly mode: "development" | "production";
  readonly host?: string;
  readonly ttlMs?: number;
  readonly maxSessions?: number;
}
export interface GenUiBrowserSession {
  readonly appId: string;
  readonly viewId: string;
  readonly generation: string;
  readonly controller: GenUiController;
  readonly bindings:
    | Readonly<Record<string, GenUiPayloadBinding>>
    | ((document: GenUiDocument) => Readonly<Record<string, GenUiPayloadBinding>>);
  /** Host-owned minimal context delivery; neither domain props nor draft values. */
  readonly publishOutcome: (outcome: Omit<GenUiDelivery, "document">) => Promise<void>;
}
export interface GenUiBrowserHost {
  open(session: GenUiBrowserSession): { readonly url: string; revoke(): void };
  close(): Promise<void>;
}
const token = () => randomBytes(32).toString("base64url");
const actionSchema = z.strictObject({ nodeId: z.string().max(63), payload: z.unknown() });
const page =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Embody temporary view</title></head><body><main aria-label="Embody presentation"></main><p role="status" id="connection">Connecting…</p><script src="/renderer.js"></script><script src="/bootstrap.js"></script></body></html>';
const bootstrap =
  'EmbodyGenUi.startGenUiBrowser(document.querySelector("main"),document.querySelector("#connection"));';
/** Loopback development only. Credentials remain in host-owned dispatch; leases cannot select app/view/target. */
export async function createGenUiBrowserHost(
  options: GenUiBrowserOptions,
): Promise<GenUiBrowserHost> {
  const host = options.host ?? "127.0.0.1";
  const ttl = options.ttlMs ?? 60_000;
  const maximum = options.maxSessions ?? 100;
  if (
    options.mode !== "development" ||
    process.env["NODE_ENV"] === "production" ||
    !["127.0.0.1", "::1"].includes(host) ||
    !Number.isInteger(ttl) ||
    ttl < 1000 ||
    ttl > 300_000 ||
    !Number.isInteger(maximum) ||
    maximum < 1 ||
    maximum > 100
  )
    throw new Error("Browser presentation configuration is unavailable");
  const asset = readFileSync(new URL(import.meta.resolve("@embody/genui/renderer-global.js")));
  type Lease = {
    session: GenUiBrowserSession;
    expires: number;
    controller: AbortController;
    activeToken?: string;
    requests: number;
  };
  function payloadBindings(session: GenUiBrowserSession) {
    const bindings = structuredClone(
      typeof session.bindings === "function"
        ? session.bindings(session.controller.document)
        : session.bindings,
    );
    if (JSON.stringify(bindings).length > 65_536 || Object.keys(bindings).length > 100)
      throw new Error("Browser bindings are invalid");
    for (const binding of Object.values(bindings)) resolveGenUiPayload(binding, {});
    return bindings;
  }
  const starts = new Map<string, Lease>();
  const active = new Map<string, Lease>();
  const leases = new Set<Lease>();
  let closed = false;
  let origin = "";
  function revoke(lease: Lease) {
    lease.controller.abort();
    lease.session.controller.dispose();
    leases.delete(lease);
    for (const [key, value] of starts) if (value === lease) starts.delete(key);
    for (const [key, value] of active) if (value === lease) active.delete(key);
  }
  function sweep() {
    for (const lease of leases) if (lease.expires <= Date.now()) revoke(lease);
  }
  const interval = setInterval(sweep, 1000);
  interval.unref();
  function headers(res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
    );
  }
  function send(res: ServerResponse, status: number, value: unknown) {
    if (res.destroyed) return;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  }
  async function body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const raw of req) {
      const chunk: unknown = raw;
      if (!(chunk instanceof Uint8Array)) throw new Error();
      bytes += chunk.byteLength;
      if (bytes > 65_536) throw new Error();
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }
  const server = createServer((req, res) => {
    headers(res);
    const unavailable = () => send(res, 404, { error: "Presentation unavailable" });
    const work = async () => {
      sweep();
      if (
        closed ||
        req.headers.host !== new URL(origin).host ||
        !req.url ||
        req.url.includes("?") ||
        req.url.includes("#")
      )
        return unavailable();
      if (req.method === "GET" && ["/", "/renderer.js", "/bootstrap.js"].includes(req.url)) {
        // Static bytes never depend on a lease, tenant, credential or action result.
        res.setHeader(
          "Content-Type",
          req.url === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
        );
        res.end(req.url === "/" ? page : req.url === "/renderer.js" ? asset : bootstrap);
        return;
      }
      if (
        req.method !== "POST" ||
        req.headers.origin !== origin ||
        !["/session", "/action", "/refresh", "/close"].includes(req.url)
      )
        return unavailable();
      const bearer = req.headers.authorization;
      if (typeof bearer !== "string" || !/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer))
        return unavailable();
      const key = bearer.slice(7);
      if (req.url === "/session") {
        const lease = starts.get(key);
        if (!lease) return unavailable();
        starts.delete(key);
        lease.activeToken = token();
        active.set(lease.activeToken, lease);
        send(res, 200, {
          token: lease.activeToken,
          document: lease.session.controller.document,
          callableTargets: lease.session.controller.callableTargets,
          bindings: payloadBindings(lease.session),
        });
        return;
      }
      const lease = active.get(key);
      if (!lease || ++lease.requests > 100) return unavailable();
      if (req.url === "/close") {
        revoke(lease);
        send(res, 200, {});
        return;
      }
      const disconnect = new AbortController();
      res.once("close", () => {
        if (!res.writableEnded) disconnect.abort();
      });
      const signal = AbortSignal.any([
        lease.controller.signal,
        disconnect.signal,
        AbortSignal.timeout(Math.min(10_000, Math.max(1, lease.expires - Date.now()))),
      ]);
      if (req.url === "/refresh") {
        const document = await lease.session.controller.refresh(signal);
        if (signal.aborted) return unavailable();
        send(res, 200, { document, bindings: payloadBindings(lease.session) });
        return;
      }
      const parsed = actionSchema.safeParse(await body(req));
      if (!parsed.success || signal.aborted) return unavailable();
      const result = await lease.session.controller.submit(
        parsed.data.nodeId,
        parsed.data.payload,
        signal,
      );
      if (!signal.aborted) {
        const outcome = {
          target: result.target,
          status: result.status,
          reconciled: result.reconciled,
          ...(result.code === undefined ? {} : { code: result.code }),
        };
        // Publication failure preserves commit status, but the browser must display required reconciliation.
        let recorded = false;
        try {
          if (!lease.session.controller.readTargets.includes(result.target))
            await lease.session.publishOutcome(Object.freeze(outcome));
          recorded = true;
        } catch {
          /* no raw cause */
        }
        if (!signal.aborted) {
          let presentation: {
            document?: GenUiDocument;
            bindings?: Readonly<Record<string, GenUiPayloadBinding>>;
          } = {};
          if (result.document) {
            try {
              presentation = {
                document: result.document,
                bindings: payloadBindings(lease.session),
              };
            } catch {
              /* presentation cannot undo a commit */
            }
          }
          send(res, 200, { ...outcome, ...presentation, recorded });
        }
      }
    };
    void work().catch(unavailable);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  try {
    server.listen(0, host);
    await once(server, "listening");
  } catch (cause) {
    clearInterval(interval);
    server.close();
    throw cause;
  }
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Browser presentation unavailable");
  origin = `http://${host === "::1" ? "[::1]" : host}:${address.port}`;
  return {
    open(session) {
      sweep();
      if (
        closed ||
        leases.size >= maximum ||
        !/^[a-z][a-z0-9-]{0,62}$/.test(session.appId) ||
        !/^[a-z][a-z0-9-]{0,62}$/.test(session.viewId) ||
        !session.generation ||
        session.generation.length > 256
      )
        throw new Error("Browser presentation unavailable");
      const bindings =
        typeof session.bindings === "function" ? session.bindings : payloadBindings(session);
      payloadBindings(session);
      const lease: Lease = {
        session: { ...session, bindings },
        expires: Date.now() + ttl,
        controller: new AbortController(),
        requests: 0,
      };
      const start = token();
      leases.add(lease);
      starts.set(start, lease);
      return Object.freeze({ url: origin + "/#" + start, revoke: () => revoke(lease) });
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      for (const lease of leases) revoke(lease);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
