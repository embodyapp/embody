import { describe, expect, it } from "vitest";
import { GoogleReleaseProvider, ReleaseProviderError, cloudRunHealthProbe } from "../src/index.js";

type Call = { url: string; method: string; body: unknown; auth: string | null };
function fakeFetch(answer: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetcher = ((input: string | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    };
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    calls.push(call);
    const { status, body } = answer(call);
    return Promise.resolve(
      new Response(body === undefined ? "" : JSON.stringify(body), { status }),
    );
  }) as typeof fetch;
  return { calls, fetcher };
}
const image = `us-central1-docker.pkg.dev/embody-cloud/builds/ws/app@sha256:${"a".repeat(64)}`;
const options = (fetcher: typeof fetch) => ({
  project: "embody-cloud",
  region: "us-central1",
  projectNumber: "123456789012",
  prefix: "emb",
  accessToken: () => Promise.resolve("controller-token"),
  fetch: fetcher,
});
const signal = new AbortController().signal;
const spec = {
  name: "emb-cabc",
  image,
  serviceAccount: "emb-a1@embody-cloud.iam.gserviceaccount.com",
  labels: { "embody-platform": "emb", "embody-role": "candidate", "embody-owner": "abc" },
  annotations: { "embody.dev/workspace": "ws_aaaaaaaa" },
  env: [
    { name: "NODE_ENV", value: "production" },
    { name: "DATABASE_URL", secret: { secret: "emb-a1-db", version: "latest" } },
  ],
  maxInstances: 3,
  cloudSqlConnection: "embody-cloud:us-central1:embody",
};

