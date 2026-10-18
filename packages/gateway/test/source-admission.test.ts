import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOURCE_ADMISSION,
  createSourceArchive,
  rawTarEntry,
  type DeploymentSubmission,
  type SourceStatus,
} from "@embody/cloud-contracts";
import {
  DispatchRateLimitedError,
  MemoryGatewayStore,
  MemorySourceObjectStore,
  SourceAdmissionError,
  createWorkspaceGateway,
  newCredential,
  purgeExpiredSources,
  verifySubmissionSource,
} from "../src/index.js";
import { signingIdentity } from "./signing-fixture.js";
import { appRecord, credentialInput } from "./store-conformance.js";
import { sourceStoreConformance } from "./source-store-conformance.js";

sourceStoreConformance("memory source store", () => Promise.resolve(new MemoryGatewayStore()));

const APP = "app_kanban0001";
const OTHER_APP = "app_other00001";
const text = (value: string) => new TextEncoder().encode(value);
const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const CANARY = "EMBODY_CANARY_SECRET_c0ffee11";
const base = [
  { path: "package.json", content: text('{"name":"kanban"}') },
  { path: "embody.config.ts", content: text("export default {};\n") },
];
const validArchive = (extra = "") =>
  createSourceArchive([...base, { path: "src/index.ts", content: text(`export {};${extra}\n`) }]);
const tar = (...entries: Buffer[]) =>
  gzipSync(
    Buffer.concat([
      ...base.map((f) => rawTarEntry(f.path, f.content)),
      ...entries,
      Buffer.alloc(1024),
    ]),
  );

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture() {
  let now = new Date("2030-01-01T00:00:00.000Z");
  const clock = { now: () => now };
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const workspace = `ws_${randomUUID().replaceAll("-", "")}`;
  const otherWorkspace = `ws_${randomUUID().replaceAll("-", "")}`;
  const store = new MemoryGatewayStore();
  await store.createWorkspace(workspace);
  await store.createWorkspace(otherWorkspace);
  await store.putApp(appRecord(workspace), null);
  await store.putApp(
    {
      ...appRecord(workspace, "https://two.example.com"),
      appId: OTHER_APP,
      registration: {
        ...appRecord(workspace, "https://two.example.com").registration,
        appId: "other",
      },
    },
    null,
  );
  await store.putApp(appRecord(otherWorkspace), null);
  const issue = async (
    ws: string,
    grants: Array<{ appId: string; role: "deployer" | "operator" | "app-caller" }>,
  ) => {
    const issued = newCredential({
      ...credentialInput(ws),
      grants: grants.map((g) => ({ workspaceId: ws, ...g })),
    });
    await store.putCredential(issued.credential, null);
    return issued.token;
  };
  const deployer = await issue(workspace, [{ appId: APP, role: "deployer" }]);
  const caller = await issue(workspace, [{ appId: APP, role: "app-caller" }]);
  const otherAppDeployer = await issue(workspace, [{ appId: OTHER_APP, role: "deployer" }]);
  const foreignDeployer = await issue(otherWorkspace, [{ appId: APP, role: "deployer" }]);
  const objects = new MemorySourceObjectStore({ clock });
  const gateway = createWorkspaceGateway({
    store,
    token: signingIdentity,
    clock,
    sources: { objects },
  });
  closers.push(
    () => gateway.close(),
    () => store.close(),
  );
  const path = (ws = workspace, app = APP) => `/v1/workspaces/${ws}/apps/${app}/sources`;
  const request = (archive: Uint8Array, key = `sha256_${sha(archive).slice(7)}`) => ({
    version: 1,
    workspaceId: workspace,
    appId: APP,
    idempotencyKey: key,
    format: "embody-source-v1",
    digest: sha(archive),
    bytes: archive.byteLength,
  });
  const create = async (body: unknown, token = deployer, url = path()) =>
    gateway.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: body as object,
    });
  const complete = async (uploadId: string, token = deployer, url = path()) =>
    gateway.inject({
      method: "POST",
      url: `${url}/${uploadId}/complete`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: "{}",
    });
  const put = (status: SourceStatus, body: Uint8Array | ReadableStream<Uint8Array>) =>
    objects.fetch(status.upload!.url, {
      method: "PUT",
      headers: status.upload!.headers,
      body,
      // Node fetch requires half-duplex for streaming request bodies.
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    });
  /** Full happy-path admission; returns the final status. */
  const admit = async (archive: Uint8Array) => {
    const created = await create(request(archive));
    expect([200, 201]).toContain(created.statusCode);
    const status = created.json<SourceStatus>();
    if (status.state === "pending") expect((await put(status, archive)).status).toBe(200);
    return complete(status.uploadId);
  };
  return {
    workspace,
    otherWorkspace,
    store,
    objects,
    gateway,
    deployer,
    caller,
    otherAppDeployer,
    foreignDeployer,
    path,
    request,
    create,
    complete,
    put,
    admit,
    advance,
    clock,
  };
}

