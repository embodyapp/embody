// Real GCP provider for the M14 live journey, composed on the M13 provider (M11 build resources,
// M12 Cloud SQL platform database, controller queue and worker, M13 public gateway, provisioner
// and release grants). M14 adds the user's upload path through the gateway: a run-scoped upload
// signer service account holding only `roles/storage.objectCreator` on the run's source bucket,
// the gateway's object access on that bucket and `signBlob` on the signer, and the gateway's M10
// source routes (SOURCES identity table). Plus read-only helpers for the journey: an app's wake
// tasks, the run's Cloud Run logs and the stored source archives (secret scan). Everything is
// run-scoped and removed on teardown; nothing prints tokens.
import { setTimeout as delay } from "node:timers/promises";
import { deadlineFetch, operatorToken } from "../m09/gcp.mjs";
import { createM13GcpProvider, m13Names } from "../m13/gcp.mjs";

const { Buffer, URL, fetch } = globalThis;
const REGION = "us-central1";
const IAM = "https://iam.googleapis.com/v1";
const STORAGE = "https://storage.googleapis.com/storage/v1";
const TASKS = "https://cloudtasks.googleapis.com/v2";
const LOGGING = "https://logging.googleapis.com/v2";

export function m14Names(project, prefix, runId) {
  return {
    ...m13Names(project, prefix, runId),
    uploader: {
      id: `${prefix}-u-${runId}`,
      email: `${prefix}-u-${runId}@${project}.iam.gserviceaccount.com`,
    },
  };
}

