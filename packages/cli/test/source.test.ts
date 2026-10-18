import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryGatewayStore,
  MemorySourceObjectStore,
  createWorkspaceGateway,
  hostedSigningIdentity,
  newCredential,
} from "@embody/gateway";
import { runCli } from "../src/index.js";

const CANARY = "EMBODY_CANARY_SECRET_d15ea5e5";
const APP = "app_kanban0001";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "embody-cli-m10-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "package.json": '{"name":"kanban","type":"module"}',
    "embody.config.ts": "export default {};\n",
    "src/index.ts": "export const ok = true;\n",
    ".env": `TOKEN=${CANARY}`,
    "credentials.json": `{"k":"${CANARY}"}`,
    "local.sqlite": CANARY,
    ".git/config": CANARY,
    "node_modules/x/index.js": CANARY,
    "dist/index.js": CANARY,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function io() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  return {
    io: { stdin: new PassThrough(), stdout, stderr },
    text: () => ({ out, err }),
  };
}

async function hosted() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const token = await hostedSigningIdentity({
    issuer: "cli-test",
    kid: "k1",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES256", use: "sig" }],
  });
  const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
  const store = new MemoryGatewayStore();
  await store.createWorkspace(workspace);
  await store.putApp(
    {
      workspaceId: workspace,
      appId: APP,
      activeRelease: null,
      state: "unavailable",
      registration: {
        protocolVersion: 1,
        appId: "kanban",
        version: "1.0.0",
        endpoint: "https://kanban.example.com",
        healthCheckUrl: "https://kanban.example.com/health",
        manifest: {
          protocolVersion: 1,
          plugins: [{ id: "kanban", version: "1.0.0" }],
          entities: {},
          actions: {},
          events: [],
        },
      },
    } as never,
    null,
  );
  const credential = async (role: "deployer" | "app-caller") => {
    const issued = newCredential({
      workspaceId: workspace,
      principal: { orgId: workspace, actorId: "alice", actorType: "human", roles: [], scopes: [] },
      grants: [{ workspaceId: workspace, appId: APP, role }],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await store.putCredential(issued.credential, null);
    return issued.token;
  };
  const deployer = await credential("deployer");
  const caller = await credential("app-caller");
  const objects = new MemorySourceObjectStore();
  const gateway = createWorkspaceGateway({ store, token, sources: { objects } });
  const base = await gateway.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(
    () => gateway.close(),
    () => store.close(),
  );
  const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
  let tamperNext = false;
  let failNextPut = false;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
    });
    if (request.url.startsWith(objects.origin)) {
      if (failNextPut) {
        failNextPut = false;
        throw new TypeError("fetch failed: connection reset");
      }
      if (tamperNext) {
        tamperNext = false;
        const body = Buffer.from(await request.arrayBuffer());
        body[body.length - 1] = body[body.length - 1]! ^ 0xff;
        return objects.fetch(request.url, { method: "PUT", headers: request.headers, body });
      }
      return objects.fetch(request);
    }
    return fetch(request);
  };
  return {
    workspace,
    store,
    objects,
    base,
    deployer,
    caller,
    requests,
    fetcher,
    tamper: () => (tamperNext = true),
    failPut: () => (failNextPut = true),
  };
}

