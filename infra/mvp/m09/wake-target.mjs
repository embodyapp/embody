// M09 disposable wake target: a request-only Cloud Run service standing in for an app's drain.
// It authenticates every wake with the real @embody/auth platform invoker verifier and logs one
// structured line per request (no token, no payload beyond the probe label). Never production.
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

/** Claim facts worth recording, from the token's unverified payload. Never the token itself. */
export function claimSummary(token, { audience, invokerEmail }) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    return {
      issuer: typeof payload.iss === "string" ? payload.iss : null,
      audienceMatches: payload.aud === audience,
      hasEmail: typeof payload.email === "string",
      emailMatches: payload.email === invokerEmail,
      emailVerified: payload.email_verified === true,
      lifetimeSeconds:
        typeof payload.exp === "number" && typeof payload.iat === "number"
          ? payload.exp - payload.iat
          : null,
    };
  } catch {
    return null;
  }
}

/** Parses the probe body: a short label and how many leading attempts answer 503. */
export function probeRequest(text) {
  try {
    const body = JSON.parse(text);
    const probe =
      typeof body.probe === "string" && /^[a-z0-9-]{1,64}$/.test(body.probe) ? body.probe : null;
    const fail503 =
      Number.isInteger(body.fail503) && body.fail503 >= 0 && body.fail503 <= 10 ? body.fail503 : 0;
    return probe ? { probe, fail503 } : null;
  } catch {
    return null;
  }
}

export function createWakeTarget({
  verifier,
  audience,
  invokerEmail,
  log = console.log,
  now = () => new Date(),
}) {
  return async function handle(request, response) {
    const answer = (status, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end("{}");
      return status;
    };
    if (request.method !== "POST" || request.url !== "/_embody/drain") return answer(404);
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 65536) return answer(413);
      chunks.push(chunk);
    }
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    let verified = false;
    try {
      await verifier.verify(token);
      verified = true;
    } catch {
      verified = false;
    }
    const body = probeRequest(Buffer.concat(chunks).toString("utf8"));
    const retryCount = Number(request.headers["x-cloudtasks-taskretrycount"] ?? NaN);
    const status = !verified
      ? 401
      : !body
        ? 400
        : Number.isInteger(retryCount) && retryCount < body.fail503
          ? 503
          : 200;
    log(
      JSON.stringify({
        message: "embody.m09.wake",
        probe: body?.probe ?? null,
        task: String(request.headers["x-cloudtasks-taskname"] ?? "").slice(0, 120) || null,
        queue: String(request.headers["x-cloudtasks-queuename"] ?? "").slice(0, 120) || null,
        retryCount: Number.isInteger(retryCount) ? retryCount : null,
        executionCount: Number(request.headers["x-cloudtasks-taskexecutioncount"] ?? NaN) || 0,
        eta: request.headers["x-cloudtasks-tasketa"] ?? null,
        receivedAt: now().toISOString(),
        verified,
        claims: token ? claimSummary(token, { audience, invokerEmail }) : null,
        status,
      }),
    );
    return answer(status, status === 503 ? { "retry-after": "1" } : {});
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const audience = process.env.EMBODY_DRAIN_AUDIENCE;
  const invokerEmail = process.env.EMBODY_DRAIN_INVOKER_EMAIL;
  if (!audience?.startsWith("https://") || !invokerEmail?.includes("@"))
    throw new Error("Wake target needs EMBODY_DRAIN_AUDIENCE and EMBODY_DRAIN_INVOKER_EMAIL");
  const { platformInvokerVerifier } = await import("../../../packages/auth/dist/index.js");
  const handle = createWakeTarget({
    verifier: platformInvokerVerifier({ audience, invokerEmail }),
    audience,
    invokerEmail,
  });
  console.log(JSON.stringify({ message: "embody.m09.start", at: new Date().toISOString() }));
  createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  }).listen(Number(process.env.PORT ?? 8080));
}
