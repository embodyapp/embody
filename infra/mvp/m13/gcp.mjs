// Real GCP provider for the M13 live suite, composed on the M12 provider (M11 build resources,
// Cloud SQL platform database, controller queue, worker and invoker identities). M13 adds, all
// run-scoped and owned: a gateway identity and its public Cloud Run gateway (signing key secret),
// the database provisioner role and its secret, the worker's M13 grants (a project-wide Cloud Run
// service-management role and a prefix-conditioned Secret Manager role) and the M13 worker. App
// identities are provisioned by the operator (`provisionApp`), which grants the worker resource-
// level `actAs` on runtimes and token creation on invokers. Accepted residual (re-review B4): the
// project-wide Cloud Run role reaches every service, including the gateway, so a compromised
// worker could replace the gateway at its deterministic URL; see RELEASES "Residual risks".
// Everything carries this run's prefixes and is removed on teardown. Tokens, passwords and URLs
// with credentials are never printed.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { deadlineFetch, operatorToken } from "../m09/gcp.mjs";
import { createM12GcpProvider, m12Names } from "../m12/gcp.mjs";

const { AbortSignal, Buffer, URL, fetch } = globalThis;
const exec = promisify(execFile);
const REGION = "us-central1";
const IAM = "https://iam.googleapis.com/v1";
const RUN = "https://run.googleapis.com/v2";
const SECRETS = "https://secretmanager.googleapis.com/v1";
const CRM = "https://cloudresourcemanager.googleapis.com/v1";
/**
 * Controller permissions M13 adds (RELEASES identity table), as run-scoped custom roles.
 * `base` (Cloud Run service management and identity lookup) is project-wide: live runs 3–4 showed
 * Cloud Run and service-account IAM ignore resource-name conditions. It is NOT confined to
 * candidates: delete + create of a same-named service, or `setIamPolicy` granting itself
 * `run.admin`, reaches platform services including the gateway (re-review B4, accepted until
 * candidates move to a separate project). `secrets` is prefix-conditioned (Secret Manager honours
 * it). The worker creates no identities, queues or secrets and holds no IAM-admin role.
 */
export const M13_WORKER_ROLES = Object.freeze({
  base: [
    "run.services.create",
    "run.services.list",
    "run.services.get",
    "run.services.delete",
    "run.services.getIamPolicy",
    "run.services.setIamPolicy",
    "run.operations.get",
    "iam.serviceAccounts.get",
  ],
  secrets: [
    "secretmanager.secrets.get",
    "secretmanager.versions.add",
    "secretmanager.versions.get",
  ],
});
/** The condition each conditioned role group is bound with, from the run's names. */
export function m13Conditions(project, projectNumber, n) {
  // Secret Manager names resources by project number; accept the ID form as well.
  const either = (path) =>
    `resource.name.startsWith("projects/${project}/${path}") || resource.name.startsWith("projects/${projectNumber}/${path}")`;
  return { secrets: either(`secrets/${n.platformPrefix}-a`) };
}
const ONLY_SQL_CLIENT =
  "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(['roles/cloudsql.client'])";

export function m13Names(project, prefix, runId) {
  const account = (id) => ({ id, email: `${id}@${project}.iam.gserviceaccount.com` });
  return {
    ...m12Names(project, prefix, runId),
    gatewayAccount: account(`${prefix}-g-${runId}`),
    gatewayService: `${prefix}-gw-${runId}`,
    gatewayKey: `${prefix}-gwkey-${runId}`,
    provisionerSecret: `${prefix}-prov-${runId}`,
    /** The release stages' platform prefix: names every candidate, runtime and secret they make. */
    platformPrefix: `t${runId}`,
    role: `embodyTestM13_${runId}`,
  };
}