describe("embody source (M10)", () => {
  it("packs with documented exclusions and never includes or prints secret contents", async () => {
    const root = await project();
    const out = join(root, "..", `${randomUUID()}.tar.gz`);
    cleanups.push(() => rm(out, { force: true }));
    const capture = io();
    const code = await runCli(["source", "pack", root, "--out", out, "--output", "json"], {
      io: capture.io,
      env: { EMBODY_CONFIG: join(root, "missing.json") },
    });
    expect(code).toBe(0);
    const result = JSON.parse(capture.text().out) as {
      included: string[];
      excludedPaths: Array<{ path: string; reason: string }>;
      digest: string;
    };
    expect(result.included).toEqual(["embody.config.ts", "package.json", "src/index.ts"]);
    expect(result.excludedPaths.map((e) => e.reason).sort()).toEqual(
      ["build-output", "credential", "dependencies", "env-file", "local-database", "vcs"].sort(),
    );
    const archive = await readFile(out);
    expect(gunzipSync(archive).includes(Buffer.from(CANARY))).toBe(false);
    expect(capture.text().out + capture.text().err).not.toContain(CANARY);
  });

  it("uploads, restarts an interrupted transfer and retries a corrupted one under one identity", async () => {
    const root = await project();
    const h = await hosted();
    h.failPut();
    const capture = io();
    const code = await runCli(
      ["source", "upload", root, "--workspace", h.workspace, "--app", APP, "--output", "json"],
      {
        io: capture.io,
        fetch: h.fetcher,
        env: {
          EMBODY_CONFIG: join(root, "missing.json"),
          EMBODY_GATEWAY_URL: h.base,
          EMBODY_TOKEN: h.deployer,
        },
      },
    );
    const { out, err } = capture.text();
    expect(err).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(out) as { uploadId: string; state: string; files: number };
    expect(result).toMatchObject({ state: "verified", files: 3 });
    // The Embody credential goes only to the gateway, never to storage; output has no secrets.
    const storage = h.requests.filter((r) => r.url.startsWith(h.objects.origin));
    expect(storage).toHaveLength(2);
    expect(storage.every((r) => r.authorization === null && r.method === "PUT")).toBe(true);
    for (const secret of [h.deployer, CANARY, "sig="]) expect(out + err).not.toContain(secret);
    // Only source endpoints were called: no deployment submission or build was requested.
    expect(
      h.requests.every((r) => r.url.startsWith(h.objects.origin) || r.url.includes("/sources")),
    ).toBe(true);
    expect(h.objects.keys()).toEqual([`sources/${h.workspace}/${APP}/${result.uploadId}.tar.gz`]);

    // Re-running is idempotent: same identity, nothing re-uploaded.
    h.requests.length = 0;
    const again = io();
    expect(
      await runCli(
        ["source", "upload", root, "--workspace", h.workspace, "--app", APP, "--output", "json"],
        {
          io: again.io,
          fetch: h.fetcher,
          env: {
            EMBODY_CONFIG: join(root, "missing.json"),
            EMBODY_GATEWAY_URL: h.base,
            EMBODY_TOKEN: h.deployer,
          },
        },
      ),
    ).toBe(0);
    expect(JSON.parse(again.text().out)).toMatchObject({ uploadId: result.uploadId });
    expect(h.requests.filter((r) => r.url.startsWith(h.objects.origin))).toHaveLength(0);

    // Corrupted bytes on the wire: digest mismatch, then a bounded retry of the same upload.
    await writeFile(join(root, "src", "index.ts"), "export const ok = 2;\n");
    h.tamper();
    const retry = io();
    expect(
      await runCli(
        ["source", "upload", root, "--workspace", h.workspace, "--app", APP, "--output", "json"],
        {
          io: retry.io,
          fetch: h.fetcher,
          env: {
            EMBODY_CONFIG: join(root, "missing.json"),
            EMBODY_GATEWAY_URL: h.base,
            EMBODY_TOKEN: h.deployer,
          },
        },
      ),
    ).toBe(0);
    const second = JSON.parse(retry.text().out) as { uploadId: string };
    expect(second.uploadId).not.toBe(result.uploadId);
    expect((await h.store.source(h.workspace, APP, second.uploadId))?.attempt).toBe(2);
  });

  it("maps authentication, permission and usage failures to exit codes", async () => {
    const root = await project();
    const h = await hosted();
    const run = async (args: string[], token?: string) => {
      const capture = io();
      const code = await runCli(["source", "upload", root, ...args], {
        io: capture.io,
        fetch: h.fetcher,
        env: {
          EMBODY_CONFIG: join(root, "missing.json"),
          EMBODY_GATEWAY_URL: h.base,
          ...(token ? { EMBODY_TOKEN: token } : {}),
        },
      });
      return { code, ...capture.text() };
    };
    expect((await run(["--workspace", h.workspace, "--app", APP], "wrong")).code).toBe(3);
    const forbidden = await run(["--workspace", h.workspace, "--app", APP], h.caller);
    expect(forbidden.code).toBe(4);
    expect(forbidden.err).not.toContain(h.caller);
    expect((await run(["--workspace", h.workspace, "--app", APP])).code).toBe(3);
    expect((await run(["--app", APP], h.deployer)).code).toBe(2);
    expect((await run(["--workspace", "bad", "--app", APP], h.deployer)).code).toBe(2);
    expect(h.objects.keys()).toEqual([]);
  });
});
