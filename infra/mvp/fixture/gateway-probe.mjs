import { createRequire } from "node:module";
import { URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Buffer } from "node:buffer";
import {
  hostedSigningIdentity,
  issueGatewayToken,
  cloudRunInvocationToken,
  PostgresGatewayStore,
  newCredential,
} from "../../../packages/gateway/dist/index.js";
import { probePrivateInvocation } from "../../../scripts/probe-m05-invocation.mjs";
const { fetch, AbortSignal } = globalThis;
const require = createRequire(new URL("../../../packages/gateway/package.json", import.meta.url));
const { SignJWT, importPKCS8 } = await import(require.resolve("jose"));
export async function runGatewayProbe(config) {
  const phase = process.env.EMBODY_M05_PHASE ?? "initial";
  if (!["initial", "overlap", "removed"].includes(phase)) throw new Error("Invalid rotation phase");
  const signing = await hostedSigningIdentity({
    issuer: process.env.GATEWAY_JWT_ISSUER,
    kid: process.env.GATEWAY_JWT_KID,
    privateKeyPem: process.env.GATEWAY_JWT_PRIVATE_KEY,
    publicKeys: JSON.parse(process.env.GATEWAY_JWT_PUBLIC_JWKS).keys,
  });
  const invocationToken = cloudRunInvocationToken({ serviceAccountEmail: config.gateway });
  const principal = {
    orgId: config.workspaceId,
    actorId: "m05-probe",
    actorType: "human",
    roles: [],
    scopes: ["kanban:*"],
  };
  const valid = await issueGatewayToken(principal, config.appAudience, "m05-live-probe", signing);
  const provider = await invocationToken(config.appOrigin);
  const call = async (jwt, origin = config.appOrigin) => {
    const response = await fetch(new URL("/execute", origin), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${await invocationToken(origin)}`,
        "x-gateway-auth": `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        target: `${origin === config.appOrigin ? config.appAudience : config.otherAppAudience}.ping`,
        input: {},
      }),
    });
    return {
      status: response.status,
      ...(response.status === 200 ? { body: await response.json() } : {}),
    };
  };
  // Warm actual services before five-second targeted health probes; no mocked provider.
  for (const origin of [config.appOrigin, config.otherAppOrigin]) {
    let ready = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await fetch(new URL("/health", origin), {
        headers: { authorization: `Bearer ${await invocationToken(origin)}` },
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      });
      if (response.status === 200 && (await response.json()).ready === true) {
        ready = true;
        break;
      }
      await delay(2000);
    }
    if (!ready) throw new Error("Live app not ready");
  }
  if ((await call(valid)).status !== 200) throw new Error("Valid live principal rejected");
  const checks = ["valid-current-principal-accepted"];
  if (phase === "initial") {
    const network = await probePrivateInvocation(config, {
      invocationToken,
      principalToken: valid,
    });
    checks.push(...network.checks);
    const now = Math.floor(Date.now() / 1000);
    const jwt = async (claims = {}, header = { alg: "ES256", kid: process.env.GATEWAY_JWT_KID }) =>
      new SignJWT({ ...principal, app: config.appAudience, requestId: "m05-adversary", ...claims })
        .setProtectedHeader(header)
        .setIssuer(signing.issuer)
        .setAudience(claims.aud ?? config.appAudience)
        .setIssuedAt(claims.iat ?? now)
        .setExpirationTime(claims.exp ?? now + 300)
        .sign(signing.key);
    const negative = [
      ["wrong-workspace", await jwt({ orgId: "ws_wrongtenant0001" })],
      ["wrong-app", await jwt({ aud: config.otherAppAudience, app: config.otherAppAudience })],
      ["array-audience", await jwt({ aud: [config.appAudience, config.otherAppAudience] })],
      ["expired", await jwt({ iat: now - 400, exp: now - 100 })],
      ["excessive-lifetime", await jwt({ exp: now + 600 })],
      ["future-iat", await jwt({ iat: now + 60, exp: now + 300 })],
      ["missing-kid", await jwt({}, { alg: "ES256" })],
      [
        "forged-human-delegation",
        await jwt({ delegation: { client: "fake", subjectId: "owner", subjectType: "human" } }),
      ],
      [
        "forged-signature",
        valid.slice(0, valid.lastIndexOf(".") + 1) + Buffer.alloc(64).toString("base64url"),
      ],
    ];
    for (const [name, token] of negative) {
      if ((await call(token)).status !== 401) throw new Error(`Live ${name} not rejected`);
      checks.push(`${name}-rejected`);
    }
    if ((await call(valid, config.otherAppOrigin)).status !== 401)
      throw new Error("Cross-app/workspace replay accepted");
    checks.push("cross-app-workspace-replay-rejected");
  }
  const store = new PostgresGatewayStore(process.env.GATEWAY_PLATFORM_DATABASE_URL);
  const issued = newCredential({
    workspaceId: config.workspaceId,
    principal,
    grants: [{ workspaceId: config.workspaceId, appId: "app_kanban0001", role: "app-caller" }],
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  });
  let record;
  try {
    record = await store.putCredential(issued.credential, null);
    const gatewayUrl = process.env.EMBODY_GATEWAY_ORIGIN;
    for (const route of ["execute", "execute/stream"]) {
      const response = await fetch(
        `${gatewayUrl}/w/${config.workspaceId}/api/${route}/kanban/kanban.ping`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          headers: {
            authorization: `Bearer ${issued.token}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      if (response.status !== 200) throw new Error("Gateway roundtrip failed");
      await response.text();
      checks.push(`${route}-roundtrip-accepted`);
    }
    const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
    const { StreamableHTTPClientTransport } = await import(
      require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")
    );
    const client = new Client({ name: "m05-live", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`/w/${config.workspaceId}/mcp`, gatewayUrl), {
          requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
        }),
      );
      const result = await client.callTool({ name: "kanban__kanban_ping", arguments: {} });
      if (
        result.isError ||
        !JSON.stringify(result).includes('"agent"') ||
        !JSON.stringify(result).includes('"delegation"')
      )
        throw new Error("Live MCP delegated actor missing");
      checks.push("mcp-delegated-agent-roundtrip-accepted");
    } finally {
      await client.close();
    }
  } finally {
    if (record) await store.putCredential({ ...record, revoked: true }, record.revision);
    await store.close();
  }
  if (["overlap", "removed"].includes(phase)) {
    const metadata = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) },
    );
    if (!metadata.ok || metadata.headers.get("metadata-flavor") !== "Google")
      throw new Error("Metadata token unavailable");
    const access = (await metadata.json()).access_token;
    const secret = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/${config.project}/secrets/${config.signingSecret}/versions/${process.env.EMBODY_OLD_SIGNER_VERSION}:access`,
      { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(5000) },
    );
    if (!secret.ok) throw new Error("Old key authority unavailable");
    const oldPem = Buffer.from((await secret.json()).payload.data, "base64").toString("utf8");
    const old = await new SignJWT({
      ...principal,
      app: config.appAudience,
      requestId: "rotation-adversary",
    })
      .setProtectedHeader({ alg: "ES256", kid: "m05-key-1" })
      .setIssuer(signing.issuer)
      .setAudience(config.appAudience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(await importPKCS8(oldPem, "ES256"));
    const expected = phase === "overlap" ? 200 : 401;
    if ((await call(old)).status !== expected)
      throw new Error("Old signer rotation result incorrect");
    checks.push(
      phase === "overlap"
        ? "old-and-new-keys-accepted"
        : "fresh-retired-key-token-rejected-current-key-accepted",
    );
  }
  return {
    gate: "m05-gateway-live",
    status: "passed",
    phase,
    candidateSha: config.candidateSha,
    project: config.project,
    gatewayIdentity: config.gateway,
    fixtureConfigSha256: (
      await import("../../../scripts/probe-m05-runtime.mjs")
    ).fixtureConfigDigest(config),
    appOrigins: [config.appOrigin, config.otherAppOrigin],
    checks,
    timestamp: new Date().toISOString(),
    providerReady: Boolean(provider),
  };
}
