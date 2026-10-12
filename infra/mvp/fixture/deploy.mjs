// Operator-only bounded fixture orchestration. No credentials in output/config/state.
import { setTimeout as delay } from "node:timers/promises";
import { operator, loadPrivate, savePrivate } from "./bootstrap.mjs";
import { createCloudRunAppProvisioner } from "../provider/cloud-run.mjs";
import { PostgresGatewayStore } from "../../../packages/gateway/dist/index.js";
import { Kernel } from "../../../packages/core/dist/index.js";
import { PostgresStorage } from "../../../packages/storage/dist/index.js";
import { fixtureApp } from "./app.mjs";
async function main() {
  if (
    process.env.EMBODY_MVP_CLOUD_PROJECT !== "embody-cloud" ||
    process.env.EMBODY_MVP_CLOUD_BUDGET_APPROVED !== "true" ||
    process.env.EMBODY_MVP_CLOUD_BUDGET_USD !== "10"
  )
    throw new Error("Fixture approval required");
  const data = await loadPrivate(),
    { api, token } = await operator();
  const { project, prefix, region } = data;
  const image = process.env.EMBODY_M05_IMAGE,
    candidateSha = process.env.EMBODY_M05_SHA;
  if (
    !/^us-central1-docker\.pkg\.dev\/embody-cloud\/embody-test-m05-images\/fixture@sha256:[a-f0-9]{64}$/.test(
      image ?? "",
    ) ||
    !/^[a-f0-9]{40}$/.test(candidateSha ?? "")
  )
    throw new Error("Immutable image/source required");
  const connection = `${project}:${region}:${prefix}-postgres`,
    gatewayEmail = `${prefix}-gateway@${project}.iam.gserviceaccount.com`;
  const projectUrl = `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`;
  const policy = await api(`${projectUrl}:getIamPolicy`, "POST", {
    options: { requestedPolicyVersion: 3 },
  });
  policy.version = 3;
  const members = [gatewayEmail, ...data.apps.map((app) => app.runtimeEmail)].map(
    (email) => `serviceAccount:${email}`,
  );
  policy.bindings = policy.bindings
    .map((binding) =>
      binding.role === "roles/cloudsql.client"
        ? { ...binding, members: binding.members.filter((member) => !members.includes(member)) }
        : binding,
    )
    .filter((binding) => binding.members.length);
  policy.bindings.push({
    role: "roles/cloudsql.client",
    members,
    condition: {
      title: "m05-only-instance",
      expression: `resource.name.endsWith('/instances/${prefix}-postgres')`,
    },
  });
  await api(`${projectUrl}:setIamPolicy`, "POST", { policy });
  const issuer = "https://embody-cloud.m05.gateway";
  const env = (phase) => [
    { name: "NODE_ENV", value: "production" },
    { name: "GATEWAY_PROFILE", value: "hosted" },
    { name: "EMBODY_SQL_CONNECTION", value: connection },
    { name: "EMBODY_SQL_SOCKET", value: "true" },
    { name: "EMBODY_FIXTURE_MODE", value: "gateway" },
    { name: "GATEWAY_SERVICE_ACCOUNT_EMAIL", value: gatewayEmail },
    { name: "GATEWAY_JWT_ISSUER", value: issuer },
    {
      name: "GATEWAY_JWT_KID",
      value: ["initial", "publish"].includes(phase) ? "m05-key-1" : "m05-key-2",
    },
    {
      name: "GATEWAY_JWT_PUBLIC_JWKS",
      value: JSON.stringify({
        keys:
          phase === "initial"
            ? [data.publicKeys[0]]
            : ["publish", "overlap"].includes(phase)
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
            ["initial", "publish"].includes(phase) ? "signer1" : "signer2"
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
  ];
  const phase = process.env.EMBODY_M05_PHASE ?? "initial";
  if (!["initial", "publish", "overlap", "removed"].includes(phase))
    throw new Error("Invalid phase");
  if (phase === "overlap" && (!data.publishAt || Date.now() - Date.parse(data.publishAt) < 60000))
    throw new Error("Public-key overlap must converge for60s before switching");
  if (
    phase === "removed" &&
    (!data.switchedAt || Date.now() - Date.parse(data.switchedAt) < 300000)
  )
    throw new Error("Old signers must stop for300s before removal");
  const base = `https://run.googleapis.com/v2/projects/${project}/locations/${region}`;
  const gatewayName = `${prefix}-gateway`;
  let gateway;
  try {
    gateway = await api(`${base}/services/${gatewayName}`);
  } catch {
    gateway = null;
  }
  if (gateway && gateway.labels?.managed_by !== "embody-m05-gateway-fixture")
    throw new Error("Gateway ownership mismatch");
  const gatewayBody = {
    labels: { managed_by: "embody-m05-gateway-fixture", fixture: prefix },
    ingress: "INGRESS_TRAFFIC_ALL",
    invokerIamDisabled: false,
    template: {
      executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
      vpcAccess: {
        egress: "ALL_TRAFFIC",
        networkInterfaces: [{ network: `${prefix}-network`, subnetwork: `${prefix}-subnet` }],
      },
      serviceAccount: gatewayEmail,
      scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
      maxInstanceRequestConcurrency: 4,
      timeout: "120s",
      volumes: [{ name: "cloudsql", cloudSqlInstance: { instances: [connection] } }],
      containers: [
        {
          image,
          volumeMounts: [{ name: "cloudsql", mountPath: "/cloudsql" }],
          resources: { limits: { cpu: "1", memory: "512Mi" }, cpuIdle: true },
          ports: [{ containerPort: 8080 }],
          env: env(phase),
        },
      ],
    },
    traffic: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 }],
  };
  const operation = await api(
    gateway
      ? `${base}/services/${gatewayName}?updateMask=template,traffic`
      : `${base}/services?serviceId=${gatewayName}`,
    gateway ? "PATCH" : "POST",
    { ...gatewayBody, ...(gateway ? { name: gateway.name, etag: gateway.etag } : {}) },
  );
  let result = operation;
  for (let attempt = 0; !result.done && attempt < 120; attempt++) {
    await delay(1000);
    result = await api(`https://run.googleapis.com/v2/${result.name}`);
  }
  if (!result.done || result.error) throw new Error("Gateway deployment failed");
  gateway = await api(`${base}/services/${gatewayName}`);
  // Gateway exposes only JWKS and credential-protected management/call surfaces publicly.
  const gwPolicy = await api(`${base}/services/${gatewayName}:getIamPolicy`);
  if (
    (gwPolicy.bindings ?? []).some(
      (binding) =>
        binding.role !== "roles/run.invoker" ||
        binding.members.some((member) => member !== "allUsers"),
    )
  )
    throw new Error("Unexpected gateway invoker policy");
  await api(`${base}/services/${gatewayName}:setIamPolicy`, "POST", {
    policy: {
      ...(gwPolicy.etag ? { etag: gwPolicy.etag } : {}),
      bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }],
    },
  });
  data.gateway = gateway.uri;
  data.phase = phase;
  if (phase === "publish") data.publishAt = new Date().toISOString();
  if (phase === "overlap") data.switchedAt = new Date().toISOString();
  if (phase === "removed") data.removedAt = new Date().toISOString();
  data.image = image;
  data.candidateSha = candidateSha;
  const provisioner = createCloudRunAppProvisioner({
    project,
    region,
    prefix,
    gatewayEmail,
    accessToken: () => Promise.resolve(token),
  });
  if (phase === "initial") {
    for (let i = 0; i < data.apps.length; i++) {
      const app = data.apps[i];
      const output = await provisioner.deploy(app, {
        image,
        issuer,
        jwksUrl: `${gateway.uri}/.well-known/jwks.json`,
        secretVersion: data.secretVersions[i === 0 ? "runtime" : "other"].split("/").at(-1),
        sqlConnection: connection,
      });
      app.origin = output.origin;
    }
    const platformDsn = data.dsns.platform.replace(":5432/", ":15432/");
    const store = new PostgresGatewayStore(platformDsn);
    try {
      for (let i = 0; i < data.apps.length; i++) {
        const app = data.apps[i];
        if (!(await store.snapshot(app.workspaceId))) await store.createWorkspace(app.workspaceId);
        const storage = new PostgresStorage(
          {
            connectionString: data.dsns[i === 0 ? "runtime" : "other"].replace(":5432/", ":15432/"),
          },
          { schemaMode: "verify" },
        );
        const kernel = new Kernel({ plugins: fixtureApp(app.appId).plugins, storage });
        await kernel.boot();
        try {
          const old = (await store.snapshot(app.workspaceId)).apps[0];
          await store.putApp(
            {
              workspaceId: app.workspaceId,
              appId: i === 0 ? "app_kanban0001" : "app_email0001",
              activeRelease: "rel_m05fixture01",
              state: "ready",
              registration: {
                protocolVersion: 1,
                appId: app.appId,
                version: "1.0.0",
                endpoint: app.origin,
                healthCheckUrl: `${app.origin}/health`,
                manifest: kernel.manifest,
              },
            },
            old?.revision ?? null,
          );
        } finally {
          await kernel.stop(); // Kernel owns storage cleanup.
        }
      }
    } finally {
      await store.close();
    }
  }
  const config = {
    project,
    prefix,
    candidateSha,
    region,
    runtime: data.apps[0].runtimeEmail,
    otherRuntime: data.apps[1].runtimeEmail,
    gateway: gatewayEmail,
    builder: `${prefix}-builder@${project}.iam.gserviceaccount.com`,
    deployer: `${prefix}-deployer@${project}.iam.gserviceaccount.com`,
    migrator: data.apps[0].migratorEmail,
    ownService: data.apps[0].service,
    otherService: data.apps[1].service,
    gatewayService: gatewayName,
    artifactRepository: `${prefix}-images`,
    appOrigin: data.apps[0].origin,
    otherAppOrigin: data.apps[1].origin,
    appAudience: "kanban",
    otherAppAudience: "email",
    workspaceId: data.apps[0].workspaceId,
    ownDatabaseSecret: data.apps[0].databaseSecret,
    otherAppSecret: data.apps[1].databaseSecret,
    platformDatabaseSecret: `${prefix}-platform-db`,
    signingSecret: `${prefix}-signer`,
    databaseRole: "embody_test_runtime",
    ownDatabase: "embody_test_app",
    platformDatabase: "embody_test_platform_db",
    otherDatabase: "embody_test_other_db",
  };
  data.config = config;
  await savePrivate(data);
  console.log(
    JSON.stringify({
      fixtureDeployment: "passed",
      phase,
      image,
      candidateSha,
      gatewayRevision: gateway.latestReadyRevision,
      gatewayOrigin: gateway.uri,
      appOrigins: data.apps.map((app) => app.origin),
      issuer,
    }),
  );
}
main().catch(() => {
  console.error("M05 deploy failed; private diagnostics suppressed");
  process.exitCode = 1;
});
