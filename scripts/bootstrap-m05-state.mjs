// Operator-only bootstrap. The bucket must exist BEFORE Terraform can use its GCS backend.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const exec = promisify(execFile);
const { fetch, AbortSignal } = globalThis;
// M05 foundation by default; M09 reuses the same bucket under its own state prefix (MD06 $25).
const STATES = {
  "mvp/m05/foundation": 10,
  "mvp/m09/baseline": 25,
};
export async function bootstrapState(
  { project, region = "us-central1", budget, approved, statePrefix = "mvp/m05/foundation" },
  { fetcher = fetch, command = exec } = {},
) {
  const maxBudget = STATES[statePrefix];
  if (maxBudget === undefined) throw new Error("Unknown state prefix");
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project ?? "") ||
    approved !== "true" ||
    !Number.isFinite(Number(budget)) ||
    Number(budget) <= 0 ||
    Number(budget) > maxBudget
  )
    throw new Error(
      `Approved dedicated project and positive budget at most $${maxBudget} required`,
    );
  if (region !== "us-central1")
    throw new Error("State bootstrap currently qualified only for us-central1");
  const { stdout: projectJson } = await command("gcloud", [
    "projects",
    "describe",
    project,
    "--format=json(projectId,projectNumber)",
  ]);
  const info = JSON.parse(projectJson);
  if (info.projectId !== project || !/^\d+$/.test(info.projectNumber))
    throw new Error("Project identity mismatch");
  const { stdout: token } = await command("gcloud", ["auth", "print-access-token"]);
  const bucket = `${project}-tfstate-${info.projectNumber}`;
  async function api(path, method = "GET", body) {
    const response = await fetcher(`https://storage.googleapis.com/storage/v1/${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error("State bucket API failed; no provider body emitted");
    return response.json();
  }
  let state = await api(`b/${bucket}`);
  if (!state)
    state = await api(`b?project=${project}`, "POST", {
      name: bucket,
      location: region,
      storageClass: "STANDARD",
      labels: { managed_by: "embody-state-bootstrap", purpose: "terraform-state" },
      iamConfiguration: {
        uniformBucketLevelAccess: { enabled: true },
        publicAccessPrevention: "enforced",
      },
      versioning: { enabled: true },
      softDeletePolicy: { retentionDurationSeconds: "0" },
      lifecycle: {
        rule: [
          {
            action: { type: "Delete" },
            condition: { isLive: false, daysSinceNoncurrentTime: 30, numNewerVersions: 5 },
          },
        ],
      },
    });
  if (
    String(state.projectNumber) !== info.projectNumber ||
    state.location?.toLowerCase() !== region ||
    state.labels?.managed_by !== "embody-state-bootstrap" ||
    state.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true ||
    state.iamConfiguration?.publicAccessPrevention !== "enforced" ||
    state.versioning?.enabled !== true
  )
    throw new Error(
      "Existing state bucket is not the owned private/versioned bootstrap; refusing adoption",
    );
  return { project, bucket, prefix: statePrefix, region, budgetUsd: Number(budget) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapState({
    project: process.env.EMBODY_MVP_CLOUD_PROJECT,
    budget: process.env.EMBODY_MVP_CLOUD_BUDGET_USD,
    approved: process.env.EMBODY_MVP_CLOUD_BUDGET_APPROVED,
    ...(process.env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX === "embody-test-m09"
      ? { statePrefix: "mvp/m09/baseline" }
      : {}),
  })
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error("State bootstrap failed; credentials/provider errors suppressed.");
      process.exitCode = 1;
    });
}
