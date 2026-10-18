// Real GCP provider for the M10 live suite. Creates only owned, run-scoped resources: one private
// source bucket and one signer service account, with resource-level IAM (no project IAM change).
// A names-only run inventory is kept in the existing private state bucket so an interrupted run
// can be reconciled. Tokens, signed URLs and payloads are never printed or stored.
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { deadlineFetch, operatorToken } from "../m09/gcp.mjs";

const { AbortSignal, URL, fetch } = globalThis;

const exec = promisify(execFile);
const STORAGE = "https://storage.googleapis.com/storage/v1";
const IAM = "https://iam.googleapis.com/v1";

export function createM10GcpProvider({
  project,
  gateway,
  credentials = "gcloud",
  token = () => operatorToken(credentials),
  fetcher: baseFetch = fetch,
}) {
  const fetcher = deadlineFetch(baseFetch);
  const operations = { classA: 0, classB: 0 };
  const count = (method, url) => {
    if (!/storage\.googleapis\.com/.test(url)) return;
    if (method === "DELETE") return;
    if (method === "GET" || method === "HEAD") operations.classB += 1;
    else operations.classA += 1;
  };
  let cached;
  const accessToken = async () => {
    if (!cached || cached.until < Date.now())
      cached = { value: await token(), until: Date.now() + 3 * 60_000 };
    return cached.value;
  };
  async function api(
    url,
    method = "GET",
    body,
    { allow = [], contentType = "application/json" } = {},
  ) {
    for (let attempt = 0; ; attempt++) {
      count(method, url);
      let response;
      try {
        response = await fetcher(url, {
          method,
          redirect: "error",
          headers: { authorization: `Bearer ${await accessToken()}`, "content-type": contentType },
          ...(body === undefined
            ? {}
            : { body: typeof body === "string" ? body : JSON.stringify(body) }),
        });
      } catch {
        if (method === "GET" && attempt < 2) {
          await delay(5000);
          continue;
        }
        throw new Error(`Provider ${method} ${new URL(url).host} failed (0); details suppressed`);
      }
      if (response.status === 401 && attempt === 0) {
        cached = undefined;
        continue;
      }
      if (response.status >= 500 && method === "GET" && attempt < 2) {
        await delay(5000);
        continue;
      }
      if (allow.includes(response.status)) return { status: response.status };
      if (response.status === 404 && ["GET", "DELETE"].includes(method)) return null;
      if (!response.ok)
        throw new Error(
          `Provider ${method} ${new URL(url).host} failed (${response.status}); body suppressed`,
        );
      return response.status === 204 ? {} : response.json().catch(() => ({}));
    }
  }
  /** Fresh service accounts can 404/400 on IAM calls for a while; retry bounded. */
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
  const names = (prefix, runId) => ({
    bucket: `${prefix}-src-${runId}`,
    signer: `${prefix}-sig-${runId}@${project}.iam.gserviceaccount.com`,
    signerId: `${prefix}-sig-${runId}`,
  });
  let stateBucket;
  async function inventoryWrite(runId, data) {
    if (!stateBucket) return;
    await api(
      `https://storage.googleapis.com/upload/storage/v1/b/${stateBucket}/o?uploadType=media&name=${encodeURIComponent(`mvp/m10/runs/${runId}.json`)}`,
      "POST",
      JSON.stringify({ ...data, updatedAt: new Date().toISOString() }),
    );
  }
  async function operatorMember() {
    const { stdout } = await exec("gcloud", ["config", "get-value", "account"]);
    const account = stdout.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(account)) throw new Error("Operator gcloud account unavailable");
    return account.endsWith(".gserviceaccount.com")
      ? `serviceAccount:${account}`
      : `user:${account}`;
  }

  return {
    async preflight() {
      const info = await api(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}`);
      if (!info?.projectNumber) throw new Error("Project unavailable");
      for (const service of [
        "storage.googleapis.com",
        "iamcredentials.googleapis.com",
        "iam.googleapis.com",
      ]) {
        const state = await api(
          `https://serviceusage.googleapis.com/v1/projects/${info.projectNumber}/services/${service}`,
        );
        if (state?.state !== "ENABLED") throw new Error(`Required API not enabled: ${service}`);
      }
      stateBucket = `${project}-tfstate-${info.projectNumber}`;
      const state = await api(`${STORAGE}/b/${stateBucket}?fields=iamConfiguration,versioning`);
      if (
        !state ||
        state.iamConfiguration?.publicAccessPrevention !== "enforced" ||
        state.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true
      )
        throw new Error("Private state bucket unavailable or not private");
    },
    async setUp(approval, runId) {
      const n = names(approval.prefix, runId);
      await inventoryWrite(runId, { status: "creating", bucket: n.bucket, signer: n.signer });
      await api(`${IAM}/projects/${project}/serviceAccounts`, "POST", {
        accountId: n.signerId,
        serviceAccount: { displayName: "Embody M10 qualification source signer (disposable)" },
      });
      await api(`${STORAGE}/b?project=${project}`, "POST", {
        name: n.bucket,
        location: "US-CENTRAL1",
        storageClass: "STANDARD",
        labels: { embody: "m10-qualification", run: runId },
        iamConfiguration: {
          uniformBucketLevelAccess: { enabled: true },
          publicAccessPrevention: "enforced",
        },
        softDeletePolicy: { retentionDurationSeconds: "0" },
        versioning: { enabled: false },
        lifecycle: {
          rule: [
            { action: { type: "Delete" }, condition: { age: 8, matchesPrefix: ["sources/"] } },
          ],
        },
      });
      await eventually(async () => {
        const policy = await api(`${STORAGE}/b/${n.bucket}/iam`);
        policy.bindings = [
          ...(policy.bindings ?? []),
          { role: "roles/storage.objectCreator", members: [`serviceAccount:${n.signer}`] },
        ];
        await api(`${STORAGE}/b/${n.bucket}/iam`, "PUT", policy);
      });
      const operator = await operatorMember();
      await eventually(async () => {
        const policy = await api(
          `${IAM}/projects/-/serviceAccounts/${n.signer}:getIamPolicy`,
          "POST",
          {},
        );
        await api(`${IAM}/projects/-/serviceAccounts/${n.signer}:setIamPolicy`, "POST", {
          policy: {
            ...policy,
            bindings: [
              ...(policy.bindings ?? []),
              { role: "roles/iam.serviceAccountTokenCreator", members: [operator] },
            ],
          },
        });
      });
      await inventoryWrite(runId, { status: "created", bucket: n.bucket, signer: n.signer });
      return {
        bucket: n.bucket,
        signer: n.signer,
        publicObjectUrl: (key) => `https://storage.googleapis.com/${n.bucket}/${key}`,
        publicListUrl: `${STORAGE}/b/${n.bucket}/o`,
      };
    },
    objects(context) {
      return new gateway.GcsSourceObjectStore({
        bucket: context.bucket,
        signerEmail: context.signer,
        accessToken,
        timeoutMs: 20_000,
        fetch: (url, init = {}) => {
          count(init.method ?? "GET", String(url));
          return baseFetch(url, init);
        },
      });
    },
    async rawFetch(url, init = {}) {
      count(init.method ?? "GET", String(url));
      return baseFetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000), ...init });
    },
    async bucketPolicy(context) {
      const bucket = await api(
        `${STORAGE}/b/${context.bucket}?fields=iamConfiguration,location,versioning`,
      );
      const policy = await api(`${STORAGE}/b/${context.bucket}/iam`);
      return {
        uniformBucketLevelAccess:
          bucket.iamConfiguration?.uniformBucketLevelAccess?.enabled === true,
        publicAccessPrevention: bucket.iamConfiguration?.publicAccessPrevention,
        location: bucket.location,
        versioning: bucket.versioning?.enabled === true,
        bindings: (policy.bindings ?? []).map((b) => ({
          role: b.role,
          members: [...b.members].sort(),
        })),
      };
    },
    async projectIam() {
      const policy = await api(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`,
        "POST",
        {},
      );
      const bindings = (policy.bindings ?? [])
        .map(
          (b) =>
            `${b.role}|${[...b.members].sort().join(",")}|${b.condition ? JSON.stringify(b.condition) : ""}`,
        )
        .sort();
      return JSON.stringify(bindings);
    },
    wait: (ms) => delay(ms),
    async tearDown(approval, runId) {
      const n = names(approval.prefix, runId);
      const removed = [];
      if (await api(`${STORAGE}/b/${n.bucket}?fields=name`)) {
        let pageToken;
        do {
          const page = await api(
            `${STORAGE}/b/${n.bucket}/o?versions=true&fields=items(name,generation),nextPageToken${pageToken ? `&pageToken=${pageToken}` : ""}`,
          );
          for (const item of page?.items ?? [])
            await api(
              `${STORAGE}/b/${n.bucket}/o/${encodeURIComponent(item.name)}?generation=${item.generation}`,
              "DELETE",
            );
          pageToken = page?.nextPageToken;
        } while (pageToken);
        await eventually(() => api(`${STORAGE}/b/${n.bucket}`, "DELETE"), 6);
        removed.push("bucket");
      }
      if (await api(`${IAM}/projects/${project}/serviceAccounts/${n.signer}`)) {
        await api(`${IAM}/projects/${project}/serviceAccounts/${n.signer}`, "DELETE");
        removed.push("signer");
      }
      await inventoryWrite(runId, { status: "removed", bucket: n.bucket, signer: n.signer });
      return { pass: true, removed };
    },
    async inventory(approval) {
      const leftovers = [];
      const buckets = await api(
        `${STORAGE}/b?project=${project}&prefix=${approval.prefix}-src-&fields=items(name)`,
      );
      for (const item of buckets?.items ?? []) leftovers.push(`bucket:${item.name}`);
      let pageToken;
      do {
        const page = await api(
          `${IAM}/projects/${project}/serviceAccounts?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ""}`,
        );
        for (const account of page?.accounts ?? [])
          if (account.email.startsWith(`${approval.prefix}-sig-`))
            leftovers.push(`serviceAccount:${account.email}`);
        pageToken = page?.nextPageToken;
      } while (pageToken);
      return leftovers;
    },
    operations: () => ({ ...operations }),
  };
}
