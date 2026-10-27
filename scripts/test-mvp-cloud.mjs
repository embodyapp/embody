import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { URL, pathToFileURL } from "node:url";
import { evidence, main, requireVariables, SuiteFailure } from "./verification.mjs";
import { m09Approval, runM09Suite } from "../infra/mvp/m09/qualify.mjs";
import { m10Approval } from "../infra/mvp/m10/qualify.mjs";
import { m11Approval } from "../infra/mvp/m11/qualify.mjs";
import { m12Approval } from "../infra/mvp/m12/qualify.mjs";
import { m13Approval } from "../infra/mvp/m13/qualify.mjs";
import { m14Approval } from "../infra/mvp/m14/qualify.mjs";

// Real-provider qualification. M09–M14 exist; later suites (M15–M17, M20, M21 cloud cases)
// must be added here before this gate can stand for a release (M18). Requesting one fails closed.
const IMPLEMENTED = ["m09", "m10", "m11", "m12", "m13", "m14"];
const PENDING = ["m15", "m16", "m17", "m20", "m21"];

await main("mvp-cloud", async () => {
  requireVariables([
    "EMBODY_MVP_CLOUD_PROJECT",
    "EMBODY_MVP_CLOUD_RESOURCE_PREFIX",
    "EMBODY_MVP_CLOUD_BUDGET_USD",
    "EMBODY_MVP_CLOUD_BUDGET_APPROVED",
  ]);
  const suites = (process.env.EMBODY_MVP_CLOUD_SUITES ?? "m09")
    .split(",")
    .map((value) => value.trim());
  if (suites.includes("m09")) m09Approval(process.env);
  if (suites.includes("m10")) m10Approval(process.env);
  if (suites.includes("m11")) m11Approval(process.env);
  if (suites.includes("m12")) m12Approval(process.env);
  if (suites.includes("m13")) m13Approval(process.env);
  if (suites.includes("m14")) m14Approval(process.env);
  // Either the operator's own gcloud login (no key file, as in M05) or a credential file.
  if (process.env.EMBODY_MVP_CLOUD_CREDENTIALS !== "gcloud") {
    requireVariables(["GOOGLE_APPLICATION_CREDENTIALS"]);
    try {
      await access(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    } catch {
      throw new Error("Cloud credential file unavailable (path redacted)");
    }
  }
  const unimplemented = suites.filter((suite) => !IMPLEMENTED.includes(suite));
  if (unimplemented.length)
    throw new Error(
      `Cloud qualification suites are not implemented yet (${unimplemented.join(", ")}); no resources created`,
    );
  if (suites.length !== 1)
    throw new Error("Run one cloud suite per invocation; no resources created");
  const credentials = process.env.EMBODY_MVP_CLOUD_CREDENTIALS === "gcloud" ? "gcloud" : "adc";
  if (suites[0] === "m14") {
    const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
    const [
      { createM14GcpProvider },
      { CLOUD_BUILDERS_DOCKER },
      { runM14Suite },
      { runM14Journey, M14_CASES },
      consumer,
      gateway,
      { stageRecipe },
      { startFrameworkRegistry },
      jose,
    ] = await Promise.all([
      import("../infra/mvp/m14/gcp.mjs"),
      import("../infra/mvp/m11/gcp.mjs"),
      import("../infra/mvp/m14/qualify.mjs"),
      import("../infra/mvp/m14/journey.mjs"),
      import("../infra/mvp/m14/consumer.mjs"),
      import("../packages/gateway/dist/index.js"),
      import("../infra/mvp/builder/stage.mjs"),
      import("../infra/mvp/builder/registry.mjs"),
      import(pathToFileURL(require.resolve("jose")).href),
    ]);
    const provider = createM14GcpProvider({
      project: process.env.EMBODY_MVP_CLOUD_PROJECT,
      gateway,
      credentials,
    });
    const result = await runM14Suite(process.env, provider, {
      gateway,
      stageRecipe,
      startFrameworkRegistry,
      consumer,
      runM14Journey,
      cases: M14_CASES,
      root: new URL("..", import.meta.url).pathname,
      require,
      cloudBuildersDocker: CLOUD_BUILDERS_DOCKER,
      // A throwaway run-scoped gateway signing key (private half only in the run's secret).
      async signingKey(kid) {
        const pair = await jose.generateKeyPair("ES256", { extractable: true });
        return {
          kid,
          privateKeyPem: await jose.exportPKCS8(pair.privateKey),
          publicJwks: {
            keys: [{ ...(await jose.exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" }],
          },
        };
      },
    });
    const outcomes = Object.values(result.cases);
    const counts = {
      passed: outcomes.filter((value) => value.pass === true).length,
      failed: outcomes.filter((value) => value.pass !== true).length,
      skipped: 0,
    };
    const details = { suites, releaseGate: false, pendingSuites: PENDING, m14: result };
    if (!result.pass) {
      await evidence("mvp-cloud-m14", "failed", counts, [], details);
      throw new SuiteFailure("M14 cloud journey failed; see sanitized case results", counts);
    }
    await evidence("mvp-cloud-m14", "passed", counts, [], details);
    return;
  }
  if (suites[0] === "m13") {
    const [
      { createM13GcpProvider },
      { CLOUD_BUILDERS_DOCKER },
      { runM13Suite },
      gateway,
      contracts,
      scaffold,
      { stageRecipe },
      { startFrameworkRegistry },
      { createFixture, requestOnly },
      jose,
    ] = await Promise.all([
      import("../infra/mvp/m13/gcp.mjs"),
      import("../infra/mvp/m11/gcp.mjs"),
      import("../infra/mvp/m13/qualify.mjs"),
      import("../packages/gateway/dist/index.js"),
      import("../packages/cloud-contracts/dist/index.js"),
      import("../packages/create-embody-app/dist/index.js"),
      import("../infra/mvp/builder/stage.mjs"),
      import("../infra/mvp/builder/registry.mjs"),
      Promise.all([
        import("../infra/mvp/m11/fixtures.mjs"),
        import("../packages/gateway/test/fixtures/m12-fixtures.mjs"),
      ]).then(([fixtures, m12]) => ({ ...fixtures, requestOnly: m12.requestOnly })),
      import(
        pathToFileURL(
          createRequire(new URL("../packages/gateway/package.json", import.meta.url)).resolve(
            "jose",
          ),
        ).href
      ),
    ]);
    const provider = createM13GcpProvider({
      project: process.env.EMBODY_MVP_CLOUD_PROJECT,
      gateway,
      credentials,
    });
    const result = await runM13Suite(process.env, provider, {
      gateway,
      contracts,
      createApp: scaffold.createApp,
      stageRecipe,
      startFrameworkRegistry,
      createFixture,
      requestOnly,
      durable: {
        profile: "durable-v1",
        crud: true,
        boundedActions: true,
        workflows: true,
        events: true,
        subscriptions: true,
        schedules: false,
        appToAppRpc: false,
        persistentLocalState: false,
        genui: false,
      },
      cloudBuildersDocker: CLOUD_BUILDERS_DOCKER,
      // A throwaway run-scoped gateway signing key; only its public half leaves this machine
      // unencrypted (the private half goes to the run's Secret Manager secret).
      async signingKey(kid) {
        const pair = await jose.generateKeyPair("ES256", { extractable: true });
        return {
          kid,
          privateKeyPem: await jose.exportPKCS8(pair.privateKey),
          publicJwks: {
            keys: [{ ...(await jose.exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" }],
          },
        };
      },
    });
    const outcomes = Object.values(result.cases);
    const counts = {
      passed: outcomes.filter((value) => value.pass === true).length,
      failed: outcomes.filter((value) => value.pass !== true).length,
      skipped: 0,
    };
    const details = { suites, releaseGate: false, pendingSuites: PENDING, m13: result };
    if (!result.pass) {
      await evidence("mvp-cloud-m13", "failed", counts, [], details);
      throw new SuiteFailure("M13 cloud qualification failed; see sanitized case results", counts);
    }
    await evidence("mvp-cloud-m13", "passed", counts, [], details);
    return;
  }
  if (suites[0] === "m12") {
    const [
      { createM12GcpProvider },
      { CLOUD_BUILDERS_DOCKER },
      { runM12Suite },
      gateway,
      contracts,
      scaffold,
      { stageRecipe },
      { startFrameworkRegistry },
      { createFixture },
      jose,
    ] = await Promise.all([
      import("../infra/mvp/m12/gcp.mjs"),
      import("../infra/mvp/m11/gcp.mjs"),
      import("../infra/mvp/m12/qualify.mjs"),
      import("../packages/gateway/dist/index.js"),
      import("../packages/cloud-contracts/dist/index.js"),
      import("../packages/create-embody-app/dist/index.js"),
      import("../infra/mvp/builder/stage.mjs"),
      import("../infra/mvp/builder/registry.mjs"),
      import("../infra/mvp/m11/fixtures.mjs"),
      import(
        pathToFileURL(
          createRequire(new URL("../packages/gateway/package.json", import.meta.url)).resolve(
            "jose",
          ),
        ).href
      ),
    ]);
    // The operator's in-process gateway signs nothing that leaves this machine; a throwaway key.
    const pair = await jose.generateKeyPair("ES256", { extractable: true });
    const signingIdentity = await gateway.hostedSigningIdentity({
      issuer: "m12-qualification",
      kid: "m12",
      privateKeyPem: await jose.exportPKCS8(pair.privateKey),
      publicKeys: [
        { ...(await jose.exportJWK(pair.publicKey)), kid: "m12", alg: "ES256", use: "sig" },
      ],
    });
    const provider = createM12GcpProvider({
      project: process.env.EMBODY_MVP_CLOUD_PROJECT,
      gateway,
      credentials,
    });
    const result = await runM12Suite(process.env, provider, {
      gateway,
      contracts,
      createApp: scaffold.createApp,
      stageRecipe,
      startFrameworkRegistry,
      createFixture,
      cloudBuildersDocker: CLOUD_BUILDERS_DOCKER,
      signingIdentity,
    });
    const outcomes = Object.values(result.cases);
    const counts = {
      passed: outcomes.filter((value) => value.pass === true).length,
      failed: outcomes.filter((value) => value.pass !== true).length,
      skipped: 0,
    };
    const details = { suites, releaseGate: false, pendingSuites: PENDING, m12: result };
    if (!result.pass) {
      await evidence("mvp-cloud-m12", "failed", counts, [], details);
      throw new SuiteFailure("M12 cloud qualification failed; see sanitized case results", counts);
    }
    await evidence("mvp-cloud-m12", "passed", counts, [], details);
    return;
  }
  if (suites[0] === "m11") {
    const [
      { createM11GcpProvider, CLOUD_BUILDERS_DOCKER },
      { runM11Suite },
      gateway,
      contracts,
      scaffold,
      { stageRecipe },
      { startFrameworkRegistry },
    ] = await Promise.all([
      import("../infra/mvp/m11/gcp.mjs"),
      import("../infra/mvp/m11/qualify.mjs"),
      import("../packages/gateway/dist/index.js"),
      import("../packages/cloud-contracts/dist/index.js"),
      import("../packages/create-embody-app/dist/index.js"),
      import("../infra/mvp/builder/stage.mjs"),
      import("../infra/mvp/builder/registry.mjs"),
    ]);
    const provider = createM11GcpProvider({
      project: process.env.EMBODY_MVP_CLOUD_PROJECT,
      gateway,
      credentials,
    });
    const result = await runM11Suite(process.env, provider, {
      gateway,
      contracts,
      createApp: scaffold.createApp,
      stageRecipe,
      startFrameworkRegistry,
      cloudBuildersDocker: CLOUD_BUILDERS_DOCKER,
    });
    const outcomes = Object.values(result.cases);
    const counts = {
      passed: outcomes.filter((value) => value.pass === true).length,
      failed: outcomes.filter((value) => value.pass !== true).length,
      skipped: 0,
    };
    const details = { suites, releaseGate: false, pendingSuites: PENDING, m11: result };
    if (!result.pass) {
      await evidence("mvp-cloud-m11", "failed", counts, [], details);
      throw new SuiteFailure("M11 cloud qualification failed; see sanitized case results", counts);
    }
    await evidence("mvp-cloud-m11", "passed", counts, [], details);
    return;
  }
  if (suites[0] === "m10") {
    // Imported only now: the guards above never load provider code or contact a cloud API.
    const [{ createM10GcpProvider }, { runM10Suite }, gateway, contracts] = await Promise.all([
      import("../infra/mvp/m10/gcp.mjs"),
      import("../infra/mvp/m10/qualify.mjs"),
      import("../packages/gateway/dist/index.js"),
      import("../packages/cloud-contracts/dist/index.js"),
    ]);
    const provider = createM10GcpProvider({
      project: process.env.EMBODY_MVP_CLOUD_PROJECT,
      gateway,
      credentials,
    });
    const result = await runM10Suite(process.env, provider, { gateway, contracts });
    const outcomes = Object.values(result.cases);
    const counts = {
      passed: outcomes.filter((value) => value.pass === true).length,
      failed: outcomes.filter((value) => value.pass !== true).length,
      skipped: 0,
    };
    const details = { suites, releaseGate: false, pendingSuites: PENDING, m10: result };
    if (!result.pass) {
      await evidence("mvp-cloud-m10", "failed", counts, [], details);
      throw new SuiteFailure("M10 cloud qualification failed; see sanitized case results", counts);
    }
    await evidence("mvp-cloud-m10", "passed", counts, [], details);
    return;
  }
  requireVariables(["EMBODY_M09_BASELINE", "EMBODY_M09_IMAGE", "EMBODY_CLOUD_SQL_PROXY"]);
  const { createGcpProvider, loadBaseline } = await import("../infra/mvp/m09/gcp.mjs");
  const provider = createGcpProvider({
    baseline: await loadBaseline(process.env.EMBODY_M09_BASELINE),
    image: process.env.EMBODY_M09_IMAGE,
    credentials,
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
