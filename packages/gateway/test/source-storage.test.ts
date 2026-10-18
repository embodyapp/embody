import { createVerify, generateKeyPairSync, createSign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GcsSourceObjectStore, SourceStorageError, metadataAccessToken } from "../src/index.js";

const KEY = "sources/ws_aaaaaaaa/app_aaaaaaaa/src_aaaaaaaa.tar.gz";
const SIGNER = "embody-source-signer@embody-cloud.iam.gserviceaccount.com";
const TOKEN = "ya29.test-access-token-not-real";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function adapter(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(handler(url, init ?? {}));
  }) as unknown as typeof fetch;
  const store = new GcsSourceObjectStore({
    bucket: "embody-test-sources",
    signerEmail: SIGNER,
    accessToken: () => Promise.resolve(TOKEN),
    fetch: fetcher,
    now: () => new Date("2030-01-02T03:04:05.678Z"),
    timeoutMs: 1000,
  });
  return { store, calls };
}

describe("GCS source object store adapter", () => {
  it("produces a create-only, exact-size V4 signed PUT via IAM signBlob", async () => {
    const { store, calls } = adapter((url, init) => {
      expect(url.href).toBe(
        `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SIGNER)}:signBlob`,
      );
      const payload = Buffer.from(
        (JSON.parse(init.body as string) as { payload: string }).payload,
        "base64",
      );
      const signer = createSign("RSA-SHA256");
      signer.update(payload);
      return Response.json({ keyId: "k", signedBlob: signer.sign(privateKey).toString("base64") });
    });
    const request = {
      objectKey: KEY,
      bytes: 1234,
      contentType: "application/gzip",
      expiresAt: new Date("2030-01-02T03:14:05.678Z"),
    };
    const canonical = store.canonical(request);
    expect(canonical.canonicalRequest.split("\n")).toEqual([
      "PUT",
      `/embody-test-sources/${KEY}`,
      `X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=${encodeURIComponent(`${SIGNER}/20300102/auto/storage/goog4_request`)}&X-Goog-Date=20300102T030405Z&X-Goog-Expires=600&X-Goog-SignedHeaders=content-type%3Bhost%3Bx-goog-content-length-range%3Bx-goog-if-generation-match`,
      "content-type:application/gzip",
      "host:storage.googleapis.com",
      "x-goog-content-length-range:1234,1234",
      "x-goog-if-generation-match:0",
      "",
      "content-type;host;x-goog-content-length-range;x-goog-if-generation-match",
      "UNSIGNED-PAYLOAD",
    ]);
    const access = await store.createUploadAccess(request);
    expect(calls[0]!.init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(access.headers).toEqual({
      "content-type": "application/gzip",
      "x-goog-content-length-range": "1234,1234",
      "x-goog-if-generation-match": "0",
    });
    const url = new URL(access.url);
    const signature = url.searchParams.get("X-Goog-Signature")!;
    const verify = createVerify("RSA-SHA256");
    verify.update(canonical.stringToSign);
    expect(verify.verify(publicKey, Buffer.from(signature, "hex"))).toBe(true);
    expect(access.url).not.toContain(TOKEN);
    expect(() =>
      store.canonical({ ...request, expiresAt: new Date("2030-01-02T03:20:06Z") }),
    ).toThrow(SourceStorageError);
    expect(() => store.canonical({ ...request, objectKey: "sources/../x" })).toThrow(
      SourceStorageError,
    );
  });

  it("stats, reads pinned to generation with a byte bound, deletes idempotently", async () => {
    const { store, calls } = adapter((url, init) => {
      if (init.method === "DELETE") return new Response(null, { status: 404 });
      if (url.searchParams.get("alt") === "media")
        return new Response(
          new Uint8Array(url.searchParams.get("ifGenerationMatch") === "7" ? 10 : 50),
          {
            status: 206,
          },
        );
      if (url.pathname.endsWith(encodeURIComponent(KEY)))
        return Response.json({ size: "10", generation: "7" });
      return new Response(null, { status: 404 });
    });
    expect(await store.stat(KEY)).toEqual({ bytes: 10, generation: "7" });
    expect((await store.read(KEY, { generation: "7", maxBytes: 10 })).byteLength).toBe(10);
    expect(calls.at(-1)!.init.headers).toMatchObject({ range: "bytes=0-10" });
    await expect(store.read(KEY, { generation: "8", maxBytes: 10 })).rejects.toBeInstanceOf(
      SourceStorageError,
    );
    await expect(store.read(KEY, { generation: "x", maxBytes: 10 })).rejects.toBeInstanceOf(
      SourceStorageError,
    );
    await expect(store.delete(KEY)).resolves.toBeUndefined();
    expect(
      calls.every((c) => c.init.redirect === "error" && c.init.signal instanceof AbortSignal),
    ).toBe(true);
  });

  it("maps provider failures to opaque errors without tokens or provider text", async () => {
    const { store } = adapter(() => {
      throw new Error(`socket hang up ${TOKEN}`);
    });
    const error = await store.stat(KEY).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceStorageError);
    expect(String(error)).not.toContain(TOKEN);
    const missing = adapter(() => new Response(null, { status: 404 }));
    expect(await missing.store.stat(KEY)).toBeNull();
    const denied = adapter(() => new Response("forbidden", { status: 403 }));
    await expect(denied.store.stat(KEY)).rejects.toBeInstanceOf(SourceStorageError);
    await expect(
      denied.store.createUploadAccess({
        objectKey: KEY,
        bytes: 1,
        contentType: "application/gzip",
        expiresAt: new Date("2030-01-02T03:10:00Z"),
      }),
    ).rejects.toBeInstanceOf(SourceStorageError);
    expect(() => new GcsSourceObjectStore({ bucket: "Bad_Bucket", signerEmail: SIGNER })).toThrow(
      TypeError,
    );
    expect(
      () => new GcsSourceObjectStore({ bucket: "ok-bucket", signerEmail: "user@gmail.com" }),
    ).toThrow(TypeError);
  });

  it("uses only the metadata server for workload tokens and caches them", async () => {
    let calls = 0;
    const fetcher = ((_url: string, init: RequestInit) => {
      calls += 1;
      expect((init.headers as Record<string, string>)["Metadata-Flavor"]).toBe("Google");
      return Promise.resolve(
        Response.json(
          { access_token: "t1", expires_in: 3600 },
          { headers: { "metadata-flavor": "Google" } },
        ),
      );
    }) as unknown as typeof fetch;
    const token = metadataAccessToken(fetcher, () => 0);
    expect(await token()).toBe("t1");
    expect(await token()).toBe("t1");
    expect(calls).toBe(1);
    const spoofed = metadataAccessToken(() =>
      Promise.resolve(Response.json({ access_token: "x", expires_in: 1 })),
    );
    await expect(spoofed()).rejects.toBeInstanceOf(SourceStorageError);
  });
});
