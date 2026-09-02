import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  UnauthenticatedError,
  UnavailableError,
  ValidationError,
  executionRequestSchema,
  stableStringify,
  toErrorEnvelope,
} from "@embody/core";
import type { Kernel } from "@embody/core";
import type { AppAuthVerifier } from "@embody/auth";

export interface HostOptions {
  readonly kernel: Kernel;
  readonly verifier: AppAuthVerifier;
  readonly appId: string;
  readonly version: string;
  readonly environment?: "development" | "production";
  readonly bodyLimit?: number;
  readonly requestTimeoutMs?: number;
  readonly concurrency?: number;
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
}
/** Gateway registration with an injectable scheduler for deterministic host tests. */
export function createRegistrationClient(options: RegistrationClientOptions) {
  const fetcher = options.fetch ?? fetch;
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | undefined;
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
  };
  return {
    manifestHash,
    register,
    start: async (): Promise<void> => {
      await register();
      timer = schedule(() => {
        void send("/heartbeat", {
          protocolVersion: 1,
          appId: options.appId,
          generation: manifestHash,
        })
          .then((response) => {
            if (response.status === 404) return register();
          })
          .catch(() => undefined);
      }, 30_000);
    },
    stop: (): void => {
      if (timer !== undefined) cancel(timer);
      timer = undefined;
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
  app.post("/execute", async (request, reply) => {
    if (!accepting || options.kernel.state !== "ready") throw new UnavailableError();
    if (active >= maximum) {
      reply.header("retry-after", "1");
      throw new UnavailableError("Execution capacity is exhausted");
    }
    const parsed = executionRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError("Request is invalid");
    const gatewayAuth = request.headers["x-gateway-auth"];
    const principal = await options.verifier.verify(
      bearer(typeof gatewayAuth === "string" ? gatewayAuth : undefined),
    );
    const controller = new AbortController();
    request.raw.once("close", () => controller.abort());
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
