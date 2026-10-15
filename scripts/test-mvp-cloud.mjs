import { access } from "node:fs/promises";
import { evidence, main, requireVariables, SuiteFailure } from "./verification.mjs";
import { m09Approval, runM09Suite } from "../infra/mvp/m09/qualify.mjs";

// Real-provider qualification. Only M09 exists; later suites (M10–M17, M19–M21 cloud cases) must
// be added here before this gate can stand for a release (M18). Requesting one fails closed.
const IMPLEMENTED = ["m09"];
const PENDING = ["m10", "m11", "m12", "m13", "m14", "m15", "m16", "m17", "m20", "m21"];

await main("mvp-cloud", async () => {
  requireVariables([
    "EMBODY_MVP_CLOUD_PROJECT",
    "EMBODY_MVP_CLOUD_RESOURCE_PREFIX",
    "EMBODY_MVP_CLOUD_BUDGET_USD",
    "EMBODY_MVP_CLOUD_BUDGET_APPROVED",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ]);
  m09Approval(process.env);
  try {
    await access(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  } catch {
    throw new Error("Cloud credential file unavailable (path redacted)");
  }
  const suites = (process.env.EMBODY_MVP_CLOUD_SUITES ?? "m09")
    .split(",")
    .map((value) => value.trim());
  const unimplemented = suites.filter((suite) => !IMPLEMENTED.includes(suite));
  if (unimplemented.length)
    throw new Error(
      `Cloud qualification suites are not implemented yet (${unimplemented.join(", ")}); no resources created`,
    );
  requireVariables(["EMBODY_M09_BASELINE", "EMBODY_M09_IMAGE", "EMBODY_CLOUD_SQL_PROXY"]);
  // Imported only now: the guards above never load provider code or contact a cloud API.
  const { createGcpProvider, loadBaseline } = await import("../infra/mvp/m09/gcp.mjs");
  const provider = createGcpProvider({
    baseline: await loadBaseline(process.env.EMBODY_M09_BASELINE),
    image: process.env.EMBODY_M09_IMAGE,
  });
  const result = await runM09Suite(process.env, provider);
  const outcomes = Object.values(result.cases);
  const counts = {
    passed: outcomes.filter((value) => value.pass === true).length,
    failed: outcomes.filter((value) => value.pass !== true).length,
    skipped: 0,
  };
  const details = { suites, releaseGate: false, pendingSuites: PENDING, m09: result };
  if (!result.pass) {
    await evidence("mvp-cloud-m09", "failed", counts, [], details);
    throw new SuiteFailure("M09 cloud qualification failed; see sanitized case results", counts);
  }
  await evidence("mvp-cloud", "passed", counts, [], details);
});