export function createM13GcpProvider({
  project,
  gateway,
  credentials = "gcloud",
  token = () => operatorToken(credentials),
  fetcher: baseFetch = fetch,
}) {
  const m12 = createM12GcpProvider({ project, gateway, credentials, token, fetcher: baseFetch });
  const fetcher = deadlineFetch(baseFetch);
  let cached;
  const accessToken = async () => {
    if (!cached || cached.until < Date.now())
      cached = { value: await token(), until: Date.now() + 3 * 60_000 };
    return cached.value;
  };
  async function api(url, method = "GET", body) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetcher(url, {
          method,
          redirect: "error",
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        if (["GET", "DELETE"].includes(method) && attempt < 6) {
          await delay(10_000);
          continue;
        }
        throw new Error(`Provider ${method} ${new URL(url).host} failed (0); details suppressed`);
      }
      if (response.status === 401 && attempt === 0) {
        cached = undefined;
        continue;
      }
      if (response.status >= 500 && ["GET", "DELETE"].includes(method) && attempt < 6) {
        await delay(10_000);
        continue;
      }
      if (response.status === 404 && ["GET", "DELETE"].includes(method)) return null;
      if (!response.ok)
        throw new Error(
          `Provider ${method} ${new URL(url).host} failed (${response.status}); body suppressed`,
        );
      return response.status === 204 ? {} : response.json().catch(() => ({}));
    }
  }
  async function eventually(fn, attempts = 12) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= attempts || !/failed \((400|403|404|409)\)/.test(error.message)) throw error;
        await delay(10_000);
      }
    }
  }
  async function waitOperation(op, maxPolls = 120) {
    for (let i = 0; op && !op.done && i < maxPolls; i++) {
      await delay(5000);
      op = await api(`${RUN}/${op.name}`);
    }
    if (op?.error) throw new Error(`Provider operation failed (${op.error.code ?? "error"})`);
    return op;
  }
  const sa = (email) => `serviceAccount:${email}`;
  async function projectPolicy(edit) {
    await eventually(async () => {
      const policy = await api(`${CRM}/projects/${project}:getIamPolicy`, "POST", {
        options: { requestedPolicyVersion: 3 },
      });
      edit(policy);
      policy.version = 3;
      await api(`${CRM}/projects/${project}:setIamPolicy`, "POST", { policy });
    });
  }
  async function bind(resource, role, member, { post = true } = {}) {
    await eventually(async () => {
      const policy =
        (await api(`${resource}:getIamPolicy`, post ? "POST" : "GET", post ? {} : undefined)) ?? {};
      policy.bindings = [...(policy.bindings ?? []), { role, members: [member] }];
      await api(`${resource}:setIamPolicy`, "POST", { policy });
    });
  }
  async function secret(id, value, runId) {
    await api(`${SECRETS}/projects/${project}/secrets?secretId=${id}`, "POST", {
      replication: { automatic: {} },
      labels: { embody: "m13-qualification", run: runId },
    });
    if (value !== undefined)
      await api(`${SECRETS}/projects/${project}/secrets/${id}:addVersion`, "POST", {
        payload: { data: Buffer.from(value).toString("base64") },
      });
  }
  async function deployService(name, spec) {
    const created = await eventually(() =>
      api(
        `${RUN}/projects/${project}/locations/${REGION}/services?serviceId=${name}`,
        "POST",
        spec,
      ),
    );
    await waitOperation(created);
  }
  const url = (service, projectNumber) => `https://${service}-${projectNumber}.${REGION}.run.app`;
  const listServices = async () =>
    (await api(`${RUN}/projects/${project}/locations/${REGION}/services?pageSize=200`))?.services ??
    [];
  let provisioner;

  return {
    ...m12,
    async setUp(approval, runId) {
      const context = await m12.setUp(approval, runId);
      const n = m13Names(project, approval.prefix, runId);
      await api(`${IAM}/projects/${project}/serviceAccounts`, "POST", {
        accountId: n.gatewayAccount.id,
        serviceAccount: { displayName: "Embody M13 qualification gateway (disposable)" },
      });
      for (const [group, permissions] of Object.entries(M13_WORKER_ROLES))
        await api(`${IAM}/projects/${project}/roles`, "POST", {
          roleId: `${n.role}_${group}`,
          role: {
            title: `Embody M13 qualification controller ${group} (disposable)`,
            includedPermissions: permissions,
            stage: "GA",
          },
        });
      const worker = sa(context.worker.email);
      const conditions = m13Conditions(project, context.projectNumber, n);
      await projectPolicy((policy) => {
        policy.bindings = [
          ...(policy.bindings ?? []),
          { role: `projects/${project}/roles/${n.role}_base`, members: [worker] },
          {
            role: `projects/${project}/roles/${n.role}_secrets`,
            members: [worker],
            condition: { title: "m13 app secrets only", expression: conditions.secrets },
          },
          { role: "roles/cloudsql.client", members: [sa(n.gatewayAccount.email)] },
        ];
      });
      await secret(n.gatewayKey, undefined, runId);
      await secret(n.provisionerSecret, undefined, runId);
      const gatewayMember = sa(n.gatewayAccount.email);
      await bind(
        `${SECRETS}/projects/${project}/secrets/${context.secret}`,
        "roles/secretmanager.secretAccessor",
        gatewayMember,
        { post: false },
      );
      await bind(
        `${SECRETS}/projects/${project}/secrets/${n.gatewayKey}`,
        "roles/secretmanager.secretAccessor",
        gatewayMember,
        { post: false },
      );
      await bind(
        `${SECRETS}/projects/${project}/secrets/${n.provisionerSecret}`,
        "roles/secretmanager.secretAccessor",
        worker,
        { post: false },
      );
      await bind(
        `https://cloudtasks.googleapis.com/v2/${context.queuePath}`,
        "roles/cloudtasks.enqueuer",
        gatewayMember,
      );
      await bind(
        `${IAM}/projects/-/serviceAccounts/${context.invoker.email}`,
        "roles/iam.serviceAccountUser",
        gatewayMember,
      );
      return { ...context, ...n };
    },
    /** The M12 database plus the provisioner role (CREATEDB, CREATEROLE only) and its secret. */
    async prepareDatabase(context, approval) {
      const db = await m12.prepareDatabase(context, approval);
      const port = new URL(db.runtimeUrl).port;
      const { Client } = createRequire(
        new URL("../../../packages/gateway/package.json", import.meta.url),
      )("pg");
      const password = randomBytes(24).toString("base64url");
      const admin = new Client({
        connectionString: `postgresql://postgres:${encodeURIComponent(context.adminPassword)}@127.0.0.1:${port}/postgres`,
      });
      admin.on("error", () => undefined);
      await admin.connect();
      try {
        await admin.query(
          `CREATE ROLE embody_provisioner LOGIN PASSWORD '${password}' NOSUPERUSER CREATEDB CREATEROLE NOINHERIT NOBYPASSRLS`,
        );
      } finally {
        await admin.end();
      }
      await api(
        `${SECRETS}/projects/${project}/secrets/${context.provisionerSecret}:addVersion`,
        "POST",
        {
          payload: {
            data: Buffer.from(
              `postgresql://embody_provisioner:${password}@localhost/postgres`,
            ).toString("base64"),
          },
        },
      );
      const local = `postgresql://embody_provisioner:${password}@127.0.0.1:${port}/postgres`;
      const lib = await import("../../../packages/gateway/dist/index.js");
      const { STORAGE_MIGRATIONS, STORAGE_RUNTIME_FUNCTIONS } =
        await import("../../../packages/storage/dist/index.js");
      const migrations = STORAGE_MIGRATIONS.map((m) => ({
        version: m.version,
        compatibility: m.compatibility,
        postgres: m.postgres,
      }));
      provisioner = (extra = []) =>
        new lib.PostgresAppDatabase({
          provisionerUrl: local,
          runtimeHost: `127.0.0.1:${port}`,
          migrations: [...migrations, ...extra],
          runtimeFunctions: STORAGE_RUNTIME_FUNCTIONS,
        });
      const names = (workspaceId, appId) =>
        lib.appResourceNames(context.platformPrefix, workspaceId, appId);
      return {
        ...db,
        appChecksum: (_context, workspaceId, appId) =>
          provisioner().checksum(names(workspaceId, appId)),
        /** A contract migration on the live app database: refused before anything executes. */
        async destructiveProbe(_context, workspaceId, appId) {
          const app = names(workspaceId, appId);
          const ledgerBefore = await provisioner().appliedMigrations(app);
          const checksumBefore = await provisioner().checksum(app);
          let refused;
          try {
            await provisioner([
              { version: 7, compatibility: "contract", postgres: "DELETE FROM embody_entities" },
            ]).applyNextMigration(app, 7);
          } catch (error) {
            refused = error?.reason;
          }
          return {
            refused,
            ledgerBefore,
            ledgerAfter: await provisioner().appliedMigrations(app),
            checksumBefore,
            checksumAfter: await provisioner().checksum(app),
          };
        },
      };
    },
    /** The public hosted gateway: its own identity, the platform database, the signing key. */
    async deployGateway(context, { image, signing }) {
      await api(`${SECRETS}/projects/${project}/secrets/${context.gatewayKey}:addVersion`, "POST", {
        payload: { data: Buffer.from(signing.privateKeyPem).toString("base64") },
      });
      const gatewayUrl = url(context.gatewayService, context.projectNumber);
      const workerUrl = url(context.service, context.projectNumber);
      const env = {
        GATEWAY_PROFILE: "hosted",
        GATEWAY_SERVICE_ACCOUNT_EMAIL: context.gatewayAccount.email,
        GATEWAY_JWT_ISSUER: gatewayUrl,
        GATEWAY_JWT_KID: signing.kid,
        GATEWAY_JWT_PUBLIC_JWKS: JSON.stringify(signing.publicJwks),
        EMBODY_SQL_CONNECTION: context.connection,
        EMBODY_M12_QUEUE: context.queuePath,
        EMBODY_M12_TASK_URL: `${workerUrl}/_embody/tasks/deployment`,
        EMBODY_M12_INVOKER: context.invoker.email,
      };
      await deployService(context.gatewayService, {
        labels: { embody: "m13-qualification" },
        ingress: "INGRESS_TRAFFIC_ALL",
        template: {
          serviceAccount: context.gatewayAccount.email,
          timeout: "60s",
          scaling: { minInstanceCount: 0, maxInstanceCount: 2 },
          volumes: [{ name: "cloudsql", cloudSqlInstance: { instances: [context.connection] } }],
          containers: [
            {
              image,
              command: ["node"],
              args: ["infra/mvp/m13/gateway.mjs"],
              env: [
                ...Object.entries(env).map(([name, value]) => ({ name, value })),
                {
                  name: "GATEWAY_PLATFORM_DATABASE_URL",
                  valueSource: { secretKeyRef: { secret: context.secret, version: "latest" } },
                },
                {
                  name: "GATEWAY_JWT_PRIVATE_KEY",
                  valueSource: { secretKeyRef: { secret: context.gatewayKey, version: "latest" } },
                },
              ],
              resources: { limits: { cpu: "1", memory: "512Mi" }, cpuIdle: true },
              volumeMounts: [{ name: "cloudsql", mountPath: "/cloudsql" }],
            },
          ],
        },
      });
      // The gateway is the public front door (workspace credentials authenticate every request).
      await bind(
        `${RUN}/projects/${project}/locations/${REGION}/services/${context.gatewayService}`,
        "roles/run.invoker",
        "allUsers",
        { post: false },
      );
      return {
        url: gatewayUrl,
        jwksUrl: `${gatewayUrl}/.well-known/jwks.json`,
        issuer: gatewayUrl,
      };
    },
    /** The deployment worker with the real M13 release stages. */
    async deployM13Worker(context, { image, recipe, gateway: front }) {
      const workerUrl = url(context.service, context.projectNumber);
      const platform = {
        prefix: context.platformPrefix,
        gatewayServiceAccount: context.gatewayAccount.email,
        controllerServiceAccount: context.worker.email,
        jwtIssuer: front.issuer,
        jwksUrl: front.jwksUrl,
        projectNumber: String(context.projectNumber),
        region: REGION,
        // Durable apps' wake tasks go to the worker's stable per-app wake route (review B1).
        wakeBaseUrl: workerUrl,
      };
      const env = {
        EMBODY_M12_RECIPE: JSON.stringify(recipe),
        EMBODY_M12_SOURCE_BUCKET: context.sourceBucket,
        EMBODY_M12_READ_SIGNER: context.reader.email,
        EMBODY_M12_QUEUE: context.queuePath,
        EMBODY_M12_TASK_URL: `${workerUrl}/_embody/tasks/deployment`,
        EMBODY_M12_INVOKER: context.invoker.email,
        EMBODY_SQL_CONNECTION: context.connection,
        EMBODY_M13_PLATFORM: JSON.stringify(platform),
        EMBODY_M13_PROJECT_NUMBER: String(context.projectNumber),
        EMBODY_M13_SQL_INSTANCE: context.sql,
        EMBODY_M13_WAKE_SERVICE: context.service,
      };
      await deployService(context.service, {
        labels: { embody: "m13-qualification" },
        ingress: "INGRESS_TRAFFIC_ALL",
        template: {
          serviceAccount: context.worker.email,
          timeout: "60s",
          maxInstanceRequestConcurrency: 4,
          scaling: { minInstanceCount: 0, maxInstanceCount: 2 },
          volumes: [{ name: "cloudsql", cloudSqlInstance: { instances: [context.connection] } }],
          containers: [
            {
              image,
              command: ["node"],
              args: ["infra/mvp/m13/worker.mjs"],
              env: [
                ...Object.entries(env).map(([name, value]) => ({ name, value })),
                {
                  name: "EMBODY_PLATFORM_URL",
                  valueSource: { secretKeyRef: { secret: context.secret, version: "latest" } },
                },
                {
                  name: "EMBODY_PROVISIONER_URL",
                  valueSource: {
                    secretKeyRef: { secret: context.provisionerSecret, version: "latest" },
                  },
                },
              ],
              resources: { limits: { cpu: "1", memory: "512Mi" }, cpuIdle: true },
              volumeMounts: [{ name: "cloudsql", mountPath: "/cloudsql" }],
            },
          ],
        },
      });
      await bind(
        `${RUN}/projects/${project}/locations/${REGION}/services/${context.service}`,
        "roles/run.invoker",
        sa(context.invoker.email),
        { post: false },
      );
      return { url: workerUrl };
    },
    /**
     * App provisioning at reservation, as the operator (the trusted identity admin): runtime and
     * invoker identities, Cloud SQL client, database secret, wake queue and route, and the
     * worker's resource-level grants on exactly those identities.
     */
    async provisionApp(context, workspaceId, appId, durable) {
      const lib = await import("../../../packages/gateway/dist/index.js");
      const admin = new lib.GoogleReleaseProvider({
        project,
        region: REGION,
        projectNumber: String(context.projectNumber),
        prefix: context.platformPrefix,
        sqlInstance: context.sql,
        wakeService: context.service,
        accessToken,
      });
      for (let attempt = 0; attempt < 24; attempt++) {
        let outcome;
        try {
          outcome = await lib.provisionAppIdentity(
            admin,
            lib.appResourceNames(context.platformPrefix, workspaceId, appId),
            {
              workspaceId,
              appId,
              durable,
              controllerEmail: context.worker.email,
              signal: AbortSignal.timeout(60_000),
            },
          );
        } catch (error) {
          // Rate limits and concurrent policy edits are retried; anything else fails setup.
          if (!/returned (429|409)/.test(String(error?.message))) throw error;
          outcome = "pending";
        }
        if (outcome === "ready") return;
        await delay(10_000);
      }
      throw new Error("App provisioning did not complete");
    },
    /** Grants as `who|where:role` facts (conditions summarised) for the IAM evaluator. */
    async releaseBindings(context) {
      const out = [];
      const runtimeMember = (member) =>
        member.startsWith(`serviceAccount:${context.platformPrefix}-a`);
      const policy = await api(`${CRM}/projects/${project}:getIamPolicy`, "POST", {
        options: { requestedPolicyVersion: 3 },
      });
      for (const binding of policy?.bindings ?? [])
        for (const member of binding.members) {
          const role = binding.role.startsWith(`projects/${project}/roles/${context.role}_`)
            ? `custom/${binding.role.slice(`projects/${project}/roles/${context.role}_`.length)}${binding.condition ? "?prefixed" : ""}`
            : binding.condition?.expression === ONLY_SQL_CLIENT
              ? `${binding.role}?onlyGrants=roles/cloudsql.client`
              : binding.condition?.expression?.includes(`${context.platformPrefix}-a`)
                ? `${binding.role}?runtimesOnly`
                : binding.role;
          if (member === sa(context.worker.email)) out.push(`worker|project:${role}`);
          if (member === sa(context.gatewayAccount.email)) out.push(`gateway|project:${role}`);
          if (runtimeMember(member)) out.push(`runtime|project:${role}`);
        }
      const accounts =
        (await api(`${IAM}/projects/${project}/serviceAccounts?pageSize=100`))?.accounts ?? [];
      for (const account of accounts) {
        const kind = account.email.startsWith(`${context.platformPrefix}-a`)
          ? "runtimeSa"
          : account.email.startsWith(`${context.platformPrefix}-w`)
            ? "invokerSa"
            : null;
        if (!kind) continue;
        const iam = await api(
          `${IAM}/projects/-/serviceAccounts/${account.email}:getIamPolicy`,
          "POST",
          {},
        );
        for (const binding of iam?.bindings ?? [])
          for (const member of binding.members)
            if (member === sa(context.worker.email)) out.push(`worker|${kind}:${binding.role}`);
      }
      const secrets =
        (await api(`${SECRETS}/projects/${project}/secrets?pageSize=200`))?.secrets ?? [];
      for (const item of secrets) {
        const id = item.name.split("/").pop();
        if (!id.startsWith(`${context.platformPrefix}-a`)) continue;
        const iam = await api(`${SECRETS}/${item.name}:getIamPolicy`);
        for (const binding of iam?.bindings ?? [])
          for (const member of binding.members)
            out.push(
              runtimeMember(member)
                ? `runtime|secret:${binding.role}`
                : `other|secret:${binding.role}`,
            );
      }
      for (const service of await listServices()) {
        if (service.labels?.["embody-platform"] !== context.platformPrefix) continue;
        const iam = await api(`${RUN}/${service.name}:getIamPolicy`);
        for (const binding of iam?.bindings ?? [])
          for (const member of binding.members)
            out.push(
              member === sa(context.gatewayAccount.email)
                ? `candidate|run.invoker:gateway`
                : member === sa(context.worker.email)
                  ? `candidate|run.invoker:worker`
                  : member.startsWith(`serviceAccount:${context.platformPrefix}-w`)
                    ? `candidate|run.invoker:wake-invoker`
                    : `candidate|${binding.role}:other`,
            );
      }
      return out.sort();
    },
    async candidates(context, workspaceId) {
      return (await listServices())
        .filter(
          (service) =>
            service.labels?.["embody-platform"] === context.platformPrefix &&
            service.annotations?.["embody.dev/workspace"] === workspaceId,
        )
        .map((service) => {
          const name = service.name.split("/").pop();
          return { name, endpoint: url(name, context.projectNumber) };
        });
    },
    /** The operator reconcile (recovery and the candidate sweep) with the invoker's token. */
    async reconcile(context) {
      const workerUrl = url(context.service, context.projectNumber);
      const minted = await eventually(() =>
        api(
          `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${context.invoker.email}:generateIdToken`,
          "POST",
          {
            audience: `${workerUrl}/_embody/tasks/deployment`,
            includeEmail: true,
          },
        ),
      );
      const response = await fetch(`${workerUrl}/_embody/tasks/reconcile`, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${minted.token}` },
        signal: AbortSignal.timeout(60_000),
      });
      return response.status;
    },
    async tearDown(approval, runId, context) {
      const n = m13Names(project, approval.prefix, runId);
      const removed = [];
      // Candidates and the gateway first (they hold identities), then project grants, then identities.
      for (const service of await listServices()) {
        const id = service.name.split("/").pop();
        if (service.labels?.["embody-platform"] === n.platformPrefix || id === n.gatewayService) {
          await waitOperation(await api(`${RUN}/${service.name}`, "DELETE"), 60);
          removed.push(`service:${id}`);
        }
      }
      const ours = (member) =>
        [sa(n.gatewayAccount.email), `deleted:${sa(n.gatewayAccount.email)}`].includes(member) ||
        member.startsWith(`serviceAccount:${n.platformPrefix}-`) ||
        member.startsWith(`deleted:serviceAccount:${n.platformPrefix}-`);
      const worker = m12Names(project, approval.prefix, runId).worker.email;
      await projectPolicy((policy) => {
        policy.bindings = (policy.bindings ?? [])
          .filter((binding) => !binding.role.startsWith(`projects/${project}/roles/${n.role}_`))
          .filter(
            (binding) =>
              !(binding.condition && binding.members.some((member) => member.endsWith(worker))),
          )
          .map((binding) => ({
            ...binding,
            members: binding.members.filter((member) => !ours(member)),
          }))
          .filter((binding) => binding.members.length);
      });
      const accounts =
        (await api(`${IAM}/projects/${project}/serviceAccounts?pageSize=100`))?.accounts ?? [];
      for (const account of accounts)
        if (
          account.email.startsWith(`${n.platformPrefix}-`) ||
          account.email === n.gatewayAccount.email
        ) {
          await api(`${IAM}/projects/${project}/serviceAccounts/${account.email}`, "DELETE");
          removed.push(`serviceAccount:${account.email.split("@")[0]}`);
        }
      const secrets =
        (await api(`${SECRETS}/projects/${project}/secrets?pageSize=200`))?.secrets ?? [];
      for (const item of secrets) {
        const id = item.name.split("/").pop();
        if (
          id.startsWith(`${n.platformPrefix}-`) ||
          id === n.gatewayKey ||
          id === n.provisionerSecret
        ) {
          await api(`${SECRETS}/${item.name}`, "DELETE");
          removed.push(`secret:${id}`);
        }
      }
      const queues =
        (
          await api(
            `https://cloudtasks.googleapis.com/v2/projects/${project}/locations/${REGION}/queues`,
          )
        )?.queues ?? [];
      for (const item of queues)
        if (item.name.split("/").pop().startsWith(`${n.platformPrefix}-`)) {
          await api(`https://cloudtasks.googleapis.com/v2/${item.name}`, "DELETE");
          removed.push(`queue:${item.name.split("/").pop()}`);
        }
      for (const group of Object.keys(M13_WORKER_ROLES)) {
        const id = `${n.role}_${group}`;
        const role = await api(`${IAM}/projects/${project}/roles/${id}`);
        if (role && !role.deleted) {
          await api(`${IAM}/projects/${project}/roles/${id}`, "DELETE");
          removed.push(`role:${id}`);
        }
      }
      const m12Teardown = await m12.tearDown(approval, runId, context);
      return { pass: m12Teardown.pass === true, removed: [...removed, ...m12Teardown.removed] };
    },
    async inventory(approval, runId) {
      const n = m13Names(project, approval.prefix, runId);
      const leftovers = [...(await m12.inventory(approval, runId))];
      for (const service of await listServices()) {
        const id = service.name.split("/").pop();
        if (service.labels?.["embody-platform"] === n.platformPrefix || id === n.gatewayService)
          leftovers.push(`service:${id}`);
      }
      const accounts =
        (await api(`${IAM}/projects/${project}/serviceAccounts?pageSize=100`))?.accounts ?? [];
      for (const account of accounts)
        if (
          account.email.startsWith(`${n.platformPrefix}-`) ||
          account.email === n.gatewayAccount.email
        )
          leftovers.push(`serviceAccount:${account.email.split("@")[0]}`);
      const secrets =
        (await api(`${SECRETS}/projects/${project}/secrets?pageSize=200`))?.secrets ?? [];
      for (const item of secrets) {
        const id = item.name.split("/").pop();
        if (
          id.startsWith(`${n.platformPrefix}-`) ||
          id === n.gatewayKey ||
          id === n.provisionerSecret
        )
          leftovers.push(`secret:${id}`);
      }
      for (const group of Object.keys(M13_WORKER_ROLES)) {
        const role = await api(`${IAM}/projects/${project}/roles/${n.role}_${group}`);
        if (role && !role.deleted) leftovers.push(`role:${n.role}_${group}`);
      }
      const policy = await api(`${CRM}/projects/${project}:getIamPolicy`, "POST", {
        options: { requestedPolicyVersion: 3 },
      });
      for (const binding of policy?.bindings ?? [])
        for (const member of binding.members)
          if (member.includes(`${n.platformPrefix}-`) || member.includes(n.gatewayAccount.id))
            leftovers.push(`projectBinding:${binding.role}`);
      return leftovers;
    },
  };
}
void exec;
