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
import { parseExecutionStream } from "../../../packages/gateway/dist/dispatch.js";
import { probePrivateInvocation } from "../../../scripts/probe-m05-invocation.mjs";
import { fixtureConfigDigest } from "../../../scripts/probe-m05-runtime.mjs";
const { fetch, AbortSignal } = globalThis;
const require = createRequire(new URL("../../../packages/gateway/package.json", import.meta.url));
const { SignJWT, importPKCS8 } = await import(require.resolve("jose"));
export async function runGatewayProbe(config) {
  const phase = process.env.EMBODY_M05_PHASE ?? "initial";
  if (!["initial", "publish", "overlap", "removed", "watch-removal", "external"].includes(phase))
    throw new Error("Invalid rotation phase");
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
        protocolVersion: 1,
        target: `${origin === config.appOrigin ? config.appAudience : config.otherAppAudience}.ping`,
        input: {},
      }),
    });
    return {
      status: response.status,
      ...(response.status === 200 ? { body: await response.json() } : {}),
    };
  };
  if (phase === "external") {
    for (const [origin, workspaceId, audience] of [
      [config.appOrigin, config.workspaceId, config.appAudience],
      [config.otherAppOrigin, config.otherWorkspaceId, config.otherAppAudience],
    ]) {
      const jwt = await issueGatewayToken(
        { ...principal, orgId: workspaceId, scopes: [`${audience}:*`] },
        audience,
        "m05-external",
        signing,
      );
      if (
        (
          await fetch(new URL("/health", origin), {
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          })
        ).status !== 404 ||
        (await call(jwt, origin)).status !== 404
      )
        throw new Error("External ingress not closed");
    }
    return {
      gate: "m05-gateway-live",
      status: "passed",
      candidateSha: config.candidateSha,
      fixtureConfigSha256: fixtureConfigDigest(config),
      phase,
      checks: [
        "both-external-origins-denied-without-provider",
        "both-external-origins-denied-with-gateway-provider-and-valid-principal",
      ],
    };
  }
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
      new SignJWT({ ...principal, requestId: "m05-adversary", ...claims })
        .setProtectedHeader(header)
        .setIssuer(signing.issuer)
        .setAudience(claims.aud ?? config.appAudience)
        .setIssuedAt(claims.iat ?? now)
        .setExpirationTime(claims.exp ?? now + 300)
        .sign(signing.key);
    if ((await call(await jwt())).status !== 200)
      throw new Error("Valid adversary-template positive control rejected");
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
  const gatewayOrigins = JSON.parse(
    process.env.EMBODY_GATEWAY_ORIGINS ?? JSON.stringify([process.env.EMBODY_GATEWAY_ORIGIN]),
  );
  const crossRevisionMcp = [];
  const issued = newCredential({
    workspaceId: config.workspaceId,
    principal,
    grants: [{ workspaceId: config.workspaceId, appId: "app_kanban0001", role: "app-caller" }],
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  });
  let record,
    credentialRevoked = false;
  const revokeCredential = async () => {
    if (!record) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await store.credential(config.workspaceId, record.hash);
      if (!current || current.revoked) return true;
      try {
        await store.putCredential({ ...current, revoked: true }, current.revision);
        break;
      } catch {
        if (attempt === 2) return false;
      }
    }
    const revoked = await store.credential(config.workspaceId, record.hash);
    return !revoked || revoked.revoked;
  };
  try {
    record = await store.putCredential(issued.credential, null);
    const assertPing = (value, actorType) => {
      if (
        value?.ok !== true ||
        value.appId !== config.appAudience ||
        value.orgId !== config.workspaceId ||
        value.actorType !== actorType ||
        value.actorId !==
          (actorType === "agent" ? `mcp:${principal.actorId}` : principal.actorId) ||
        (actorType === "agent" &&
          (value.delegation?.subjectId !== principal.actorId ||
            value.delegation?.subjectType !== principal.actorType ||
            value.delegation?.client !== undefined))
      )
        throw new Error("Gateway attribution roundtrip failed");
    };
    for (const gatewayUrl of gatewayOrigins) {
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
        if (route === "execute") assertPing(await response.json(), "human");
        else {
          let terminal = 0;
          for await (const event of parseExecutionStream(response.body, "m05-live-stream")) {
            if (event.type === "error") throw new Error("Gateway stream execution failed");
            if (event.type === "result") {
              terminal++;
              assertPing(event.value, "human");
            }
          }
          if (terminal !== 1) throw new Error("Gateway stream terminal result missing");
        }
        checks.push(`${route}-roundtrip-accepted`);
      }
      const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
      const { StreamableHTTPClientTransport } = await import(
        require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")
      );
      const client = new Client({ name: "m05-live", version: "1" });
      const callRevisions = new Set();
      const crossRevision = phase === "overlap" && gatewayUrl === gatewayOrigins[0];
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`/w/${config.workspaceId}/mcp`, gatewayUrl), {
            requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
            fetch: async (url, init) => {
              const response = await fetch(url, init);
              if (typeof init?.body === "string" && JSON.parse(init.body).method === "tools/call") {
                const revision = response.headers.get("x-embody-gateway-revision");
                if (!revision) throw new Error("Gateway serving revision header missing");
                callRevisions.add(revision);
              }
              return response;
            },
          }),
        );
        let callCount = 0;
        for (; callCount < (crossRevision ? 24 : 1); callCount++) {
          const result = await client.callTool({ name: "kanban__kanban_ping", arguments: {} });
          if (result.isError || result.content?.[0]?.type !== "text")
            throw new Error("Live MCP delegated actor missing");
          assertPing(JSON.parse(result.content[0].text), "agent");
          if (crossRevision && callCount >= 7 && callRevisions.size === 2) {
            callCount++;
            break;
          }
        }
        if (crossRevision) {
          const expected = JSON.parse(process.env.EMBODY_GATEWAY_REVISIONS);
          if (
            expected.length !== 2 ||
            JSON.stringify([...callRevisions].sort()) !== JSON.stringify(expected.sort())
          )
            throw new Error("Gateway MCP did not cross both serving revisions in one client");
          crossRevisionMcp.push({
            origin: gatewayUrl,
            callCount,
            revisions: [...callRevisions].sort(),
          });
          checks.push("mcp-single-client-crosses-both-serving-revisions");
        }
        checks.push("mcp-delegated-agent-roundtrip-accepted");
      } finally {
        await client.close();
      }
    }
  } finally {
    try {
      credentialRevoked = await revokeCredential();
    } catch {
      console.error(JSON.stringify({ credentialRevocationFailed: true }));
    }
    await store.close();
  }
  if (!credentialRevoked) throw new Error("Gateway fixture credential revocation failed");
  if (["overlap", "removed", "watch-removal"].includes(phase)) {
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
    const oldKey = await importPKCS8(oldPem, "ES256");
    const old = await issueGatewayToken(principal, config.appAudience, "rotation-adversary", {
      ...signing,
      key: oldKey,
      kid: "m05-key-1",
    });
    if (phase === "watch-removal") {
      const scopes = [
        [config.appOrigin, config.workspaceId, config.appAudience],
        [config.otherAppOrigin, config.otherWorkspaceId, config.otherAppAudience],
      ];
      const mintOld = (workspaceId, audience) =>
        new SignJWT({
          ...principal,
          orgId: workspaceId,
          scopes: [`${audience}:*`],
          requestId: "m05-watch-old-key",
        })
          .setProtectedHeader({ alg: "ES256", kid: "m05-key-1" })
          .setIssuer(signing.issuer)
          .setAudience(audience)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(oldKey);
      const respondingInstances = [];
      for (const [origin, workspaceId, audience] of scopes) {
        const result = await call(await mintOld(workspaceId, audience), origin);
        if (result.status !== 200 || typeof result.body?.instanceNonce !== "string")
          throw new Error("Old-key cache positive control failed");
        respondingInstances.push({
          origin,
          instanceNonce: result.body.instanceNonce,
          revision: result.body.revision,
        });
      }
      const watchStart = Date.now();
      let lastOldPublicationAt, removedAt;
      for (let attempt = 0; attempt < 150; attempt++) {
        let jwks;
        try {
          jwks = await (
            await fetch(`${process.env.EMBODY_GATEWAY_ORIGIN}/.well-known/jwks.json`, {
              redirect: "error",
              signal: AbortSignal.timeout(5000),
            })
          ).json();
        } catch (error) {
          // A rollout transport interruption is not removal or a denial. Keep the last positive
          // publication time unchanged, so the eventual measured upper bound remains conservative.
          if (
            error.name !== "TimeoutError" &&
            !["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"].includes(error.cause?.code)
          )
            throw error;
          await delay(2000);
          continue;
        }
        if (!jwks.keys.some((key) => key.kid === "m05-key-1")) {
          if (!lastOldPublicationAt)
            throw new Error("Old key publication was never observed before removal");
          removedAt = Date.now();
          break;
        }
        const firstPublication = !lastOldPublicationAt;
        lastOldPublicationAt = Date.now();
        if (firstPublication)
          console.log(
            JSON.stringify({
              rotationWatchReady: true,
              candidateSha: config.candidateSha,
              fixtureConfigSha256: fixtureConfigDigest(config),
              respondingInstances,
              authoritativeOldKeyObservedAt: new Date(lastOldPublicationAt).toISOString(),
            }),
          );
        await delay(2000);
      }
      if (!removedAt) throw new Error("Authoritative key removal not observed");
      let deniedAt;
      for (let attempt = 0; attempt < 31; attempt++) {
        const statuses = [];
        for (const [origin, workspaceId, audience] of scopes)
          statuses.push((await call(await mintOld(workspaceId, audience), origin)).status);
        if (statuses.every((status) => status === 401)) {
          deniedAt = Date.now();
          break;
        }
        if (statuses.some((status) => ![200, 401].includes(status)))
          throw new Error("Rotation watcher lost app positive control");
        await delay(2000);
      }
      if (!deniedAt || deniedAt - lastOldPublicationAt > 60000)
        throw new Error("Old-key revocation exceeded60s");
      for (const [origin, workspaceId, audience] of scopes) {
        const result = await call(
          await issueGatewayToken(
            { ...principal, orgId: workspaceId, scopes: [`${audience}:*`] },
            audience,
            "m05-watch-new",
            signing,
          ),
          origin,
        );
        const before = respondingInstances.find((instance) => instance.origin === origin);
        if (
          result.status !== 200 ||
          result.body.instanceNonce !== before.instanceNonce ||
          result.body.revision !== before.revision
        )
          throw new Error("New key unavailable or observed app instance changed after removal");
      }
      return {
        gate: "m05-gateway-live",
        status: "passed",
        candidateSha: config.candidateSha,
        fixtureConfigSha256: fixtureConfigDigest(config),
        phase,
        checks: [
          ...checks,
          "live-old-key-positive-before-removal",
          "fresh-old-key-denied-within60s",
          "new-key-positive-after-removal",
        ],
        testedGatewayOrigins: gatewayOrigins,
        watchStart: new Date(watchStart).toISOString(),
        respondingInstances,
        authoritativeOldKeyLastObservedAt: new Date(lastOldPublicationAt).toISOString(),
        authoritativeRemovalObservedAt: new Date(removedAt).toISOString(),
        oldKeyDeniedAt: new Date(deniedAt).toISOString(),
        revocationMilliseconds: deniedAt - lastOldPublicationAt,
      };
    }
    const expected = phase === "overlap" ? 200 : 401;
    if ((await call(old)).status !== expected) throw new Error("Old-key rotation result incorrect");
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
    testedGatewayOrigins: gatewayOrigins,
    checks,
    timestamp: new Date().toISOString(),
    crossRevisionMcp,
    credentialRevoked,
    providerReady: Boolean(provider),
  };
}
