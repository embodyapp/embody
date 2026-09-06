import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
  UnavailableError,
  stableStringify,
  toErrorEnvelope,
  type AppManifest,
  type Principal,
} from "@embody/core";
import { DirectEventTransport, type EventDestination, type EventDirectory } from "@embody/host";
import {
  createMcpCatalog,
  McpHttpHandler,
  type McpCatalogEntry,
  type McpExecutionEvent,
} from "@embody/mcp";

export interface Clock {
  now(): Date;
}
export interface Registration {
  readonly protocolVersion: 1;
  readonly appId: string;
  readonly version: string;
  readonly endpoint: string;
  readonly healthCheckUrl: string;
  readonly manifest: AppManifest;
  readonly manifestHash?: string;
}
export interface RegisteredApp extends Registration {
  readonly generation: string;
  readonly lastSeen?: string;
  readonly status: "unknown" | "healthy" | "unhealthy";
}
export interface GatewayRegistryOptions {
  readonly clock?: Clock;
  readonly ttlMs?: number;
  /** Explicitly opt in for local/private deployment targets. */
  readonly allowPrivateEndpoints?: boolean;
  readonly allowedOrigins?: readonly string[];
  readonly credentials: Readonly<Record<string, string>>;
  readonly initial?: readonly RegisteredApp[];
}

