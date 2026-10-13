import { request } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { ForbiddenError, UnavailableError } from "@embody/core";

/** Conservative public-address policy, including mapped IPv4 and non-global IPv6. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // Only global-unicast IPv6; mapped addresses, loopback, ULA and link-local fail closed.
  if (isIP(address) !== 6 || !/^[23][0-9a-f]{3}:/i.test(address)) return false;
  const lower = address.toLowerCase();
  const [first, second = "0"] = lower.split(":");
  // Reject transition/tunnel and documentation ranges as well as non-global space.
  return (
    first !== "2002" &&
    !lower.startsWith("3fff:") &&
    !(first === "2001" && (parseInt(second || "0", 16) < 0x200 || parseInt(second, 16) === 0xdb8))
  );
}

/** No DNS check/use race: resolve once, validate every answer, pin the connection address.
 * TLS still verifies the original hostname. No redirect, proxy, pooling or retry engine.
 */
export const publicEndpointFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    throw new ForbiddenError("Deployment endpoint must use HTTPS on port 443");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address)))
    throw new ForbiddenError("Deployment endpoint resolved to a prohibited address");
  init?.signal?.throwIfAborted();
  const pinned = addresses[0]!;
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(init?.signal ? { signal: init.signal } : {}),
        agent: false,
        family: pinned.family,
        lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
      },
      (res) => {
        try {
          const status = res.statusCode ?? 502;
          if (status >= 300 && status < 400)
            throw new ForbiddenError("Deployment redirects are prohibited");
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers))
            if (value !== undefined)
              headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          const bodyless = status === 204 || status === 205;
          if (bodyless) res.resume();
          resolve(
            new Response(bodyless ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
              status,
              headers,
            }),
          );
        } catch (error) {
          res.destroy();
          reject(error instanceof Error ? error : new UnavailableError("Invalid remote response"));
        }
      },
    );
    req.on("error", reject);
    req.end(typeof init?.body === "string" ? init.body : undefined);
  });
};

/** Bound the entire body, not just response headers or individual SSE frames. */
export function boundedFetch(
  fetcher: typeof fetch,
  timeoutMs = 30_000,
  maxBytes = 1_048_576,
): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    const signal = AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]);
    if (signal.aborted) {
      clearTimeout(timer);
      throw new UnavailableError("Action cancelled; outcome unknown; do not replay");
    }
    const state: { reader?: ReadableStreamDefaultReader<Uint8Array>; abort?: () => void } = {};
    const cleanup = () => {
      clearTimeout(timer);
      if (state.abort) signal.removeEventListener("abort", state.abort);
      delete state.reader;
    };
    const aborted = new Promise<never>((_resolve, reject) => {
      const abort = () => {
        reject(
          new UnavailableError(
            "Action deadline exceeded or cancelled; outcome unknown; do not replay",
          ),
        );
        void state.reader?.cancel().catch(() => undefined);
      };
      state.abort = abort;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    // Avoid unhandled rejection when the caller has finished consuming the body.
    void aborted.catch(() => undefined);
    let response: Response;
    try {
      const operation = fetcher(input, { ...init, signal, redirect: "error" });
      void operation
        .then((late) => {
          if (signal.aborted) void late.body?.cancel().catch(() => undefined);
        })
        .catch(() => undefined);
      response = await Promise.race([operation, aborted]);
    } catch (error) {
      controller.abort();
      cleanup();
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      controller.abort();
      void response.body?.cancel().catch(() => undefined);
      cleanup();
      throw new ForbiddenError("Deployment redirects are prohibited");
    }
    if (!response.body) {
      cleanup();
      return response;
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    state.reader = reader;
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (chunk.done) {
            stream.close();
            cleanup();
            reader.releaseLock();
            return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes)
            throw new UnavailableError("Remote body exceeds limit; outcome unknown; do not replay");
          stream.enqueue(chunk.value);
        } catch (error) {
          stream.error(error);
          controller.abort();
          void reader.cancel().catch(() => undefined);
          cleanup();
        }
      },
      cancel() {
        controller.abort();
        cleanup();
        return reader.cancel().catch(() => undefined);
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
}
