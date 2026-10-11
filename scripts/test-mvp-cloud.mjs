import { access } from "node:fs/promises";
import { main, requireVariables } from "./verification.mjs";

await main("mvp-cloud", async () => {
  requireVariables([
    "EMBODY_MVP_CLOUD_PROJECT",
    "EMBODY_MVP_CLOUD_RESOURCE_PREFIX",
    "EMBODY_MVP_CLOUD_BUDGET_USD",
    "EMBODY_MVP_CLOUD_BUDGET_APPROVED",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ]);
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(process.env.EMBODY_MVP_CLOUD_PROJECT) ||
    !/^embody-test-[a-z0-9-]{1,40}$/u.test(process.env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX) ||
    !Number.isFinite(Number(process.env.EMBODY_MVP_CLOUD_BUDGET_USD)) ||
    Number(process.env.EMBODY_MVP_CLOUD_BUDGET_USD) <= 0 ||
    process.env.EMBODY_MVP_CLOUD_BUDGET_APPROVED !== "true"
  )
    throw new Error(
      "Cloud gate requires an explicit test project, embody-test resource prefix and approved positive budget",
    );
  try {
    await access(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  } catch {
    throw new Error("Cloud credential file unavailable (path redacted)");
  }
  // Do not implement a misleading green stub or spend money before qualification exists.
  throw new Error(
    "Cloud qualification suites are not implemented yet (M09–M17); no resources created",
  );
});