function immutable<T>(value: T): T {
  return Object.freeze(value);
}
function appId(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,62}$/.test(value);
}
function blockedHost(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower === "metadata.google.internal" ||
    /^127\./.test(lower) ||
    lower === "::1" ||
    /^169\.254\./.test(lower) ||
    /^10\./.test(lower) ||
    /^192\.168\./.test(lower) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(lower)
  );
}
function validEndpoint(value: string, options: GatewayRegistryOptions, allowPath = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestError("Endpoint URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new BadRequestError("Endpoint must be HTTP(S)");
  if (
    url.username ||
    url.password ||
    (!allowPath && url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new BadRequestError("Endpoint URL must be an origin");
  if (!options.allowPrivateEndpoints && blockedHost(url.hostname))
    throw new ForbiddenError("Endpoint host is not allowed");
  if (options.allowedOrigins?.length && !options.allowedOrigins.includes(url.origin))
    throw new ForbiddenError("Endpoint origin is not allowed");
  return url;
}
function validateRegistration(value: Registration, options: GatewayRegistryOptions): string {
  if (
    value.protocolVersion !== 1 ||
    !appId(value.appId) ||
    !/^\d+\.\d+\.\d+([+-][\w.-]+)?$/.test(value.version)
  )
    throw new BadRequestError("Registration protocol, app ID, or version is invalid");
  const serialized = stableStringify(value.manifest);
  if (Buffer.byteLength(serialized) > 256 * 1024)
    throw new BadRequestError("Manifest exceeds 256 KiB");
  if (value.manifest.protocolVersion !== 1)
    throw new BadRequestError("Manifest protocol is unsupported");
  validEndpoint(value.endpoint, options);
  const health = validEndpoint(value.healthCheckUrl, options, true);
  if (health.origin !== new URL(value.endpoint).origin)
    throw new BadRequestError("Health URL must share endpoint origin");
  const names = [...Object.keys(value.manifest.actions), ...Object.keys(value.manifest.entities)];
  if (new Set(names).size !== names.length) throw new ConflictError("Manifest target collision");
  // Registration is the earliest safe point to reject lossy MCP name mappings.
  try {
    createMcpCatalog([{ appId: value.appId, manifest: value.manifest }], value.appId);
  } catch {
    throw new ConflictError("Manifest MCP tool name collision");
  }
  return createHash("sha256").update(serialized).digest("hex");
}
/** Atomic copy-on-write registry; snapshots can safely be read concurrently. */
export class GatewayRegistry implements EventDirectory {
  private readonly values: Required<Pick<GatewayRegistryOptions, "ttlMs">> & GatewayRegistryOptions;
  private apps: ReadonlyMap<string, RegisteredApp>;
  public constructor(options: GatewayRegistryOptions) {
    this.values = { ...options, ttlMs: options.ttlMs ?? 90_000 };
    this.apps = new Map(
      (options.initial ?? []).map((app) => [app.appId, immutable({ ...app, status: "unknown" })]),
    );
  }
  public register(value: Registration, secret: string): RegisteredApp {
    const expected = this.values.credentials[value.appId];
    if (!expected || !safeEqual(secret, expected))
      throw new UnauthenticatedError("App registration credentials are invalid");
    const generation = validateRegistration(value, this.values);
    const prior = this.apps.get(value.appId);
    if (prior && prior.generation !== generation && prior.endpoint !== value.endpoint)
      throw new ConflictError("Endpoint changes require an ownership policy approval");
    const registered = immutable({
      ...value,
      generation,
      status: "healthy" as const,
      lastSeen: this.now(),
    });
    this.apps = new Map(this.apps).set(value.appId, registered);
    return registered;
  }
  public heartbeat(app: string, generation: string, secret: string): RegisteredApp {
    const entry = this.apps.get(app);
    if (!entry || !safeEqual(secret, this.values.credentials[app] ?? ""))
      throw new NotFoundError("App is not registered");
    if (entry.generation !== generation)
      throw new ConflictError("Registration generation is stale");
    const updated = immutable({ ...entry, status: "healthy" as const, lastSeen: this.now() });
    this.apps = new Map(this.apps).set(app, updated);
    return updated;
  }
  public expire(): void {
    const cutoff =
      (this.values.clock ?? { now: () => new Date() }).now().getTime() - this.values.ttlMs;
    const next = new Map(this.apps);
    for (const [id, value] of next)
      if (!value.lastSeen || Date.parse(value.lastSeen) <= cutoff)
        next.set(id, immutable({ ...value, status: "unhealthy" }));
    this.apps = next;
  }
  public snapshot(): readonly RegisteredApp[] {
    this.expire();
    return immutable([...this.apps.values()]);
  }
  public get(app: string): RegisteredApp | undefined {
    this.expire();
    return this.apps.get(app);
  }
  public destinations(event: { name: string }): Promise<readonly EventDestination[]> {
    return Promise.resolve(
      this.snapshot()
        .filter((item) => item.manifest.eventSubscriptions.includes(event.name))
        .map((item) => ({ appId: item.appId, endpoint: item.endpoint })),
    );
  }
  private now(): string {
    return (this.values.clock ?? { now: () => new Date() }).now().toISOString();
  }
}

export interface GatewayAuthProvider {
  readonly id: string;
  authenticate(token: string): Promise<Principal | null>;
}
export interface ApiKeyRecord {
  readonly id: string;
  readonly hash: string;
  readonly principal: Principal;
  readonly expiresAt?: string;
  readonly revoked?: boolean;
}
/** SHA-256 is a lookup hash only; production stores should use a slow KDF before constructing records. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
export function apiKeyProvider(
  records: readonly ApiKeyRecord[],
  clock: Clock = { now: () => new Date() },
): GatewayAuthProvider {
  return {
    id: "api-key",
    authenticate(token) {
      const hash = hashApiKey(token);
      const record = records.find((item) => safeEqual(item.hash, hash));
      return Promise.resolve(
        !record ||
          record.revoked ||
          (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= clock.now().getTime())
          ? null
          : record.principal,
      );
    },
  };
}
export interface OidcProviderOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl?: string;
  readonly algorithms?: readonly string[];
  readonly mapClaims?: (claims: JWTPayload) => Principal | null;
}
export function oidcProvider(options: OidcProviderOptions): GatewayAuthProvider {
  const keys = createRemoteJWKSet(
    new URL(options.jwksUrl ?? `${options.issuer.replace(/\/$/, "")}/.well-known/jwks.json`),
  );
  return {
    id: "oidc",
    async authenticate(token) {
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: options.algorithms ? [...options.algorithms] : ["RS256", "ES256"],
        });
        return options.mapClaims?.(payload) ?? principalClaims(payload);
      } catch {
        return null;
      }
    },
  };
}
function principalClaims(claims: JWTPayload): Principal | null {
  const { orgId, actorId, actorType, roles, scopes } = claims;
  return typeof orgId === "string" &&
    typeof actorId === "string" &&
    (actorType === "agent" || actorType === "human" || actorType === "system") &&
    Array.isArray(roles) &&
    roles.every((x) => typeof x === "string") &&
    Array.isArray(scopes) &&
    scopes.every((x) => typeof x === "string")
    ? { orgId, actorId, actorType, roles, scopes }
    : null;
}
export class AuthChain {
  public constructor(private readonly providers: readonly GatewayAuthProvider[]) {}
  public async authenticate(token: string): Promise<Principal> {
    for (const provider of this.providers) {
      const principal = await provider.authenticate(token);
      if (principal) return principal;
    }
    throw new UnauthenticatedError();
  }
}
export function scopeAllows(principal: Principal, app: string, target: string): boolean {
  const required = `${app}:${target}`;
  return principal.scopes.some(
    (scope) =>
      scope === "*" ||
      scope === `${app}:*` ||
      scope === required ||
      (scope.endsWith("*") && required.startsWith(scope.slice(0, -1))),
  );
}
export interface GatewayTokenOptions {
  readonly issuer: string;
  readonly key: Uint8Array;
  readonly kid?: string;
  readonly clock?: Clock;
}
export async function issueGatewayToken(
  principal: Principal,
  app: string,
  requestId: string,
  options: GatewayTokenOptions,
): Promise<string> {
  const now = Math.floor((options.clock ?? { now: () => new Date() }).now().getTime() / 1000);
  return new SignJWT({ ...principal, requestId })
    .setProtectedHeader({ alg: "HS256", ...(options.kid ? { kid: options.kid } : {}) })
    .setIssuer(options.issuer)
    .setAudience(app)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(options.key);
}
export interface AuditRecord {
  readonly requestId: string;
  readonly appId?: string;
  readonly target?: string;
  readonly actorId?: string;
  readonly outcome: string;
  readonly durationMs: number;
}
export class MemoryAuditLog {
  public readonly records: AuditRecord[] = [];
  append(record: AuditRecord): void {
    this.records.push(immutable(record));
  }
}
export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, { count: number; reset: number }>();
  public constructor(
    private readonly limit = 60,
    private readonly windowMs = 60_000,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}
  public check(key: string): number | undefined {
    const now = this.clock.now().getTime();
    const entry = this.entries.get(key);
    if (!entry || entry.reset <= now) {
      this.entries.set(key, { count: 1, reset: now + this.windowMs });
      return undefined;
    }
    if (++entry.count > this.limit) return Math.ceil((entry.reset - now) / 1000);
    return undefined;
  }
}

export interface GatewayOptions {
  readonly registry: GatewayRegistry;
  readonly auth: AuthChain;
  readonly token: GatewayTokenOptions;
  readonly fetch?: typeof fetch;
  readonly audit?: MemoryAuditLog;
  readonly limiter?: FixedWindowRateLimiter;
  readonly environment?: "development" | "production";
}
function bearer(value: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
  if (!match?.[1]) throw new UnauthenticatedError();
  return match[1];
}
/** Fastify gateway control-plane server. */
export function createGateway(options: GatewayOptions): FastifyInstance {
  const app = Fastify({ bodyLimit: 1_048_576 });
  const audit = options.audit ?? new MemoryAuditLog();
  const fetcher = options.fetch ?? fetch;
  app.setErrorHandler((error, request, reply) => {
    const requestId = String(reply.getHeader("x-request-id") ?? request.id);
    const result = toErrorEnvelope(error, requestId, options.environment ?? "production");
    void reply.status(result.status).send(result.body);
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("x-request-id", randomUUID());
  });
  const registration = (request: { headers: Record<string, string | string[] | undefined> }) =>
    bearer(
      typeof request.headers["authorization"] === "string"
        ? request.headers["authorization"]
        : undefined,
    );
  const register = (request: {
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
  }) => options.registry.register(request.body as Registration, registration(request));
  const heartbeat = (request: {
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
  }) => {
    const body = request.body as { appId: string; generation: string };
    return options.registry.heartbeat(body.appId, body.generation, registration(request));
  };
  for (const prefix of ["", "/api/registry"]) {
    app.post(`${prefix}/register`, register);
    app.post(`${prefix}/heartbeat`, heartbeat);
  }
  app.get("/api/catalog", async (request, reply) => {
    const principal = await options.auth.authenticate(
      bearer(
        typeof request.headers["authorization"] === "string"
          ? request.headers["authorization"]
          : undefined,
      ),
    );
    const catalog = options.registry
      .snapshot()
      .filter((entry) => entry.status === "healthy")
      .map((entry) => ({
        ...entry,
        manifest: {
          ...entry.manifest,
          actions: Object.fromEntries(
            Object.entries(entry.manifest.actions).filter(([target]) =>
              scopeAllows(principal, entry.appId, target),
            ),
          ),
        },
      }))
      .filter((entry) => Object.keys(entry.manifest.actions).length > 0);
    const etag = `"${createHash("sha256").update(stableStringify(catalog)).digest("hex")}"`;
    reply.header("etag", etag).header("cache-control", "private, max-age=30");
    if (request.headers["if-none-match"] === etag) return reply.status(304).send();
    return catalog;
  });
  const catalogFor = (principal: Principal, scoped?: string): readonly McpCatalogEntry[] =>
    createMcpCatalog(
      options.registry
        .snapshot()
        .filter((entry) => entry.status === "healthy")
        .filter((entry) => scoped === undefined || entry.appId === scoped)
        .map((entry) => ({ appId: entry.appId, manifest: entry.manifest })),
      scoped,
    ).filter((entry) => scopeAllows(principal, entry.appId, entry.target));
  const remoteEvents = async function* (
    principal: Principal,
    entry: McpCatalogEntry,
    input: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<McpExecutionEvent> {
    const registered = options.registry.get(entry.appId);
    if (!registered || registered.status !== "healthy") {
      yield { type: "error", message: "App is unavailable" };
      return;
    }
    if (!scopeAllows(principal, entry.appId, entry.target)) {
      yield { type: "error", message: "Tool not found or no longer authorized" };
      return;
    }
    const requestId = randomUUID();
    const response = await fetcher(new URL("/execute/stream", new URL(registered.endpoint)), {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-gateway-auth": `Bearer ${await issueGatewayToken(principal, entry.appId, requestId, options.token)}`,
      },
      body: JSON.stringify({ protocolVersion: 1, target: entry.target, input }),
    });
    if (!response.ok || !response.body) {
      yield { type: "error", message: "Tool execution failed" };
      return;
    }
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let pending = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) throw new UnavailableError("Invalid remote stream");
      pending += decoder.decode(bytes, { stream: true });
      if (pending.length > 64 * 1024)
        throw new UnavailableError("Remote progress frame is too large");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!event || !data) continue;
        const value: unknown = JSON.parse(data);
        if (event === "progress") {
          const update = value as { percent?: number; message?: unknown };
          if (typeof update.message === "string")
            yield {
              type: "progress",
              update: {
                message: update.message,
                ...(typeof update.percent === "number" ? { percent: update.percent } : {}),
              },
            };
        } else if (event === "result") yield { type: "result", value };
        else if (event === "error") yield { type: "error", message: "Tool execution failed" };
      }
    }
  };
  const mcp = new McpHttpHandler<Principal>({ catalog: catalogFor, execute: remoteEvents });
  const mcpRoute = async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await options.auth.authenticate(
      bearer(
        typeof request.headers["authorization"] === "string"
          ? request.headers["authorization"]
          : undefined,
      ),
    );
    const scoped = (request.params as { appId?: string }).appId;
    reply.hijack();
    await mcp.handle({
      request: request.raw,
      response: reply.raw,
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(scoped === undefined ? {} : { scopedAppId: scoped }),
      identity: `${principal.orgId}:${principal.actorId}`,
      context: principal,
    });
  };
  for (const url of ["/mcp", "/mcp/:appId"])
    app.route({ method: ["GET", "POST", "DELETE"], url, handler: mcpRoute });
  app.addHook("onClose", async () => mcp.close());
  app.post("/api/execute/stream/:appId/:target", async (request, reply) => {
    const principal = await options.auth.authenticate(
      bearer(
        typeof request.headers["authorization"] === "string"
          ? request.headers["authorization"]
          : undefined,
      ),
    );
    const { appId, target } = request.params as { appId: string; target: string };
    const registered = options.registry.get(appId);
    if (!registered || registered.status !== "healthy")
      throw new UnavailableError("App is unavailable");
    if (!(target in registered.manifest.actions))
      throw new NotFoundError("Target is not advertised");
    if (!scopeAllows(principal, appId, target)) throw new ForbiddenError();
    const requestId = String(reply.getHeader("x-request-id"));
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    const response = await fetcher(new URL("/execute/stream", new URL(registered.endpoint)), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-gateway-auth": `Bearer ${await issueGatewayToken(principal, appId, requestId, options.token)}`,
      },
      body: JSON.stringify({ protocolVersion: 1, target, input: request.body }),
    });
    if (!response.ok || !response.body) {
      reply.status(response.status);
      return await response.json();
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-request-id": requestId,
    });
    try {
      for await (const chunk of response.body) {
        if (!reply.raw.write(chunk))
          await new Promise<void>((resolve) => {
            reply.raw.once("drain", resolve);
            reply.raw.once("close", resolve);
          });
      }
    } finally {
      controller.abort();
      reply.raw.end();
    }
  });
  app.post("/api/execute/:appId/:target", async (request, reply) => {
    const started = Date.now();
    const requestId = String(reply.getHeader("x-request-id"));
    let principal: Principal | undefined;
    let outcome = "failure";
    try {
      principal = await options.auth.authenticate(
        bearer(
          typeof request.headers["authorization"] === "string"
            ? request.headers["authorization"]
            : undefined,
        ),
      );
      const appId = (request.params as { appId: string }).appId;
      const target = (request.params as { target: string }).target;
      const registered = options.registry.get(appId);
      if (!registered || registered.status !== "healthy")
        throw new UnavailableError("App is unavailable");
      if (!(target in registered.manifest.actions))
        throw new NotFoundError("Target is not advertised");
      if (!scopeAllows(principal, appId, target)) throw new ForbiddenError();
      const retry = options.limiter?.check(
        `${principal.orgId}:${principal.actorId}:${appId}:${target}`,
      );
      if (retry !== undefined) {
        reply.header("retry-after", String(retry));
        throw new RateLimitedError();
      }
      const endpoint = new URL(registered.endpoint);
      const controller = new AbortController();
      request.raw.once("aborted", () => controller.abort());
      const response = await fetcher(new URL("/execute", endpoint), {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          "x-gateway-auth": `Bearer ${await issueGatewayToken(principal, appId, requestId, options.token)}`,
        },
        body: JSON.stringify({ protocolVersion: 1, target, input: request.body }),
      });
      const body = await response.json();
      reply.status(response.status);
      outcome = response.ok ? "success" : "downstream-failure";
      return body;
    } finally {
      audit.append({
        requestId,
        ...(principal ? { actorId: principal.actorId } : {}),
        appId: (request.params as { appId: string }).appId,
        target: (request.params as { target: string }).target,
        outcome,
        durationMs: Date.now() - started,
      });
    }
  });
  return app;
}
/** Gateway directory can be injected into DirectEventTransport without domain-plugin changes. */
export function gatewayEventTransport(
  registry: GatewayRegistry,
  secret: string,
): DirectEventTransport {
  return new DirectEventTransport({ directory: registry, secret });
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Deployment helper for DNS-rebinding-aware dispatch policies. */
export async function assertPublicDns(url: URL): Promise<void> {
  for (const row of await lookup(url.hostname, { all: true }))
    if (blockedHost(row.address))
      throw new ForbiddenError("Resolved endpoint address is not allowed");
}
