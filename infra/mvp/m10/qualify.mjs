// M10 live authenticated-storage suite. The provider (real GCS in ./gcp.mjs, a fake in tests) does
// all cloud I/O; this module drives the in-process gateway with the provider's object store,
// decides pass/fail and always tears down. Mocked runs exercise the logic only, never evidence.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

const { AbortController, Buffer, ReadableStream, URL, setTimeout } = globalThis;

export const M10_LIMITS = Object.freeze({
  /** Owner-approved one-off live budget (2026-10-18). */
  maxBudgetUsd: 2,
  /** Short-lived access used only by the expiry case. */
  expirySeconds: 5,
  /** IAM/service-account propagation for a fresh signer can take minutes. */
  propagationMs: 8 * 60_000,
});

/** Guards for `test:mvp:cloud` suite `m10`. Throws before any cloud call. */
export function m10Approval(env) {
  const budget = Number(env.EMBODY_MVP_CLOUD_BUDGET_USD);
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(env.EMBODY_MVP_CLOUD_PROJECT ?? "") ||
    !/^embody-test-[a-z0-9-]{1,3}$/u.test(env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX ?? "") ||
    !Number.isFinite(budget) ||
    budget <= 0 ||
    env.EMBODY_MVP_CLOUD_BUDGET_APPROVED !== "true"
  )
    throw new Error(
      "Cloud gate requires an explicit test project, embody-test resource prefix and approved positive budget",
    );
  if (budget > M10_LIMITS.maxBudgetUsd)
    throw new Error("M10 live budget is at most $2 (owner approval 2026-10-18)");
  return {
    project: env.EMBODY_MVP_CLOUD_PROJECT,
    prefix: env.EMBODY_MVP_CLOUD_RESOURCE_PREFIX,
    budgetUsd: budget,
  };
}

/** Every provider method the suite calls. */
export const M10_PROVIDER_METHODS = Object.freeze([
  "preflight",
  "setUp",
  "objects",
  "rawFetch",
  "bucketPolicy",
  "projectIam",
  "wait",
  "tearDown",
  "inventory",
  "operations",
]);

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function safe(error) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Za-z0-9 ,;:/.()_=-]{1,160}$/.test(message) &&
    !/token|ya29|sig=|Signature=/i.test(message)
    ? message
    : (error?.name ?? "Error");
}

/** Bucket privacy and IAM: only the expected principals, never public. */
export function evaluateBucketPolicy(policy, expected) {
  const members = policy.bindings.flatMap((binding) =>
    binding.members.map((member) => `${binding.role}=${member}`),
  );
  const checks = {
    uniformAccess: policy.uniformBucketLevelAccess === true,
    publicAccessPrevented: policy.publicAccessPrevention === "enforced",
    noPublicMembers: !members.some((m) => /=(allUsers|allAuthenticatedUsers)$/.test(m)),
    signerCreateOnly:
      members.includes(`roles/storage.objectCreator=serviceAccount:${expected.signer}`) &&
      !members.some(
        (m) =>
          m.endsWith(`serviceAccount:${expected.signer}`) &&
          !m.startsWith("roles/storage.objectCreator="),
      ),
    region: policy.location === expected.location,
    versioningOff: policy.versioning !== true,
  };
  return { checks, pass: Object.values(checks).every(Boolean) };
}

/**
 * Ordered live run. `deps.gateway` is the built @embody/gateway module and `deps.contracts`
 * the built @embody/cloud-contracts module (imported by the caller after the guards).
 */
