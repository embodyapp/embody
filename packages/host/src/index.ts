import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  BadRequestError,
  RateLimitedError,
  UnauthenticatedError,
  UnavailableError,
  executionRequestSchema,
  stableStringify,
  toErrorEnvelope,
} from "@embody/core";
import type { EventEnvelope, Kernel } from "@embody/core";
import type { AppAuthVerifier } from "@embody/auth";
import type { StorageConnection } from "@embody/storage";
import { parseDeliveryRequest, signDelivery } from "./events.js";

export {
  DeliveryWorker,
  DirectEventTransport,
  OutboxWorker,
  StaticEventDirectory,
  parseDeliveredEvent,
  parseDeliveryRequest,
  signDelivery,
  signEvent,
  type Clock,
  type DeliveryWorkerOptions,
  type DirectEventTransportOptions,
  type EventDestination,
  type EventDirectory,
  type EventTransport,
  type OutboxWorkerOptions,
} from "./events.js";

export interface HostOptions {
  readonly kernel: Kernel;
  readonly verifier: AppAuthVerifier;
  readonly appId: string;
  readonly version: string;
  readonly environment?: "development" | "production";
  readonly bodyLimit?: number;
  readonly requestTimeoutMs?: number;
  readonly concurrency?: number;
  readonly sseBufferBytes?: number;
  readonly sseKeepaliveMs?: number;
  /** Enables authenticated direct event reception. The shared secret is per producer deployment. */
  readonly eventDelivery?: {
    readonly storage: StorageConnection;
    readonly secret: string;
    readonly authorize?: (event: EventEnvelope) => boolean | Promise<boolean>;
  };
}
export interface EmbodyHost {
  readonly app: FastifyInstance;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RegistrationClientOptions {
  readonly gatewayUrl: string;
  readonly appId: string;
  readonly version: string;
  readonly endpoint: string;
  readonly healthCheckUrl: string;
  readonly manifest: Kernel["manifest"];
  readonly secret: string;
  readonly fetch?: typeof fetch;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  /** Injected for deterministic bounded-jitter retry tests. */
  readonly random?: () => number;
}
/** Gateway registration with an injectable scheduler for deterministic host tests. */
export function createRegistrationClient(options: RegistrationClientOptions) {
  const fetcher = options.fetch ?? fetch;
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  const defer = options.setTimeout ?? setTimeout;
  const cancelDeferred = options.clearTimeout ?? clearTimeout;
  const random = options.random ?? Math.random;
  let timer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let attempts = 0;
  const manifestHash = createHash("sha256").update(stableStringify(options.manifest)).digest("hex");
  const send = async (path: string, body: unknown): Promise<Response> =>
    fetcher(new URL(path, options.gatewayUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${options.secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const register = async (): Promise<void> => {
    const response = await send("/register", {
      protocolVersion: 1,
      appId: options.appId,
      version: options.version,
      endpoint: options.endpoint,
      healthCheckUrl: options.healthCheckUrl,
      manifest: options.manifest,
      manifestHash,
    });
    if (!response.ok) throw new Error(`Gateway registration failed (${response.status})`);
    attempts = 0;
  };
  const scheduleRetry = (): void => {
    if (stopped || retryTimer !== undefined) return;
    const base = Math.min(30_000, 250 * 2 ** Math.min(attempts++, 7));
    const delay = Math.round(base * (0.5 + random()));
    retryTimer = defer(() => {
      retryTimer = undefined;
      void register().catch(scheduleRetry);
    }, delay);
  };
  const heartbeat = (): void => {
    void send("/heartbeat", { protocolVersion: 1, appId: options.appId, generation: manifestHash })
      .then((response) => {
        if (response.status === 404) return register();
        if (!response.ok) throw new Error("Gateway heartbeat failed");
        return undefined;
      })
      .catch(scheduleRetry);
  };
  return {
    manifestHash,
    register,
    start: async (): Promise<void> => {
      stopped = false;
      try {
        await register();
      } catch {
        scheduleRetry();
      }
      timer = schedule(heartbeat, 30_000);
    },
    stop: (): void => {
      stopped = true;
      if (timer !== undefined) cancel(timer);
      if (retryTimer !== undefined) cancelDeferred(retryTimer);
      timer = undefined;
      retryTimer = undefined;
    },
  };
}

function bearer(value: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(value ?? "");
  if (!match?.[1]) throw new UnauthenticatedError("Gateway authentication is required");
  return match[1];
}

/** Creates the remote application HTTP surface. It accepts only gateway-authenticated requests. */
export function createHost(options: HostOptions): EmbodyHost {
  const environment = options.environment ?? "production";
  if (environment === "production" && options.verifier.localDevelopmentOnly)
    throw new Error("Local development verifier cannot run in production");
  const app = Fastify({
    bodyLimit: options.bodyLimit ?? 1_048_576,
    requestTimeout: options.requestTimeoutMs ?? 30_000,
  });
  let accepting = false;
  let active = 0;
  const maximum = options.concurrency ?? 100;
  app.addHook("onRequest", async (request, reply) => {
    const requestId =
      typeof request.headers["x-request-id"] === "string"
        ? request.headers["x-request-id"]
        : randomUUID();
    reply.header("x-request-id", requestId);
  });
  app.setErrorHandler((error, request, reply) => {
    const requestId = String(reply.getHeader("x-request-id") ?? request.id);
    const response = toErrorEnvelope(error, requestId, environment);
    void reply.status(response.status).send(response.body);
  });
  app.get("/health", () => ({
    appId: options.appId,
    version: options.version,
    live: true,
    ready: accepting && options.kernel.state === "ready",
  }));
  const authenticateExecution = async (request: {
    headers: Record<string, string | string[] | undefined>;
  }) => {
    const gatewayAuth = request.headers["x-gateway-auth"];
    return options.verifier.verify(
      bearer(typeof gatewayAuth === "string" ? gatewayAuth : undefined),
    );
  };
  app.post("/execute", async (request, reply) => {
    if (!accepting || options.kernel.state !== "ready") throw new UnavailableError();
    if (active >= maximum) {
      reply.header("retry-after", "1");
      throw new RateLimitedError();
    }
    const parsed = executionRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError();
    const principal = await authenticateExecution(request);
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    active++;
    try {
      return await options.kernel.execute(parsed.data.target, parsed.data.input, {
        principal,
        requestId: String(reply.getHeader("x-request-id")),
        ...(typeof request.headers["traceparent"] === "string"
          ? { traceparent: request.headers["traceparent"] }
          : {}),
        signal: controller.signal,
      });
    } finally {
      active--;
    }
  });
  const eventDelivery = options.eventDelivery;
  if (eventDelivery !== undefined)
    app.post("/events/deliver", async (request) => {
      const delivery = parseDeliveryRequest(request.body);
      if (delivery.destinationAppId !== options.appId)
        throw new UnauthenticatedError("Event destination is invalid");
      const provided = request.headers["x-embody-event-signature"];
      const expected = signDelivery(delivery, eventDelivery.secret);
      if (
        typeof provided !== "string" ||
        provided.length !== expected.length ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
      )
        throw new UnauthenticatedError("Event signature is invalid");
      if ((await eventDelivery.authorize?.(delivery.event)) === false)
        throw new UnauthenticatedError("Event producer or organization is not trusted");
      await eventDelivery.storage.transaction(delivery.event.orgId, (tx) =>
        options.kernel.handleEvent(delivery.event, tx),
      );
      return { accepted: true };
    });
  app.post("/execute/stream", async (request, reply) => {
    if (!accepting || options.kernel.state !== "ready") throw new UnavailableError();
    const parsed = executionRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new BadRequestError();
    const principal = await authenticateExecution(request);
    const controller = new AbortController();
    request.raw.once("aborted", () => controller.abort());
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-request-id": String(reply.getHeader("x-request-id")),
    });
    let percent = -Infinity;
    let terminal = false;
    let buffered = 0;
    let pumping: Promise<void> | undefined;
    const queue: string[] = [];
    const pump = async (): Promise<void> => {
      while (queue.length > 0 && !reply.raw.destroyed) {
        const message = queue.shift()!;
        buffered -= Buffer.byteLength(message);
        if (!reply.raw.write(message))
          await new Promise<void>((resolve) => {
            reply.raw.once("drain", resolve);
            reply.raw.once("close", resolve);
          });
      }
      if (reply.raw.destroyed) queue.length = 0;
    };
    const startPump = (): void => {
      if (pumping !== undefined) return;
      pumping = pump().finally(() => {
        pumping = undefined;
        if (queue.length > 0) startPump();
      });
    };
    const enqueue = (message: string): void => {
      if (terminal || reply.raw.destroyed) return;
      buffered += Buffer.byteLength(message);
      if (buffered > (options.sseBufferBytes ?? 64 * 1024)) {
        controller.abort();
        throw new UnavailableError("Progress stream exceeded its buffer");
      }
      queue.push(message);
      startPump();
    };
    const flush = async (): Promise<void> => {
      while (pumping !== undefined || queue.length > 0) {
        startPump();
        await pumping;
      }
    };
    const write = (event: string, data: unknown): void =>
      enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    reply.raw.once("close", () => {
      if (!terminal) controller.abort();
    });
    const keepalive = setInterval(
      () => enqueue(": keepalive\n\n"),
      options.sseKeepaliveMs ?? 15_000,
    );
    try {
      const result = await options.kernel.execute(parsed.data.target, parsed.data.input, {
        principal,
        requestId: String(reply.getHeader("x-request-id")),
        signal: controller.signal,
        progress: (update) => {
          if (update.percent !== undefined && update.percent < percent)
            throw new BadRequestError("Progress percent must not decrease");
          if (update.percent !== undefined) percent = update.percent;
          write("progress", update);
        },
      });
      write("result", result);
    } catch (error) {
      const response = toErrorEnvelope(error, String(reply.getHeader("x-request-id")), environment);
      write("error", response.body);
    } finally {
      clearInterval(keepalive);
      await flush();
      terminal = true;
      reply.raw.end();
    }
  });
  return {
    app,
    start() {
      accepting = true;
      return Promise.resolve();
    },
    async stop() {
      accepting = false;
      await app.close();
    },
  };
}