export function createM14GcpProvider({
  project,
  gateway,
  credentials = "gcloud",
  token = () => operatorToken(credentials),
  fetcher: baseFetch = fetch,
}) {
  const m13 = createM13GcpProvider({ project, gateway, credentials, token, fetcher: baseFetch });
  const fetcher = deadlineFetch(baseFetch);
  let cached;
  const accessToken = async () => {
    if (!cached || cached.until < Date.now())
      cached = { value: await token(), until: Date.now() + 3 * 60_000 };
    return cached.value;
  };
  async function api(url, method = "GET", body, { raw = false } = {}) {
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
      if (raw) return Buffer.from(await response.arrayBuffer());
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
  /** Bucket policies are GET/PUT `…/b/<bucket>/iam`; service accounts POST get/setIamPolicy. */
  async function bindBucket(bucket, role, member) {
    await eventually(async () => {
      const policy = (await api(`${STORAGE}/b/${bucket}/iam`)) ?? {};
      policy.bindings = [...(policy.bindings ?? []), { role, members: [member] }];
      await api(`${STORAGE}/b/${bucket}/iam`, "PUT", policy);
    });
  }
  async function bindAccount(email, role, member) {
    await eventually(async () => {
      const policy =
        (await api(`${IAM}/projects/-/serviceAccounts/${email}:getIamPolicy`, "POST", {})) ?? {};
      policy.bindings = [...(policy.bindings ?? []), { role, members: [member] }];
      await api(`${IAM}/projects/-/serviceAccounts/${email}:setIamPolicy`, "POST", { policy });
    });
  }
  async function listObjects(bucket) {
    const names = [];
    let page;
    do {
      const result = await api(
        `${STORAGE}/b/${bucket}/o?maxResults=1000${page ? `&pageToken=${page}` : ""}`,
      );
      for (const item of result?.items ?? []) names.push(item.name);
      page = result?.nextPageToken;
    } while (page && names.length < 5000);
    return names;
  }

  return {
    ...m13,
    async setUp(approval, runId) {
      const context = await m13.setUp(approval, runId);
      const n = m14Names(project, approval.prefix, runId);
      await api(`${IAM}/projects/${project}/serviceAccounts`, "POST", {
        accountId: n.uploader.id,
        serviceAccount: {
          displayName: "Embody M14 qualification source upload signer (disposable)",
        },
      });
      const gatewayMember = `serviceAccount:${context.gatewayAccount.email}`;
      // A signed PUT acts as the signer: create-only on the run's source bucket, nothing else.
      await bindBucket(
        context.sourceBucket,
        "roles/storage.objectCreator",
        `serviceAccount:${n.uploader.email}`,
      );
      // The gateway verifies (reads) and deletes rejected objects; it signs through the signer.
      await bindBucket(context.sourceBucket, "roles/storage.objectUser", gatewayMember);
      await bindAccount(n.uploader.email, "roles/iam.serviceAccountTokenCreator", gatewayMember);
      return { ...context, uploader: n.uploader };
    },
    /** The M13 gateway with the M10 source routes on the run's bucket and upload signer. */
    async deployGateway(context, options) {
      return m13.deployGateway(context, {
        ...options,
        env: {
          EMBODY_SOURCE_BUCKET: context.sourceBucket,
          EMBODY_SOURCE_SIGNER: context.uploader.email,
        },
      });
    },
    /** Tasks waiting in an app's own wake queue (names and due times only). */
    async wakeTasks(context, names) {
      const queue = `projects/${project}/locations/${REGION}/queues/${names.wakeQueue}`;
      const result = await api(`${TASKS}/${queue}/tasks?pageSize=100`);
      return (result?.tasks ?? []).map((task) => ({
        name: task.name.split("/").pop(),
        scheduleTime: task.scheduleTime,
      }));
    },
    /**
     * The run's Cloud Run log entries since `since` (gateway, worker, candidates), as text for
     * the secret scan. Read locally, never searched with a secret in the query.
     */
    async runLogs(context, since) {
      const services = [context.gatewayService, context.service];
      const filter = [
        'resource.type="cloud_run_revision"',
        `(${services.map((s) => `resource.labels.service_name="${s}"`).join(" OR ")} OR resource.labels.service_name:"${context.platformPrefix}")`,
        `timestamp>="${since}"`,
      ].join(" AND ");
      const parts = [];
      let page;
      for (let i = 0; i < 20; i++) {
        const result = await api(`${LOGGING}/entries:list`, "POST", {
          resourceNames: [`projects/${project}`],
          filter,
          pageSize: 1000,
          ...(page ? { pageToken: page } : {}),
        });
        for (const entry of result?.entries ?? [])
          parts.push(
            entry.textPayload ?? JSON.stringify(entry.jsonPayload ?? entry.protoPayload ?? {}),
          );
        page = result?.nextPageToken;
        if (!page) break;
      }
      return { entries: parts.length, text: parts.join("\n") };
    },
    /** Every stored source archive and build log of the run (for the secret scan). */
    async storedObjects(context) {
      const out = [];
      for (const bucket of [context.sourceBucket, context.logsBucket])
        for (const name of await listObjects(bucket))
          out.push({
            bucket: bucket === context.sourceBucket ? "source" : "logs",
            bytes: await api(
              `${STORAGE}/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`,
              "GET",
              undefined,
              {
                raw: true,
              },
            ),
          });
      return out;
    },
    async tearDown(approval, runId, context) {
      const n = m14Names(project, approval.prefix, runId);
      const removed = [];
      // The gateway (deleted by M13's teardown) is the only holder of grants on the signer.
      const result = await m13.tearDown(approval, runId, context);
      if (await api(`${IAM}/projects/${project}/serviceAccounts/${n.uploader.email}`)) {
        await api(`${IAM}/projects/${project}/serviceAccounts/${n.uploader.email}`, "DELETE");
        removed.push(`serviceAccount:${n.uploader.id}`);
      }
      return { pass: result.pass === true, removed: [...result.removed, ...removed] };
    },
    async inventory(approval, runId) {
      const n = m14Names(project, approval.prefix, runId);
      const leftovers = [...(await m13.inventory(approval, runId))];
      if (await api(`${IAM}/projects/${project}/serviceAccounts/${n.uploader.email}`))
        leftovers.push(`serviceAccount:${n.uploader.id}`);
      return leftovers;
    },
  };
}