export async function runM10Suite(env, provider, deps) {
  const approval = m10Approval(env);
  for (const method of M10_PROVIDER_METHODS)
    if (typeof provider[method] !== "function") throw new Error(`Provider lacks ${method}`);
  const runId = randomBytes(3).toString("hex");
  const cases = {};
  const record = async (name, fn) => {
    try {
      const result = await fn();
      cases[name] = { pass: result.pass === true, ...result };
    } catch (error) {
      cases[name] = { pass: false, error: safe(error) };
    }
  };
  let context;
  let teardown = { pass: false };
  const iamBefore = await provider.projectIam();
  await provider.preflight(approval);
  try {
    context = await provider.setUp(approval, runId);
    const { gateway: g, contracts: c } = deps;
    const objects = provider.objects(context);
    let now = new Date();
    const clock = { now: () => now };
    const store = new g.MemoryGatewayStore();
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const token = await g.hostedSigningIdentity({
      issuer: "m10-live",
      kid: "k1",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES256", use: "sig" }],
    });
    const app = "app_live00001";
    const registration = (ws) => ({
      workspaceId: ws,
      appId: app,
      activeRelease: null,
      state: "unavailable",
      registration: {
        protocolVersion: 1,
        appId: "live",
        version: "1.0.0",
        endpoint: "https://live.example.com",
        healthCheckUrl: "https://live.example.com/health",
        manifest: {
          protocolVersion: 1,
          plugins: [{ id: "live", version: "1.0.0" }],
          entities: {},
          actions: {},
          events: [],
        },
      },
    });
    const workspaces = [`ws_m10a${runId}`, `ws_m10b${runId}`];
    const tokens = {};
    for (const ws of workspaces) {
      await store.createWorkspace(ws);
      await store.putApp(registration(ws), null);
      const issued = g.newCredential({
        workspaceId: ws,
        principal: {
          orgId: ws,
          actorId: "live-operator",
          actorType: "human",
          roles: [],
          scopes: [],
        },
        grants: [{ workspaceId: ws, appId: app, role: "deployer" }],
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      await store.putCredential(issued.credential, null);
      tokens[ws] = issued.token;
    }
    const [wsA, wsB] = workspaces;
    const server = g.createWorkspaceGateway({
      store,
      token,
      clock,
      sources: { objects, storageTimeoutMs: 20_000 },
    });
    const base = (ws) => `/v1/workspaces/${ws}/apps/${app}/sources`;
    const auth = (ws) => ({ authorization: `Bearer ${tokens[ws]}` });
    const archive = (marker) =>
      c.createSourceArchive([
        { path: "package.json", content: Buffer.from('{"name":"live"}') },
        { path: "embody.config.ts", content: Buffer.from("export default {};\n") },
        {
          path: "src/index.ts",
          content: Buffer.from(`export const run = "${runId}-${marker}";\n`),
        },
      ]);
    const create = async (bytes, ws = wsA) =>
      server.inject({
        method: "POST",
        url: base(ws),
        headers: auth(ws),
        payload: {
          version: 1,
          workspaceId: ws,
          appId: app,
          idempotencyKey: `sha256_${sha(bytes).slice(7)}`,
          format: "embody-source-v1",
          digest: sha(bytes),
          bytes: bytes.byteLength,
        },
      });
    const complete = (uploadId, ws = wsA, path = base(ws)) =>
      server.inject({
        method: "POST",
        url: `${path}/${uploadId}/complete`,
        headers: { ...auth(ws), "content-type": "application/json" },
        payload: "{}",
      });
    const put = (upload, body, headers = upload.headers, url = upload.url) =>
      provider.rawFetch(url, { method: "PUT", headers, body });
    try {
      // Fresh signer IAM propagates slowly: warm up with a throwaway object before judging.
      await record("propagation", async () => {
        const warm = archive("warmup");
        const started = Date.now();
        let status = 0;
        let attempts = 0;
        while (Date.now() - started < M10_LIMITS.propagationMs) {
          attempts += 1;
          try {
            const access = await objects.createUploadAccess({
              objectKey: `sources/${wsA}/${app}/src_warm${runId}.tar.gz`,
              bytes: warm.byteLength,
              contentType: "application/gzip",
              expiresAt: new Date(Date.now() + 300_000),
            });
            status = (await put(access, warm)).status;
            if (status === 200 || status === 412) break;
          } catch {
            status = -1;
          }
          await provider.wait(15_000);
        }
        await objects.delete(`sources/${wsA}/${app}/src_warm${runId}.tar.gz`);
        return {
          pass: status === 200 || status === 412,
          attempts,
          seconds: Math.round((Date.now() - started) / 1000),
        };
      });

      await record("bucketPrivacy", async () => {
        const policy = await provider.bucketPolicy(context);
        const evaluation = evaluateBucketPolicy(policy, {
          signer: context.signer,
          location: "US-CENTRAL1",
        });
        const probeKey = `sources/${wsA}/${app}/src_probe${runId}.tar.gz`;
        const bytes = archive("probe");
        const access = await objects.createUploadAccess({
          objectKey: probeKey,
          bytes: bytes.byteLength,
          contentType: "application/gzip",
          expiresAt: new Date(Date.now() + 300_000),
        });
        const stored = (await put(access, bytes)).status;
        const anonymousRead = (await provider.rawFetch(context.publicObjectUrl(probeKey))).status;
        const anonymousList = (await provider.rawFetch(context.publicListUrl)).status;
        const signedRead = (await provider.rawFetch(access.url, { method: "GET" })).status;
        await objects.delete(probeKey);
        const checks = {
          ...evaluation.checks,
          stored: stored === 200,
          anonymousReadDenied: anonymousRead === 401 || anonymousRead === 403,
          anonymousListDenied: anonymousList === 401 || anonymousList === 403,
          signedPutCannotRead: signedRead === 403 || signedRead === 400,
        };
        return {
          pass: Object.values(checks).every(Boolean),
          checks,
          status: { stored, anonymousRead, anonymousList, signedRead },
        };
      });

      let primary;
      await record("admitVerify", async () => {
        const bytes = archive("primary");
        const created = await create(bytes);
        const status = created.json();
        const stored = (await put(status.upload, bytes)).status;
        const done = await complete(status.uploadId);
        const record = await store.source(wsA, app, status.uploadId);
        const info = await objects.stat(record.objectKey);
        const read = info
          ? await objects.read(record.objectKey, {
              generation: info.generation,
              maxBytes: bytes.byteLength,
            })
          : new Uint8Array();
        primary = { status, bytes, record };
        const checks = {
          created: created.statusCode === 201,
          signedHost: new URL(status.upload.url).host === "storage.googleapis.com",
          expiry: Date.parse(status.upload.expiresAt) - Date.now() <= 600_000 + 5_000,
          stored: stored === 200,
          verified: done.statusCode === 200 && done.json().state === "verified",
          storedDigest: sha(read) === status.digest && info?.bytes === bytes.byteLength,
        };
        return { pass: Object.values(checks).every(Boolean), checks };
      });

      await record("accessBounds", async () => {
        const bytes = archive("bounds");
        const status = (await create(bytes)).json();
        const tampered = new URL(status.upload.url);
        const signature = tampered.searchParams.get("X-Goog-Signature");
        tampered.searchParams.set(
          "X-Goog-Signature",
          `${signature.slice(0, -4)}${signature.slice(-4) === "0000" ? "1111" : "0000"}`,
        );
        const otherKey = new URL(status.upload.url);
        otherKey.pathname = otherKey.pathname.replace(status.uploadId, `src_other${runId}`);
        const withoutPrecondition = Object.fromEntries(
          Object.entries(status.upload.headers).filter(
            ([name]) => name !== "x-goog-if-generation-match",
          ),
        );
        const results = {
          longer: (await put(status.upload, Buffer.concat([bytes, Buffer.from("x")]))).status,
          shorter: (await put(status.upload, bytes.subarray(0, bytes.length - 1))).status,
          badSignature: (await put(status.upload, bytes, status.upload.headers, tampered.href))
            .status,
          otherObject: (await put(status.upload, bytes, status.upload.headers, otherKey.href))
            .status,
          droppedPrecondition: (await put(status.upload, bytes, withoutPrecondition)).status,
          widenedRange: (
            await put(status.upload, bytes, {
              ...status.upload.headers,
              "x-goog-content-length-range": "0,99999999",
            })
          ).status,
          valid: (await put(status.upload, bytes)).status,
          overwrite: (
            await put(
              status.upload,
              Buffer.from(bytes).map((b, i) => (i === bytes.length - 1 ? b ^ 0xff : b)),
            )
          ).status,
        };
        const checks = {
          longerRejected: results.longer >= 400 && results.longer < 500,
          shorterRejected: results.shorter >= 400 && results.shorter < 500,
          badSignatureRejected: results.badSignature === 403,
          otherObjectRejected: results.otherObject === 403,
          preconditionRequired: results.droppedPrecondition === 403,
          rangeRequired: results.widenedRange === 403,
          validStored: results.valid === 200,
          createOnly: results.overwrite === 412,
          otherObjectAbsent:
            (await objects.stat(`sources/${wsA}/${app}/src_other${runId}.tar.gz`)) === null,
          verified: (await complete(status.uploadId)).json().state === "verified",
        };
        return { pass: Object.values(checks).every(Boolean), checks, results };
      });

      await record("expiredAccess", async () => {
        const bytes = archive("expiry");
        const key = `sources/${wsA}/${app}/src_exp${runId}.tar.gz`;
        const access = await objects.createUploadAccess({
          objectKey: key,
          bytes: bytes.byteLength,
          contentType: "application/gzip",
          expiresAt: new Date(Date.now() + M10_LIMITS.expirySeconds * 1000),
        });
        await provider.wait((M10_LIMITS.expirySeconds + 5) * 1000);
        const status = (await put(access, bytes)).status;
        const absent = (await objects.stat(key)) === null;
        return { pass: status >= 400 && status < 500 && absent, status, absent };
      });

      await record("digestMismatch", async () => {
        const bytes = archive("mismatch");
        const status = (await create(bytes)).json();
        const corrupt = Buffer.from(bytes);
        corrupt[corrupt.length - 1] ^= 0xff;
        const stored = (await put(status.upload, corrupt)).status;
        const rejected = await complete(status.uploadId);
        const record = await store.source(wsA, app, status.uploadId);
        const deleted = (await objects.stat(record.objectKey)) === null;
        const retry = (await create(bytes)).json();
        const retried = (await put(retry.upload, bytes)).status;
        const done = (await complete(retry.uploadId)).json();
        const checks = {
          stored: stored === 200,
          rejected: rejected.statusCode === 400 && rejected.json().error.code === "DIGEST_MISMATCH",
          deleted,
          sameIdentity: retry.uploadId === status.uploadId && retry.attempt === 2,
          retried: retried === 200 && done.state === "verified",
        };
        return { pass: Object.values(checks).every(Boolean), checks };
      });

      await record("adversarialArchive", async () => {
        const entries = [
          c.rawTarEntry("package.json", Buffer.from("{}")),
          c.rawTarEntry("embody.config.ts", Buffer.from("export default {};")),
          c.rawTarEntry("src/escape", Buffer.alloc(0), { type: "2", linkname: "../../../../etc" }),
          c.rawTarEntry(`src/${runId}.ts`, Buffer.from("x")),
        ];
        const { gzipSync } = await import("node:zlib");
        const bytes = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
        const status = (await create(bytes)).json();
        const stored = (await put(status.upload, bytes)).status;
        const rejected = await complete(status.uploadId);
        const record = await store.source(wsA, app, status.uploadId);
        const checks = {
          stored: stored === 200,
          rejected: rejected.statusCode === 400 && rejected.json().error.code === "UNSAFE_ENTRY",
          deleted: (await objects.stat(record.objectKey)) === null,
        };
        return { pass: Object.values(checks).every(Boolean), checks };
      });

      await record("interruptedUpload", async () => {
        const bytes = archive("interrupted");
        const status = (await create(bytes)).json();
        const controller = new AbortController();
        const body = new ReadableStream({
          start(stream) {
            stream.enqueue(bytes.subarray(0, Math.floor(bytes.length / 2)));
            setTimeout(() => controller.abort(), 500);
          },
        });
        let aborted = false;
        try {
          await provider.rawFetch(status.upload.url, {
            method: "PUT",
            headers: status.upload.headers,
            body,
            duplex: "half",
            signal: controller.signal,
          });
        } catch {
          aborted = true;
        }
        const record = await store.source(wsA, app, status.uploadId);
        const absent = (await objects.stat(record.objectKey)) === null;
        const incomplete = await complete(status.uploadId);
        const restarted = (await create(bytes)).json();
        const stored = (await put(restarted.upload, bytes)).status;
        const done = (await complete(restarted.uploadId)).json();
        const checks = {
          aborted,
          nothingStored: absent,
          incomplete:
            incomplete.statusCode === 409 && incomplete.json().error.code === "UPLOAD_INCOMPLETE",
          sameIdentity: restarted.uploadId === status.uploadId,
          restarted: stored === 200 && done.state === "verified",
        };
        return { pass: Object.values(checks).every(Boolean), checks };
      });

      await record("crossWorkspace", async () => {
        const id = primary?.status.uploadId;
        if (!id) return { pass: false, error: "primary upload missing" };
        const foreignOwnPath = await complete(id, wsB);
        const foreignStatus = await server.inject({
          method: "GET",
          url: `${base(wsB)}/${id}`,
          headers: auth(wsB),
        });
        const foreignOnA = await server.inject({
          method: "POST",
          url: `${base(wsA)}/${id}/complete`,
          headers: { ...auth(wsB), "content-type": "application/json" },
          payload: "{}",
        });
        // B's own access cannot be pointed at A's object.
        const bytes = archive("foreign");
        const bAccess = (await create(bytes, wsB)).json();
        const redirected = new URL(bAccess.upload.url);
        redirected.pathname = redirected.pathname.replace(`/${wsB}/`, `/${wsA}/`);
        const crossWrite = (
          await put(bAccess.upload, bytes, bAccess.upload.headers, redirected.href)
        ).status;
        const checks = {
          foreignOwnPath404: foreignOwnPath.statusCode === 404,
          foreignStatus404: foreignStatus.statusCode === 404,
          foreignCredential401: foreignOnA.statusCode === 401,
          crossWrite403: crossWrite === 403,
        };
        return { pass: Object.values(checks).every(Boolean), checks };
      });

      await record("retentionPurge", async () => {
        const key = primary?.record.objectKey;
        const before = key ? await objects.stat(key) : null;
        now = new Date(Date.parse(primary.record.retainUntil) + 1000);
        const purged = await g.purgeExpiredSources({ store, objects, now, limit: 100 });
        const after = await objects.stat(key);
        const checks = {
          existedBefore: before !== null,
          purged: purged.failed === 0 && purged.deleted >= 1,
          objectGone: after === null,
        };
        return { pass: Object.values(checks).every(Boolean), checks, purged };
      });
    } finally {
      await server.close();
      await store.close();
    }
  } catch (error) {
    cases.setUp = { pass: false, error: safe(error) };
  } finally {
    try {
      teardown = await provider.tearDown(approval, runId, context);
    } catch (error) {
      teardown = { pass: false, error: safe(error) };
    }
  }
  const leftovers = await provider.inventory(approval, runId);
  const iamAfter = await provider.projectIam();
  cases.cleanup = {
    pass: teardown.pass === true && leftovers.length === 0 && iamBefore === iamAfter,
    teardown,
    leftovers,
    projectIamUnchanged: iamBefore === iamAfter,
  };
  const operations = provider.operations();
  // GCS Standard us-central1 list prices (2026-10): class A $0.005/1k, class B $0.0004/1k,
  // storage $0.020/GiB-month; IAM and service-account calls are free.
  const estimatedUsd = Number(
    ((operations.classA * 0.005) / 1000 + (operations.classB * 0.0004) / 1000 + 0.0001).toFixed(4),
  );
  const pass =
    Object.values(cases).every((value) => value.pass === true) &&
    estimatedUsd <= approval.budgetUsd;
  return { pass, runId, cases, operations, estimatedUsd, budgetUsd: approval.budgetUsd };
}
