// Operator launches bounded jobs; probes themselves use ONLY attached workload metadata.
import { setTimeout as delay } from "node:timers/promises";
import { operator, loadPrivate } from "./bootstrap.mjs";
import { fixtureConfigDigest } from "../../../scripts/probe-m05-runtime.mjs";
import { servingInventory } from "./inventory.mjs";
async function main() {
  if (
    process.env.EMBODY_MVP_CLOUD_BUDGET_APPROVED !== "true" ||
    process.env.EMBODY_MVP_CLOUD_BUDGET_USD !== "10"
  )
    throw new Error("Approval required");
  const mode = process.argv[2];
  if (!["runtime-probe", "gateway-probe"].includes(mode)) throw new Error("Unknown probe");
  const data = await loadPrivate(),
    { api } = await operator();
  const { project, region, prefix, config } = data;
  const phase = process.env.EMBODY_M05_JOB_PHASE ?? data.phase;
  if (!["initial", "publish", "overlap", "removed", "watch-removal", "external"].includes(phase))
    throw new Error("Invalid job phase");
  if (
    (phase === "external" && data.phase !== "removed") ||
    (phase === "watch-removal" && data.phase !== "overlap") ||
    (!["external", "watch-removal"].includes(phase) && phase !== data.phase)
  )
    throw new Error("Probe phase does not match deployment phase");
  const inventory = await servingInventory(api, data);
  const gatewayOrigins = [
    data.gateway,
    ...inventory[0].revisions.map((revision) => revision.uri).filter(Boolean),
  ];
  const requiredChecks =
    mode === "runtime-probe"
      ? [
          "actual-runtime-metadata-identity",
          "own-secret-access-positive-control",
          "platform-database-secret-denied",
          "other-app-secret-denied",
          "gateway-signing-secret-denied",
          "effective-permission-positive-control",
          "foreign-secret-version-policy-and-write-denied",
          "deployment-and-build-denied",
          "service-scoped-deployment-and-iam-denied",
          "builder-artifact-write-denied",
          "workload-impersonation-signing-and-actas-denied",
          "gateway-impersonation-denied",
          "non-gateway-authenticated-own-and-other-app-invocation-denied",
          "own-database-least-privilege-positive-control",
          "platform-database-connect-denied",
          "other-database-connect-denied",
        ]
      : phase === "external"
        ? [
            "both-external-origins-denied-without-provider",
            "both-external-origins-denied-with-gateway-provider-and-valid-principal",
          ]
        : [
            "valid-current-principal-accepted",
            "execute-roundtrip-accepted",
            "execute/stream-roundtrip-accepted",
            "mcp-delegated-agent-roundtrip-accepted",
            ...(phase === "initial"
              ? [
                  "unauthenticated-provider-invocation-denied",
                  "principal-token-without-provider-identity-denied",
                  "principal-token-as-provider-identity-denied",
                  "gateway-workload-invocation-positive-control",
                  "other-app-gateway-invocation-positive-control",
                  ...[
                    "wrong-workspace",
                    "wrong-app",
                    "array-audience",
                    "expired",
                    "excessive-lifetime",
                    "future-iat",
                    "missing-kid",
                    "forged-human-delegation",
                    "forged-signature",
                  ].map((label) => `${label}-rejected`),
                  "cross-app-workspace-replay-rejected",
                ]
              : []),
            ...(phase === "overlap"
              ? ["old-and-new-keys-accepted"]
              : phase === "removed"
                ? ["fresh-retired-key-token-rejected-current-key-accepted"]
                : []),
            ...(phase === "watch-removal"
              ? [
                  "live-old-key-positive-before-removal",
                  "fresh-old-key-denied-within60s",
                  "new-key-positive-after-removal",
                ]
              : []),
          ];
  const name = `${prefix}-${phase === "external" ? "external-probe" : phase === "watch-removal" ? "rotation-watch" : mode}`,
    serviceAccount = mode === "runtime-probe" ? config.runtime : config.gateway;
  const env = [
    { name: "EMBODY_SQL_CONNECTION", value: `${project}:${region}:${prefix}-postgres` },
    {
      name: "EMBODY_SQL_SOCKET",
      value: process.env.EMBODY_M05_JOB_SQL_TRANSPORT === "proxy" ? "false" : "true",
    },
    { name: "EMBODY_MVP_CLOUD_PROJECT", value: project },
    { name: "EMBODY_MVP_CLOUD_RESOURCE_PREFIX", value: prefix },
    { name: "EMBODY_MVP_CLOUD_BUDGET_APPROVED", value: "true" },
    { name: "EMBODY_MVP_CLOUD_BUDGET_USD", value: "10" },
    { name: "EMBODY_M05_CONFIG", value: JSON.stringify(config) },
    { name: "EMBODY_M05_PHASE", value: phase },
    { name: "EMBODY_GATEWAY_ORIGIN", value: data.gateway },
    { name: "EMBODY_GATEWAY_ORIGINS", value: JSON.stringify([...new Set(gatewayOrigins)]) },
    { name: "EMBODY_OLD_SIGNER_VERSION", value: data.secretVersions.signer1.split("/").at(-1) },
  ];
  if (mode === "gateway-probe")
    env.push(
      { name: "GATEWAY_JWT_ISSUER", value: "https://embody-cloud.m05.gateway" },
      {
        name: "GATEWAY_JWT_KID",
        value: ["initial", "publish"].includes(data.phase) ? "m05-key-1" : "m05-key-2",
      },
      {
        name: "GATEWAY_JWT_PUBLIC_JWKS",
        value: JSON.stringify({
          keys:
            data.phase === "initial"
              ? [data.publicKeys[0]]
              : ["publish", "overlap"].includes(data.phase)
                ? data.publicKeys
                : [data.publicKeys[1]],
        }),
      },
      {
        name: "GATEWAY_JWT_PRIVATE_KEY",
        valueSource: {
          secretKeyRef: {
            secret: `${prefix}-signer`,
            version: data.secretVersions[
              ["initial", "publish"].includes(data.phase) ? "signer1" : "signer2"
            ]
              .split("/")
              .at(-1),
          },
        },
      },
      {
        name: "GATEWAY_PLATFORM_DATABASE_URL",
        valueSource: {
          secretKeyRef: {
            secret: `${prefix}-platform-db`,
            version: data.secretVersions.platform.split("/").at(-1),
          },
        },
      },
    );
  const base = `https://run.googleapis.com/v2/projects/${project}/locations/${region}`,
    url = `${base}/jobs/${name}`;
  let current;
  try {
    current = await api(url);
  } catch {
    current = null;
  }
  if (current && current.labels?.managed_by !== "embody-m05-probe-fixture")
    throw new Error("Job ownership mismatch");
  const template = {
    taskCount: 1,
    parallelism: 1,
    template: {
      serviceAccount,
      ...(phase === "external"
        ? {}
        : {
            vpcAccess: {
              egress: "ALL_TRAFFIC",
              networkInterfaces: [{ network: `${prefix}-network`, subnetwork: `${prefix}-subnet` }],
            },
          }),
      timeout: phase === "watch-removal" ? "600s" : "300s",
      maxRetries: 0,
      volumes: [
        {
          name: "cloudsql",
          cloudSqlInstance: { instances: [`${project}:${region}:${prefix}-postgres`] },
        },
      ],
      containers: [
        {
          image: data.image,
          volumeMounts: [{ name: "cloudsql", mountPath: "/cloudsql" }],
          args: [mode],
          resources: { limits: { cpu: "1", memory: "512Mi" } },
          env,
        },
      ],
    },
  };
  let operation = await api(
    current ? url : `${base}/jobs?jobId=${name}`,
    current ? "PATCH" : "POST",
    {
      labels: { managed_by: "embody-m05-probe-fixture", fixture: prefix },
      template,
      ...(current ? { name: current.name, etag: current.etag } : {}),
    },
  );
  async function wait(op) {
    for (let attempt = 0; !op.done && attempt < 660; attempt++) {
      await delay(1000);
      op = await api(`https://run.googleapis.com/v2/${op.name}`);
    }
    if (!op.done || op.error) throw new Error("Job operation failed");
    return op.response;
  }
  await wait(operation);
  operation = await api(`${url}:run`, "POST", {});
  let execution;
  try {
    execution = await wait(operation);
  } catch {
    console.error(JSON.stringify({ probe: mode, status: "failed", operation: operation.name }));
    process.exitCode = 1;
    return;
  }
  await delay(5000);
  const suffix = execution.name.split("/").at(-1);
  const logs = await api("https://logging.googleapis.com/v2/entries:list", "POST", {
    resourceNames: [`projects/${project}`],
    filter: `resource.type="cloud_run_job" AND resource.labels.job_name="${name}" AND jsonPayload.gate:*`,
    // Bind the returned log label exactly in code; the provider label filter returned no matches.
    orderBy: "timestamp desc",
    pageSize: 100,
  });
  const reports = (logs.entries ?? [])
    .filter(
      (entry) =>
        entry.labels?.["run.googleapis.com/execution_name"] === suffix &&
        entry.jsonPayload?.gate?.startsWith("m05-"),
    )
    .map((entry) => entry.jsonPayload);
  if (
    execution.succeededCount !== 1 ||
    !reports.some(
      (report) =>
        report.status === "passed" &&
        report.sourceSha === data.candidateSha &&
        (mode === "runtime-probe"
          ? report.runtimeIdentity === config.runtime
          : phase === "external" ||
            (Array.isArray(report.testedGatewayOrigins) &&
              JSON.stringify([...new Set(report.testedGatewayOrigins)].sort()) ===
                JSON.stringify([...new Set(gatewayOrigins)].sort()))) &&
        Array.isArray(report.checks) &&
        requiredChecks.every((check) => report.checks.includes(check)) &&
        report.candidateSha === data.candidateSha &&
        report.fixtureConfigSha256 === fixtureConfigDigest(config) &&
        (mode === "runtime-probe" || report.phase === phase),
    )
  )
    throw new Error("No successful execution/probe evidence");
  const finalInventory = await servingInventory(api, data);
  console.log(
    JSON.stringify({
      execution: execution.name,
      image: data.image,
      serviceAccount,
      inventory,
      finalInventory,
      reports,
    }),
  );
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      jobFailed: true,
      publicError:
        /^(Serving |Probe phase|Invalid job phase|Job ownership|Job operation|No successful)/.test(
          error.message,
        )
          ? error.message
          : "private diagnostics suppressed",
    }),
  );
  process.exitCode = 1;
});
