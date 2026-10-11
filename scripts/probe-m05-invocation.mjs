// Run inside the trusted gateway Cloud Run fixture, never an operator impersonation session.
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL, URL } from "node:url";
import { validateRuntimeProbe, fixtureConfigDigest } from "./probe-m05-runtime.mjs";

const { fetch, AbortSignal } = globalThis;
export async function probePrivateInvocation(
  config,
  { fetch: fetcher = fetch, invocationToken, principalToken } = {},
) {
  validateRuntimeProbe(config);
  const origin = new URL(config.appOrigin);
  if (
    origin.origin !== config.appOrigin ||
    origin.protocol !== "https:" ||
    !origin.hostname.endsWith(".run.app") ||
    !origin.hostname.startsWith(`${config.ownService}-`) ||
    !/^[a-z][a-z0-9_-]+$/.test(config.appAudience ?? "") ||
    typeof invocationToken !== "function" ||
    typeof principalToken !== "string" ||
    !principalToken
  )
    throw new Error(
      "Private invocation probe requires admitted fixture origin/audience and gateway identity",
    );
  const checks = [];
  const health = (headers = {}) =>
    fetcher(new URL("/health", origin), {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  // /health needs no Embody principal inside the host, so rejection proves the provider gate.
  if ((await health()).status !== 403)
    throw new Error("Unauthenticated app invocation not denied by provider");
  checks.push("unauthenticated-provider-invocation-denied");
  if ((await health({ "x-gateway-auth": `Bearer ${principalToken}` })).status !== 403)
    throw new Error("Leaked Embody principal token bypasses private provider invocation");
  checks.push("principal-token-without-provider-identity-denied");
  const confused = await health({ authorization: `Bearer ${principalToken}` });
  if (confused.status !== 401 && confused.status !== 403)
    throw new Error("Embody principal token accepted as provider identity");
  checks.push("principal-token-as-provider-identity-denied");
  const provider = await invocationToken(origin.origin);
  const response = await health({
    authorization: `Bearer ${provider}`,
    "x-gateway-auth": `Bearer ${principalToken}`,
  });
  if (response.status !== 200)
    throw new Error("Gateway provider invocation positive control failed");
  const result = await response.json();
  if (result.appId !== config.appAudience || result.live !== true || result.ready !== true)
    throw new Error("Gateway invoked the wrong or unready fixture app");
  checks.push("gateway-workload-invocation-positive-control");
  const otherProvider = await invocationToken(config.otherAppOrigin);
  const other = await fetcher(new URL("/health", config.otherAppOrigin), {
    method: "GET",
    headers: { authorization: `Bearer ${otherProvider}` },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (other.status !== 200) throw new Error("Other app gateway positive control failed");
  const otherHealth = await other.json();
  if (
    otherHealth.appId !== config.otherAppAudience ||
    otherHealth.live !== true ||
    otherHealth.ready !== true
  )
    throw new Error("Other app fixture identity/ready positive control failed");
  checks.push("other-app-gateway-invocation-positive-control");
  return {
    gate: "m05-private-invocation",
    status: "passed",
    candidateSha: config.candidateSha,
    project: config.project,
    resourcePrefix: config.prefix,
    gatewayIdentity: config.gateway,
    appOrigin: config.appOrigin,
    appOrigins: [config.appOrigin, config.otherAppOrigin],
    fixtureConfigSha256: fixtureConfigDigest(config),
    checks,
  };
}

async function main() {
  const path = resolve(
    process.env.EMBODY_TEST_EVIDENCE_DIR ?? ".artifacts/verification",
    "m05-private-invocation.json",
  );
  await rm(path, { force: true });
  if (
    process.env.EMBODY_MVP_CLOUD_BUDGET_APPROVED !== "true" ||
    !Number.isFinite(Number(process.env.EMBODY_MVP_CLOUD_BUDGET_USD)) ||
    !(Number(process.env.EMBODY_MVP_CLOUD_BUDGET_USD) > 0) ||
    !process.env.EMBODY_M05_RUNTIME_PROBE_CONFIG
  )
    throw new Error("Approved fixture budget/config required");
  const config = validateRuntimeProbe(
    JSON.parse(await readFile(process.env.EMBODY_M05_RUNTIME_PROBE_CONFIG, "utf8")),
  );
  if (
    config.project !== process.env.EMBODY_MVP_CLOUD_PROJECT ||
    config.prefix !== process.env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX
  )
    throw new Error("Invocation config does not match approved fixture");
  const { hostedSigningIdentity, issueGatewayToken, cloudRunInvocationToken } =
    await import("../packages/gateway/dist/index.js");
  const signing = await hostedSigningIdentity({
    issuer: process.env.GATEWAY_JWT_ISSUER,
    kid: process.env.GATEWAY_JWT_KID,
    privateKeyPem: process.env.GATEWAY_JWT_PRIVATE_KEY,
    publicKeys: JSON.parse(process.env.GATEWAY_JWT_PUBLIC_JWKS).keys,
  });
  const principalToken = await issueGatewayToken(
    {
      orgId: config.workspaceId,
      actorId: "qualification-probe",
      actorType: "system",
      roles: [],
      scopes: [],
    },
    config.appAudience,
    "m05-private-invocation",
    signing,
  );
  const report = await probePrivateInvocation(config, {
    principalToken,
    invocationToken: cloudRunInvocationToken({ serviceAccountEmail: config.gateway }),
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ ...report, timestamp: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("M05 private invocation probe failed; no success evidence recorded");
    process.exitCode = 1;
  });
}
