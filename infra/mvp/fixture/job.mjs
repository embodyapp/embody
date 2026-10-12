// Operator launches bounded jobs; probes themselves use ONLY attached workload metadata.
import { setTimeout as delay } from "node:timers/promises";
import { operator, loadPrivate } from "./bootstrap.mjs";
import { fixtureConfigDigest } from "../../../scripts/probe-m05-runtime.mjs";
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
  const name = `${prefix}-${mode}`,
    serviceAccount = mode === "runtime-probe" ? config.runtime : config.gateway;
  const env = [
    { name: "EMBODY_SQL_CONNECTION", value: `${project}:${region}:${prefix}-postgres` },
    { name: "EMBODY_SQL_SOCKET", value: "true" },
    { name: "EMBODY_MVP_CLOUD_PROJECT", value: project },
    { name: "EMBODY_MVP_CLOUD_RESOURCE_PREFIX", value: prefix },
    { name: "EMBODY_MVP_CLOUD_BUDGET_APPROVED", value: "true" },
    { name: "EMBODY_MVP_CLOUD_BUDGET_USD", value: "10" },
    { name: "EMBODY_M05_CONFIG", value: JSON.stringify(config) },
    { name: "EMBODY_M05_PHASE", value: data.phase },
    { name: "EMBODY_GATEWAY_ORIGIN", value: data.gateway },
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
      vpcAccess: {
        egress: "ALL_TRAFFIC",
        networkInterfaces: [{ network: `${prefix}-network`, subnetwork: `${prefix}-subnet` }],
      },
      timeout: "300s",
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
    for (let attempt = 0; !op.done && attempt < 360; attempt++) {
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
    filter: `resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="${suffix}"`,
    orderBy: "timestamp asc",
    pageSize: 100,
  });
  const reports = (logs.entries ?? [])
    .filter((entry) => entry.jsonPayload?.gate?.startsWith("m05-"))
    .map((entry) => entry.jsonPayload);
  if (
    execution.succeededCount !== 1 ||
    !reports.some(
      (report) =>
        report.status === "passed" &&
        report.candidateSha === data.candidateSha &&
        report.fixtureConfigSha256 === fixtureConfigDigest(config) &&
        (mode === "runtime-probe" || report.phase === data.phase),
    )
  )
    throw new Error("No successful execution/probe evidence");
  console.log(
    JSON.stringify({ execution: execution.name, image: data.image, serviceAccount, reports }),
  );
}
main().catch(() => {
  console.error("M05 job failed; private diagnostics suppressed");
  process.exitCode = 1;
});