describe("authenticated source admission API (M10)", () => {
  it("issues bounded workspace-bound upload access, verifies digest/size and persists identity", async () => {
    const f = await fixture();
    const archive = validArchive();
    const created = await f.create(f.request(archive));
    expect(created.statusCode).toBe(201);
    const status = created.json<SourceStatus>();
    expect(status).toMatchObject({ state: "pending", attempt: 1, bytes: archive.byteLength });
    expect(status.upload!.headers).toEqual({
      "content-type": "application/gzip",
      "x-goog-content-length-range": `${archive.byteLength},${archive.byteLength}`,
      "x-goog-if-generation-match": "0",
    });
    expect(Date.parse(status.upload!.expiresAt) - f.clock.now().getTime()).toBe(
      SOURCE_ADMISSION.uploadAccessSeconds * 1000,
    );
    expect(new URL(status.upload!.url).pathname).toContain(
      `/sources/${f.workspace}/${APP}/${status.uploadId}.tar.gz`,
    );
    expect((await f.put(status, archive)).status).toBe(200);
    const done = await f.complete(status.uploadId);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ state: "verified", files: 3, uploadId: status.uploadId });
    expect(done.json<SourceStatus>().treeDigest).toMatch(/^sha256:/);
    expect(done.json<SourceStatus>().upload).toBeUndefined();
    const read = await f.gateway.inject({
      method: "GET",
      url: `${f.path()}/${status.uploadId}`,
      headers: { authorization: `Bearer ${f.deployer}` },
    });
    expect(read.json()).toMatchObject({ state: "verified" });
    const replay = await f.create(f.request(archive));
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ uploadId: status.uploadId, state: "verified" });
    expect(replay.json<SourceStatus>().upload).toBeUndefined();
    // Persisted record carries retention metadata; responses never expose object keys.
    const record = await f.store.source(f.workspace, APP, status.uploadId);
    expect(record).toMatchObject({ actorId: "alice", state: "verified" });
    expect(JSON.stringify(done.json())).not.toContain("objectKey");
  });

  it("verifies hostile configuration and lifecycle scripts as inert data, never evaluating them", async () => {
    const f = await fixture();
    const dir = await mkdtemp(join(tmpdir(), "embody-m10-marker-"));
    closers.push(() => rm(dir, { recursive: true, force: true }));
    const marker = join(dir, "evaluated");
    const payload = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");`;
    const archive = createSourceArchive([
      {
        path: "package.json",
        content: text(
          JSON.stringify({
            name: "x",
            scripts: { preinstall: `touch ${marker}`, postinstall: `touch ${marker}` },
          }),
        ),
      },
      { path: "embody.config.ts", content: text(`${payload}\nexport default {};\n`) },
      { path: "src/index.ts", content: text(payload) },
    ]);
    expect((await f.admit(archive)).json()).toMatchObject({ state: "verified", files: 3 });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("authorizes deployment and quota before allocating any upload capacity", async () => {
    const f = await fixture();
    const access = vi.spyOn(f.objects, "createUploadAccess");
    const admitSource = vi.spyOn(f.store, "admitSource");
    const body = f.request(validArchive());
    const caller = await f.create(body, f.caller);
    expect(caller.statusCode).toBe(403);
    expect(caller.json()).toEqual({ error: { code: "FORBIDDEN", message: "Permission denied." } });
    expect((await f.create(body, f.otherAppDeployer)).statusCode).toBe(404);
    expect((await f.create(body, f.foreignDeployer)).statusCode).toBe(401);
    expect((await f.create(body, "not-a-token")).statusCode).toBe(401);
    expect((await f.create({ ...body, workspaceId: f.otherWorkspace })).statusCode).toBe(400);
    expect((await f.create({ ...body, extra: 1 })).statusCode).toBe(400);
    expect(
      (await f.create({ ...body, bytes: SOURCE_ADMISSION.maxSourceBytes + 1 })).statusCode,
    ).toBe(400);
    const large = await f.create({ ...body, padding: "x".repeat(20_000) });
    expect(large.statusCode).toBe(413);
    vi.spyOn(f.store, "admit").mockRejectedValueOnce(new DispatchRateLimitedError(7));
    const limited = await f.create(body);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("7");
    expect(limited.json()).toMatchObject({ error: { code: "LIMIT_EXCEEDED" } });
    expect(admitSource).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    // Per-app pending upload quota.
    for (let i = 0; i < SOURCE_ADMISSION.maxPendingUploadsPerApp; i += 1)
      expect((await f.create(f.request(validArchive(`//${i}`)))).statusCode).toBe(201);
    const overflow = await f.create(f.request(validArchive("//overflow")));
    expect(overflow.statusCode).toBe(429);
    expect(access).toHaveBeenCalledTimes(SOURCE_ADMISSION.maxPendingUploadsPerApp);
    const disabled = await f.store.snapshot(f.workspace);
    const app = disabled!.apps.find((a) => a.appId === APP)!;
    await f.store.putApp({ ...app, state: "disabled" }, app.revision);
    expect((await f.create(f.request(validArchive("//d")))).statusCode).toBe(403);
  });

  it("rejects expired and foreign upload access; restarts reuse the same identity", async () => {
    const f = await fixture();
    const archive = validArchive();
    const first = (await f.create(f.request(archive))).json<SourceStatus>();
    f.advance(SOURCE_ADMISSION.uploadAccessSeconds * 1000 + 1);
    expect((await f.put(first, archive)).status).toBe(400);
    expect(f.objects.keys()).toEqual([]);
    expect((await f.complete(first.uploadId)).json()).toMatchObject({
      error: { code: "UPLOAD_INCOMPLETE" },
    });
    const second = await f.create(f.request(archive));
    expect(second.statusCode).toBe(200);
    const renewed = second.json<SourceStatus>();
    expect(renewed.uploadId).toBe(first.uploadId);
    expect(renewed.upload!.url).not.toBe(first.upload!.url);
    // Foreign access: another key, another size, tampered headers, or a read attempt.
    const other = (await f.create(f.request(validArchive("//other")))).json<SourceStatus>();
    const swapped = new URL(renewed.upload!.url);
    swapped.pathname = new URL(other.upload!.url).pathname;
    expect(
      (
        await f.objects.fetch(swapped, {
          method: "PUT",
          headers: renewed.upload!.headers,
          body: archive,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.objects.fetch(renewed.upload!.url, {
          method: "PUT",
          headers: { ...renewed.upload!.headers, "x-goog-content-length-range": "1,99999999" },
          body: archive,
        })
      ).status,
    ).toBe(403);
    expect((await f.objects.fetch(renewed.upload!.url, { method: "GET" })).status).toBe(403);
    expect(
      (await f.put(renewed, Buffer.concat([Buffer.from(archive), Buffer.from("x")]))).status,
    ).toBe(400);
    expect((await f.put(renewed, archive)).status).toBe(200);
    expect((await f.put(renewed, archive)).status).toBe(412);
    expect((await f.complete(first.uploadId)).json()).toMatchObject({ state: "verified" });
  });

  it("rejects digest and size mismatches, deletes the bytes and allows bounded retries", async () => {
    const f = await fixture();
    const archive = validArchive();
    const status = (await f.create(f.request(archive))).json<SourceStatus>();
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect((await f.put(status, tampered)).status).toBe(200);
    const mismatch = await f.complete(status.uploadId);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({
      error: { code: "DIGEST_MISMATCH" },
      source: { state: "rejected", uploadId: status.uploadId },
    });
    expect(f.objects.keys()).toEqual([]);
    const retry = (await f.create(f.request(archive))).json<SourceStatus>();
    expect(retry).toMatchObject({ uploadId: status.uploadId, state: "pending", attempt: 2 });
    const record = await f.store.source(f.workspace, APP, status.uploadId);
    f.objects.putRaw(record!.objectKey, Buffer.concat([Buffer.from(archive), Buffer.from("tail")]));
    expect((await f.complete(status.uploadId)).json()).toMatchObject({
      error: { code: "SIZE_MISMATCH" },
    });
    expect(f.objects.keys()).toEqual([]);
  });

  it.each([
    ["traversal", () => tar(rawTarEntry("../../escape.ts", text("x"))), "UNSAFE_ENTRY"],
    [
      "symlink escape",
      () => tar(rawTarEntry("src/l", text(""), { type: "2", linkname: "/" })),
      "UNSAFE_ENTRY",
    ],
    [
      "hard link",
      () => tar(rawTarEntry("src/h.ts", text(""), { type: "1", linkname: "/etc/passwd" })),
      "UNSAFE_ENTRY",
    ],
    [
      "compression bomb",
      () =>
        createSourceArchive([
          ...base,
          { path: "src/zero.txt", content: new Uint8Array(30 * 1024 * 1024) },
        ]),
      "ARCHIVE_LIMIT",
    ],
    [
      "excessive files",
      () =>
        createSourceArchive([
          ...base,
          ...Array.from({ length: SOURCE_ADMISSION.maxSourceFiles + 1 }, (_, i) => ({
            path: `src/f${i}.ts`,
            content: text(`export const v${i}=${i};`),
          })),
        ]),
      "ARCHIVE_LIMIT",
    ],
    ["env file", () => tar(rawTarEntry(".env", text(`TOKEN=${CANARY}`))), "FORBIDDEN_FILE"],
    ["local database", () => tar(rawTarEntry("src/app.sqlite", text(CANARY))), "FORBIDDEN_FILE"],
    ["not an archive", () => text("#!/bin/sh\nrm -rf /\n"), "ARCHIVE_INVALID"],
  ])("rejects %s before any code could execute", async (_name, build, code) => {
    const f = await fixture();
    const archive = build();
    const response = await f.admit(archive);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code }, source: { state: "rejected" } });
    expect(response.body).not.toContain(CANARY);
    expect(f.objects.keys()).toEqual([]);
    const uploadId = response.json<{ source: SourceStatus }>().source.uploadId;
    const submission = {
      workspaceId: f.workspace,
      appId: APP,
      source: { uploadId, digest: sha(archive), bytes: archive.byteLength },
    } as DeploymentSubmission;
    await expect(verifySubmissionSource(f.store, submission, f.clock.now())).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("restarts an interrupted upload without an unintended build and denies cross-workspace access (M10.c)", async () => {
    const f = await fixture();
    const archive = validArchive();
    const status = (await f.create(f.request(archive))).json<SourceStatus>();
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(archive.subarray(0, 64));
        controller.error(new Error("connection reset"));
      },
    });
    await expect(f.put(status, interrupted)).rejects.toThrow();
    expect(f.objects.keys()).toEqual([]);
    expect((await f.complete(status.uploadId)).statusCode).toBe(409);
    const submission = (uploadId: string, overrides: Partial<DeploymentSubmission> = {}) =>
      ({
        workspaceId: f.workspace,
        appId: APP,
        source: { uploadId, digest: status.digest, bytes: status.bytes },
        ...overrides,
      }) as DeploymentSubmission;
    await expect(
      verifySubmissionSource(f.store, submission(status.uploadId), f.clock.now()),
    ).rejects.toBeInstanceOf(SourceAdmissionError);
    const again = (await f.create(f.request(archive))).json<SourceStatus>();
    expect(again.uploadId).toBe(status.uploadId);
    expect((await f.put(again, archive)).status).toBe(200);
    expect((await f.complete(again.uploadId)).json()).toMatchObject({ state: "verified" });
    await expect(
      verifySubmissionSource(f.store, submission(status.uploadId), f.clock.now()),
    ).resolves.toMatchObject({
      uploadId: status.uploadId,
    });
    await expect(
      verifySubmissionSource(
        f.store,
        submission(status.uploadId, {
          source: {
            uploadId: status.uploadId,
            digest: `sha256:${"0".repeat(64)}`,
            bytes: status.bytes,
          },
        }),
        f.clock.now(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      verifySubmissionSource(
        f.store,
        submission(status.uploadId, { appId: OTHER_APP } as never),
        f.clock.now(),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      verifySubmissionSource(
        f.store,
        submission(status.uploadId, { workspaceId: f.otherWorkspace } as never),
        f.clock.now(),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Another workspace (its own app path) and another app's deployer cannot see or complete it.
    const foreignPath = f.path(f.otherWorkspace, APP);
    expect((await f.complete(status.uploadId, f.foreignDeployer, foreignPath)).statusCode).toBe(
      404,
    );
    expect(
      (
        await f.gateway.inject({
          method: "GET",
          url: `${foreignPath}/${status.uploadId}`,
          headers: { authorization: `Bearer ${f.foreignDeployer}` },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await f.complete(status.uploadId, f.otherAppDeployer, f.path(f.workspace, OTHER_APP)))
        .statusCode,
    ).toBe(404);
    expect((await f.complete(status.uploadId, f.foreignDeployer)).statusCode).toBe(401);
    expect((await f.complete(status.uploadId, f.caller)).statusCode).toBe(403);
    expect(
      (
        await f.gateway.inject({
          method: "GET",
          url: `${f.path()}/${status.uploadId}`,
          headers: { authorization: `Bearer ${f.caller}` },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("fails closed on storage and store outages and never echoes credentials", async () => {
    const f = await fixture();
    const archive = validArchive();
    const admit = vi.spyOn(f.store, "admit");
    vi.spyOn(f.objects, "createUploadAccess").mockRejectedValueOnce(
      new Error(`provider said ${f.deployer} https://storage/?sig=abc`),
    );
    const outage = await f.create(f.request(archive));
    expect(outage.statusCode).toBe(503);
    expect(outage.json()).toEqual({
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "Source storage unavailable; retry with the same upload key.",
      },
    });
    expect(outage.body).not.toContain(f.deployer);
    const ok = (await f.create(f.request(archive))).json<SourceStatus>();
    expect(ok.state).toBe("pending");
    vi.spyOn(f.objects, "stat").mockRejectedValueOnce(new Error("timeout"));
    expect((await f.complete(ok.uploadId)).statusCode).toBe(503);
    vi.spyOn(f.store, "admitSource").mockRejectedValueOnce(new Error("db down"));
    expect((await f.create(f.request(archive))).statusCode).toBe(503);
    const audits = JSON.stringify(admit.mock.calls);
    expect(audits).toContain("source.create");
    expect(audits).not.toContain(f.deployer);
    expect(audits).not.toContain("sig=");
  });

  it("settles concurrent completions to one verified record", async () => {
    const f = await fixture();
    const archive = validArchive();
    const status = (await f.create(f.request(archive))).json<SourceStatus>();
    await f.put(status, archive);
    const results = await Promise.all([f.complete(status.uploadId), f.complete(status.uploadId)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results.map((r) => r.json<SourceStatus>().state)).toEqual(["verified", "verified"]);
  });

  it("purges expired unpinned sources and their objects after retention", async () => {
    const f = await fixture();
    const archive = validArchive();
    const done = (await f.admit(archive)).json<SourceStatus>();
    const record = (await f.store.source(f.workspace, APP, done.uploadId))!;
    const pinnedArchive = validArchive("//pinned");
    const pinned = (await f.admit(pinnedArchive)).json<SourceStatus>();
    const pinnedRecord = (await f.store.source(f.workspace, APP, pinned.uploadId))!;
    await f.store.updateSource(
      { ...pinnedRecord, pinnedBy: "dep_aaaaaaaa" },
      pinnedRecord.revision,
    );
    f.objects.putRaw(record.objectKey, archive);
    f.objects.putRaw(pinnedRecord.objectKey, pinnedArchive);
    expect(
      await purgeExpiredSources({ store: f.store, objects: f.objects, now: f.clock.now() }),
    ).toEqual({
      deleted: 0,
      failed: 0,
    });
    const after = new Date(Date.parse(record.retainUntil));
    expect(await purgeExpiredSources({ store: f.store, objects: f.objects, now: after })).toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(await f.store.source(f.workspace, APP, done.uploadId)).toBeNull();
    expect(f.objects.keys()).toEqual([pinnedRecord.objectKey]);
  });
});