describe("M13 Google Cloud release adapter request shapes", () => {
  it("creates a min-zero candidate from the digest with secret env and Cloud SQL, adopting 409", async () => {
    const { calls, fetcher } = fakeFetch(() => ({ status: 409 }));
    await new GoogleReleaseProvider(options(fetcher)).create(spec, signal);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.method).toBe("POST");
    expect(call!.url).toBe(
      "https://run.googleapis.com/v2/projects/embody-cloud/locations/us-central1/services?serviceId=emb-cabc",
    );
    expect(call!.auth).toBe("Bearer controller-token");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- request body under inspection
    const body = call!.body as Record<string, any>;
    expect(body["labels"]).toEqual(spec.labels);
    expect(body["template"]["scaling"]).toEqual({ minInstanceCount: 0, maxInstanceCount: 3 });
    expect(body["template"]["serviceAccount"]).toBe(spec.serviceAccount);
    expect(body["template"]["containers"][0]["image"]).toBe(image);
    expect(body["template"]["containers"][0]["env"]).toEqual([
      { name: "NODE_ENV", value: "production" },
      {
        name: "DATABASE_URL",
        valueSource: { secretKeyRef: { secret: "emb-a1-db", version: "latest" } },
      },
    ]);
    expect(body["template"]["volumes"]).toEqual([
      { name: "cloudsql", cloudSqlInstance: { instances: ["embody-cloud:us-central1:embody"] } },
    ]);
    await expect(
      new GoogleReleaseProvider(options(fetcher)).create(
        { ...spec, image: "repo/app:latest" },
        signal,
      ),
    ).rejects.toBeInstanceOf(ReleaseProviderError);
  });

  it("reads readiness from provider conditions and only reports the deterministic endpoint", () => {
    const endpoint = "https://emb-cabc-123456789012.us-central1.run.app";
    const service = {
      name: "projects/embody-cloud/locations/us-central1/services/emb-cabc",
      urls: [endpoint, "https://emb-cabc-xyz-uc.a.run.app"],
      template: { containers: [{ image }] },
      labels: spec.labels,
      annotations: spec.annotations,
      latestCreatedRevision: "r2",
      latestReadyRevision: "r2",
      terminalCondition: { state: "CONDITION_SUCCEEDED" },
      reconciling: false,
    };
    expect(GoogleReleaseProvider.stateOf(service, endpoint)).toMatchObject({
      name: "emb-cabc",
      endpoint,
      image,
      status: "ready",
    });
    expect(
      GoogleReleaseProvider.stateOf({ ...service, latestReadyRevision: "r1" }, endpoint).status,
    ).toBe("pending");
    expect(GoogleReleaseProvider.stateOf({ ...service, reconciling: true }, endpoint).status).toBe(
      "pending",
    );
    expect(
      GoogleReleaseProvider.stateOf(
        { ...service, terminalCondition: { state: "CONDITION_FAILED" } },
        endpoint,
      ).status,
    ).toBe("failed");
    expect(
      GoogleReleaseProvider.stateOf({ ...service, urls: [] }, endpoint).endpoint,
    ).toBeUndefined();
  });

  it("sets exactly the given invokers, lists only this platform's candidates, deletes idempotently", async () => {
    const { calls, fetcher } = fakeFetch((call) =>
      call.method === "GET"
        ? {
            status: 200,
            body: {
              services: [
                { name: "x/services/emb-c1", labels: { "embody-platform": "emb" } },
                { name: "x/services/gateway", labels: {} },
                { name: "x/services/oth-c1", labels: { "embody-platform": "oth" } },
              ],
            },
          }
        : call.method === "DELETE"
          ? { status: 404 }
          : { status: 200, body: {} },
    );
    const provider = new GoogleReleaseProvider(options(fetcher));
    await provider.setInvokers("emb-cabc", ["serviceAccount:b@x", "serviceAccount:a@x"], signal);
    expect(calls[0]!.url).toMatch(/services\/emb-cabc:setIamPolicy$/);
    expect(calls[0]!.body).toEqual({
      policy: {
        bindings: [
          { role: "roles/run.invoker", members: ["serviceAccount:a@x", "serviceAccount:b@x"] },
        ],
      },
    });
    expect((await provider.list(signal)).map((state) => state.name)).toEqual(["emb-c1"]);
    await provider.remove("emb-cabc", signal);
    await expect(
      new GoogleReleaseProvider(options(fakeFetch(() => ({ status: 500 })).fetcher)).remove(
        "x",
        signal,
      ),
    ).rejects.toBeInstanceOf(ReleaseProviderError);
  });

  it("identities and secrets: create is pending until propagated; payloads are written, never read", async () => {
    const { calls, fetcher } = fakeFetch((call) => {
      if (call.url.includes("/serviceAccounts/") && call.method === "GET") return { status: 404 };
      if (call.url.endsWith("/versions/latest"))
        return {
          status: 200,
          body: { name: "projects/p/secrets/emb-a1-db/versions/7", state: "ENABLED" },
        };
      if (call.url.endsWith(":addVersion"))
        return { status: 200, body: { name: "projects/p/secrets/emb-a1-db/versions/8" } };
      if (call.url.includes("/secrets/emb-a1-db") && call.method === "GET") return { status: 404 };
      return { status: 200, body: {} };
    });
    const provider = new GoogleReleaseProvider(options(fetcher));
    expect(await provider.ensureAccount("emb-a1", "runtime", signal)).toBe("pending");
    expect(calls[1]!.body).toEqual({
      accountId: "emb-a1",
      serviceAccount: { displayName: "runtime" },
    });
    await provider.ensureSecret("emb-a1-db", "emb-a1@embody-cloud.iam.gserviceaccount.com", signal);
    const policy = calls.find((call) => call.url.endsWith("emb-a1-db:setIamPolicy"))!;
    expect(policy.body).toEqual({
      policy: {
        bindings: [
          {
            role: "roles/secretmanager.secretAccessor",
            members: ["serviceAccount:emb-a1@embody-cloud.iam.gserviceaccount.com"],
          },
        ],
      },
    });
    expect(await provider.latestSecretVersion("emb-a1-db", signal)).toBe("7");
    expect(await provider.addSecretVersion("emb-a1-db", "postgresql://u:p@/db", signal)).toBe("8");
    // The controller never reads a payload (`:access`).
    expect(calls.some((call) => call.url.includes(":access"))).toBe(false);
  });

  it("grants the runtime Cloud SQL client for the one instance, etag-guarded, once", async () => {
    let policy: Record<string, unknown> = {
      etag: "BwX1",
      version: 3,
      bindings: [
        { role: "roles/viewer", members: ["user:a@example.com"] },
        { role: "roles/cloudsql.client", members: ["serviceAccount:x@p"] },
      ],
    };
    const { calls, fetcher } = fakeFetch((call) => {
      if (call.url.endsWith(":getIamPolicy")) return { status: 200, body: policy };
      policy = (call.body as { policy: Record<string, unknown> }).policy;
      return { status: 200, body: policy };
    });
    const provider = new GoogleReleaseProvider({ ...options(fetcher), sqlInstance: "embody" });
    const email = "emb-a1@embody-cloud.iam.gserviceaccount.com";
    await provider.ensureDatabaseClient(email, signal);
    await provider.ensureDatabaseClient(email, signal);
    const writes = calls.filter((call) => call.url.endsWith(":setIamPolicy"));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toBe(
      "https://cloudresourcemanager.googleapis.com/v1/projects/embody-cloud:setIamPolicy",
    );
    expect(policy).toMatchObject({ etag: "BwX1", version: 3 });
    expect(policy["bindings"]).toEqual([
      { role: "roles/viewer", members: ["user:a@example.com"] },
      // An unconditional binding someone else made is never extended.
      { role: "roles/cloudsql.client", members: ["serviceAccount:x@p"] },
      {
        role: "roles/cloudsql.client",
        members: [`serviceAccount:${email}`],
        condition: {
          title: "embody app runtimes: shared instance only",
          expression: 'resource.name == "projects/embody-cloud/instances/embody"',
        },
      },
    ]);
  });

  it("lists every page of services (review B2) and keeps only this platform's candidates", async () => {
    let page = 0;
    const { calls, fetcher } = fakeFetch(() => {
      page += 1;
      return page === 1
        ? {
            status: 200,
            body: {
              services: Array.from({ length: 200 }, (_, i) => ({
                name: `x/services/other-${i}`,
                labels: {},
              })),
              nextPageToken: "p2",
            },
          }
        : {
            status: 200,
            body: {
              services: [{ name: "x/services/emb-corphan", labels: { "embody-platform": "emb" } }],
            },
          };
    });
    const states = await new GoogleReleaseProvider(options(fetcher)).list(signal);
    expect(states.map((state) => state.name)).toEqual(["emb-corphan"]);
    expect(calls.map((call) => call.url.split("?")[1])).toEqual([
      "pageSize=200",
      "pageSize=200&pageToken=p2",
    ]);
  });

  it("wake route: adds the app invoker to the worker's run.invoker once; mints ID tokens", async () => {
    let policy: Record<string, unknown> = {
      bindings: [{ role: "roles/run.invoker", members: ["serviceAccount:i@p"] }],
    };
    const { calls, fetcher } = fakeFetch((call) => {
      if (call.url.endsWith(":getIamPolicy")) return { status: 200, body: policy };
      if (call.url.endsWith(":generateIdToken"))
        return { status: 200, body: { token: "id-token" } };
      policy = (call.body as { policy: Record<string, unknown> }).policy;
      return { status: 200, body: policy };
    });
    const provider = new GoogleReleaseProvider({ ...options(fetcher), wakeService: "worker" });
    await provider.ensureWakeRoute("emb-w1@embody-cloud.iam.gserviceaccount.com", signal);
    await provider.ensureWakeRoute("emb-w1@embody-cloud.iam.gserviceaccount.com", signal);
    expect(calls.filter((call) => call.url.endsWith("services/worker:setIamPolicy"))).toHaveLength(
      1,
    );
    expect(policy["bindings"]).toEqual([
      {
        role: "roles/run.invoker",
        members: [
          "serviceAccount:i@p",
          "serviceAccount:emb-w1@embody-cloud.iam.gserviceaccount.com",
        ],
      },
    ]);
    expect(
      await provider.mintIdToken("emb-w1@x", "https://worker/_embody/wake/ws_a/app_b", signal),
    ).toBe("id-token");
    expect(calls.at(-1)!.body).toEqual({
      audience: "https://worker/_embody/wake/ws_a/app_b",
      includeEmail: true,
    });
  });

  it("health probe: invoker token for the exact origin, ready only on ready:true, bounded", async () => {
    const endpoint = "https://emb-cabc-123456789012.us-central1.run.app";
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "https://accounts.google.com",
      aud: endpoint,
      email: "ctl@embody-cloud.iam.gserviceaccount.com",
      email_verified: true,
      iat: now,
      exp: now + 3600,
    };
    const token = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
    let health: unknown = { live: true, ready: true };
    const seen: string[] = [];
    const fetcher = ((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith("http://metadata.google.internal"))
        return Promise.resolve(new Response(token, { headers: { "metadata-flavor": "Google" } }));
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      return Promise.resolve(new Response(JSON.stringify(health)));
    }) as typeof fetch;
    const probe = cloudRunHealthProbe({
      serviceAccountEmail: "ctl@embody-cloud.iam.gserviceaccount.com",
      fetch: fetcher,
    });
    expect(await probe.ready(endpoint, signal)).toBe(true);
    expect(seen.at(-1)).toBe(`${endpoint}/health`);
    health = { live: true, ready: false };
    expect(await probe.ready(endpoint, signal)).toBe(false);
    health = { ready: true, padding: "x".repeat(5000) };
    expect(await probe.ready(endpoint, signal)).toBe(false);
    expect(await probe.ready("https://evil.example.com", signal)).toBe(false);
  });
});
