// App resource primitives shared by qualification and the future durable controller.
// NOT a deployment controller: no build/migrations/promotion or job authorization here.
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers";
import { URL } from "node:url";
const { fetch, AbortSignal } = globalThis;
class ProviderError extends Error {
  constructor(method, status, accountPropagation = false) {
    super(`Provider ${method} failed (${status}); details suppressed`);
    this.accountPropagation = accountPropagation;
  }
}
export function appResourceNames({ project, prefix, workspaceId, appId }) {
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project ?? "") ||
    !/^embody-test-[a-z0-9-]+$/.test(prefix ?? "") ||
    prefix.length > 15 ||
    !/^ws_[a-z0-9]{8,64}$/.test(workspaceId ?? "") ||
    !/^[a-z][a-z0-9_-]{1,62}$/.test(appId ?? "")
  )
    throw new Error("Invalid dedicated app resource scope");
  const hash = createHash("sha256").update(`${workspaceId}/${appId}`).digest("hex").slice(0, 12);
  return {
    runtime: `${prefix}-r-${hash}`,
    migrator: `${prefix}-m-${hash}`,
    service: `${prefix}-app-${hash}`,
    databaseSecret: `${prefix}-db-${hash}`,
    migrationSecret: `${prefix}-mig-${hash}`,
  };
}
export function createCloudRunAppProvisioner({
  project,
  region,
  prefix,
  gatewayEmail,
  accessToken,
  fetcher = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (
    !/^[a-z]+-[a-z]+[0-9]$/.test(region ?? "") ||
    gatewayEmail !== `${prefix}-gateway@${project}.iam.gserviceaccount.com` ||
    typeof accessToken !== "function"
  )
    throw new Error("Invalid provider authority");
  const marker = "embody-m05-app-adapter";
  async function request(url, method = "GET", body) {
    try {
      const response = await fetcher(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 404 && ["GET", "DELETE"].includes(method)) return null;
      if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        const accountPropagation =
          response.status === 400 &&
          /service account.*(does not exist|not found)/i.test(details.error?.message ?? "");
        throw new ProviderError(method, response.status, accountPropagation);
      }
      return response.status === 204 ? {} : await response.json();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(method, 0);
    }
  }
  async function bindSecret(url, body, method = "POST") {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await request(url, method, body);
      } catch (error) {
        if (!(error instanceof ProviderError) || !error.accountPropagation || attempt === 4)
          throw error;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }
  let projectNumber;
  async function operation(result) {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (result.done === true) {
        if (result.error) throw new Error("Provider operation failed; details suppressed");
        return result.response;
      }
      if (!projectNumber) {
        const info = await request(
          `https://cloudresourcemanager.googleapis.com/v3/projects/${project}`,
        );
        if (info?.projectId !== project || !/^projects\/\d+$/.test(info.name ?? ""))
          throw new Error("Project number identity mismatch");
        projectNumber = info.name.split("/")[1];
      }
      if (
        !/^projects\/[^/]+\/locations\/[^/]+\/operations\/[^/]+$/.test(result.name ?? "") ||
        ![project, projectNumber].some((value) =>
          result.name.startsWith(`projects/${value}/locations/${region}/operations/`),
        )
      )
        throw new Error("Unexpected operation scope");
      await sleep(1000);
      result = await request(`https://run.googleapis.com/v2/${result.name}`);
      if (!result) throw new Error("Provider operation disappeared");
    }
    throw new Error(
      "Provider operation deadline exceeded; reconcile by deterministic resource name",
    );
  }
  function context(scope) {
    const names = appResourceNames({ ...scope, project, prefix });
    const labels = {
      managed_by: marker,
      fixture: prefix,
      workspace: createHash("sha256").update(scope.workspaceId).digest("hex").slice(0, 32),
      app: scope.appId,
    };
    return { names, labels, description: JSON.stringify(labels) };
  }
  function owned(value, labels) {
    if (
      !value ||
      Object.entries(labels).some(([key, expected]) => value.labels?.[key] !== expected)
    )
      throw new Error("Resource ownership mismatch; refusing adoption/mutation");
  }
  async function prepare(scope) {
    const { names, labels, description } = context(scope);
    for (const id of [names.runtime, names.migrator]) {
      const url = `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${id}@${project}.iam.gserviceaccount.com`;
      let account = await request(url);
      if (!account)
        account = await request(
          `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`,
          "POST",
          { accountId: id, serviceAccount: { displayName: id, description } },
        );
      if (
        account.email !== `${id}@${project}.iam.gserviceaccount.com` ||
        account.description !== description
      )
        throw new Error("Identity ownership mismatch");
    }
    for (const [secret, identity] of [
      [names.databaseSecret, names.runtime],
      [names.migrationSecret, names.migrator],
    ]) {
      const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secret}`;
      let value = await request(url);
      if (!value)
        value = await request(
          `https://secretmanager.googleapis.com/v1/projects/${project}/secrets?secretId=${secret}`,
          "POST",
          { labels, replication: { userManaged: { replicas: [{ location: region }] } } },
        );
      owned(value, labels);
      const policy = await request(`${url}:getIamPolicy`);
      const member = `serviceAccount:${identity}@${project}.iam.gserviceaccount.com`;
      if (
        !policy ||
        (policy.bindings ?? []).some(
          (binding) =>
            binding.role !== "roles/secretmanager.secretAccessor" ||
            binding.condition ||
            !Array.isArray(binding.members) ||
            binding.members.some((value) => value !== member),
        )
      )
        throw new Error("Unexpected app secret policy; refusing overwrite");
      await bindSecret(`${url}:setIamPolicy`, {
        policy: {
          version: 1,
          ...(policy.etag ? { etag: policy.etag } : {}),
          bindings: [{ role: "roles/secretmanager.secretAccessor", members: [member] }],
        },
      });
    }
    return {
      ...names,
      runtimeEmail: `${names.runtime}@${project}.iam.gserviceaccount.com`,
      migratorEmail: `${names.migrator}@${project}.iam.gserviceaccount.com`,
    };
  }
  async function deploy(scope, { image, issuer, jwksUrl, secretVersion }) {
    const { names, labels } = context(scope);
    // Immutable digest only, confined to the Terraform-owned fixture repository.
    if (
      !new RegExp(
        `^${region}-docker\\.pkg\\.dev/${project}/${prefix}-images/[a-z0-9/-]+@sha256:[a-f0-9]{64}$`,
      ).test(image ?? "") ||
      typeof issuer !== "string" ||
      !issuer ||
      !/^https:\/\//.test(jwksUrl ?? "") ||
      !/^[1-9][0-9]*$/.test(secretVersion ?? "")
    )
      throw new Error("Invalid immutable candidate/public auth/secret version");
    const keyUrl = new URL(jwksUrl);
    if (
      keyUrl.username ||
      keyUrl.password ||
      keyUrl.search ||
      keyUrl.hash ||
      keyUrl.pathname !== "/.well-known/jwks.json" ||
      !keyUrl.hostname.startsWith(`${prefix}-gateway-`) ||
      !keyUrl.hostname.endsWith(".run.app")
    )
      throw new Error("JWKS must be the admitted gateway origin");
    const gateway = await request(
      `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${prefix}-gateway`,
    );
    const gatewayIssuer = gateway?.template?.containers?.[0]?.env?.find(
      (value) => value.name === "GATEWAY_JWT_ISSUER",
    )?.value;
    if (
      gateway?.uri !== keyUrl.origin ||
      gateway?.template?.serviceAccount !== gatewayEmail ||
      gatewayIssuer !== issuer
    )
      throw new Error("Gateway URI, issuer and identity must match the trusted project resource");
    const runtime = await request(
      `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${names.runtime}@${project}.iam.gserviceaccount.com`,
    );
    if (runtime?.description !== JSON.stringify(labels))
      throw new Error("Prepare owned identity first");
    const secret = await request(
      `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${names.databaseSecret}`,
    );
    owned(secret, labels);
    const version = await request(
      `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${names.databaseSecret}/versions/${secretVersion}`,
    );
    if (version?.state !== "ENABLED")
      throw new Error("Inject an enabled app-only DB secret version outside Terraform first");
    const url = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${names.service}`;
    const existing = await request(url);
    if (existing) {
      owned(existing, labels);
      const before = await request(`${url}:getIamPolicy`);
      const expectedMember = `serviceAccount:${gatewayEmail}`;
      if (
        !before ||
        (before.bindings ?? []).some(
          (binding) =>
            binding.role !== "roles/run.invoker" ||
            binding.condition ||
            !Array.isArray(binding.members) ||
            binding.members.some((value) => value !== expectedMember),
        )
      )
        throw new Error("Unexpected existing invocation policy; refusing deployment");
    }
    const body = {
      labels,
      ingress: "INGRESS_TRAFFIC_ALL",
      invokerIamDisabled: false,
      defaultUriDisabled: false,
      template: {
        serviceAccount: `${names.runtime}@${project}.iam.gserviceaccount.com`,
        scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
        maxInstanceRequestConcurrency: 4,
        timeout: "60s",
        containers: [
          {
            image,
            ports: [{ containerPort: 8080 }],
            resources: { limits: { cpu: "1", memory: "512Mi" }, cpuIdle: true },
            env: [
              { name: "NODE_ENV", value: "production" },
              { name: "EMBODY_HOST_PROFILE", value: "hosted" },
              { name: "EMBODY_WORKSPACE_ID", value: scope.workspaceId },
              { name: "GATEWAY_JWT_ISSUER", value: issuer },
              { name: "GATEWAY_JWKS_URL", value: jwksUrl },
              {
                name: "DATABASE_URL",
                valueSource: {
                  secretKeyRef: { secret: names.databaseSecret, version: secretVersion },
                },
              },
            ],
          },
        ],
      },
    };
    await operation(
      await bindSecret(
        existing
          ? `${url}?updateMask=labels,ingress,invokerIamDisabled,defaultUriDisabled,template`
          : `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services?serviceId=${names.service}`,
        { ...body, ...(existing ? { name: existing.name, etag: existing.etag } : {}) },
        existing ? "PATCH" : "POST",
      ),
    );
    const policy = await request(`${url}:getIamPolicy`);
    const member = `serviceAccount:${gatewayEmail}`;
    // Never silently erase another binding; fail closed and require investigation.
    if (
      !policy ||
      (policy.bindings ?? []).some(
        (binding) =>
          binding.role !== "roles/run.invoker" ||
          binding.condition ||
          !Array.isArray(binding.members) ||
          binding.members.some((value) => value !== member),
      )
    )
      throw new Error("Unexpected invocation policy; refuses public/unowned bindings");
    await request(`${url}:setIamPolicy`, "POST", {
      policy: {
        version: 1,
        ...(policy.etag ? { etag: policy.etag } : {}),
        bindings: [{ role: "roles/run.invoker", members: [member] }],
      },
    });
    const service = await request(url);
    owned(service, labels);
    if (
      !service.uri?.startsWith(`https://${names.service}-`) ||
      !new URL(service.uri).hostname.endsWith(".run.app")
    )
      throw new Error("Unexpected provider origin");
    return {
      service: names.service,
      origin: service.uri,
      image,
      runtime: `${names.runtime}@${project}.iam.gserviceaccount.com`,
    };
  }
  async function remove(scope) {
    const { names, labels, description } = context(scope);
    const serviceUrl = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${names.service}`;
    const service = await request(serviceUrl);
    // Validate ALL ownership before deleting any resource; later races need controller fencing.
    const secrets = await Promise.all(
      [names.databaseSecret, names.migrationSecret].map(async (name) => {
        const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}`;
        const value = await request(url);
        if (value) owned(value, labels);
        return { url, value };
      }),
    );
    const identities = await Promise.all(
      [names.runtime, names.migrator].map(async (name) => {
        const url = `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${name}@${project}.iam.gserviceaccount.com`;
        const value = await request(url);
        if (value && value.description !== description)
          throw new Error("Identity ownership mismatch; refusing deletion");
        return { url, value };
      }),
    );
    if (service) {
      owned(service, labels);
      const deletion = await request(
        `${serviceUrl}${service.etag ? `?etag=${encodeURIComponent(service.etag)}` : ""}`,
        "DELETE",
      );
      if (deletion) await operation(deletion);
    }
    for (const { url, value } of [...secrets, ...identities]) {
      if (value) await request(url, "DELETE");
    }
    return { ...names, removed: true };
  }
  return { prepare, deploy, remove };
}
