// Operator fixture CLI; future controller calls the same adapter after authorizing/fencing a job.
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCloudRunAppProvisioner } from "../infra/mvp/provider/cloud-run.mjs";
const exec = promisify(execFile);
async function main() {
  const [action, filename] = process.argv.slice(2);
  if (
    !["prepare", "deploy", "remove"].includes(action) ||
    !filename ||
    process.env.EMBODY_MVP_CLOUD_BUDGET_APPROVED !== "true"
  )
    throw new Error("Explicit fixture approval and config required");
  const budget = Number(process.env.EMBODY_MVP_CLOUD_BUDGET_USD);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 10)
    throw new Error("Approved ceiling at most $10 required");
  const config = JSON.parse(await readFile(filename, "utf8"));
  if (
    config.project !== process.env.EMBODY_MVP_CLOUD_PROJECT ||
    config.prefix !== process.env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX ||
    config.region !== "us-central1"
  )
    throw new Error("Config does not match approved project/prefix");
  // One short-lived operator token for this bounded invocation; never serialized/output.
  const token = (await exec("gcloud", ["auth", "print-access-token"])).stdout.trim();
  const provider = createCloudRunAppProvisioner({
    project: config.project,
    region: config.region,
    prefix: config.prefix,
    gatewayEmail: `${config.prefix}-gateway@${config.project}.iam.gserviceaccount.com`,
    accessToken: () => Promise.resolve(token),
  });
  const scope = { workspaceId: config.workspaceId, appId: config.appId };
  const result =
    action === "prepare"
      ? await provider.prepare(scope)
      : action === "remove"
        ? await provider.remove(scope)
        : await provider.deploy(scope, {
            image: config.image,
            issuer: config.issuer,
            jwksUrl: config.jwksUrl,
            secretVersion: config.secretVersion,
          });
  console.log(JSON.stringify(result));
}
main().catch(() => {
  console.error(
    "App fixture provisioning failed; provider/credential details suppressed. Reconcile by deterministic owned names.",
  );
  process.exitCode = 1;
});
