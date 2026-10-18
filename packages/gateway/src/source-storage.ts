import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SourceUploadAccess } from "@embody/cloud-contracts";

/** Object keys are derived server-side from the persisted source record, never from callers. */
export const SOURCE_OBJECT_KEY =
  /^sources\/ws_[a-z0-9]{8,64}\/app_[a-z0-9]{8,64}\/src_[a-z0-9]{8,64}\.tar\.gz$/;
export function sourceObjectKey(workspaceId: string, appId: string, uploadId: string): string {
  const key = `sources/${workspaceId}/${appId}/${uploadId}.tar.gz`;
  if (!SOURCE_OBJECT_KEY.test(key)) throw new TypeError("Invalid source object identity");
  return key;
}
export interface SourceUploadAccessRequest {
  readonly objectKey: string;
  readonly bytes: number;
  readonly contentType: string;
  readonly expiresAt: Date;
}
export interface SourceObjectInfo {
  readonly bytes: number;
  /** Opaque provider generation; reads are pinned to it. */
  readonly generation: string;
}
/**
 * Private source object storage. Upload access is a bearer capability: bounded to one object
 * key, exact size, create-only and a short expiry. Callers never get read or list access.
 */
export interface SourceObjectStore {
  createUploadAccess(request: SourceUploadAccessRequest): Promise<SourceUploadAccess>;
  stat(objectKey: string): Promise<SourceObjectInfo | null>;
  /** Must fail rather than return more than `maxBytes`. */
  read(objectKey: string, options: { generation: string; maxBytes: number }): Promise<Uint8Array>;
  /**
   * Idempotent: deleting a missing object succeeds. With `generation`, only that generation is
   * deleted; a newer object under the same key (a re-upload) is left in place.
   */
  delete(objectKey: string, options?: { generation?: string }): Promise<void>;
}
export class SourceStorageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SourceStorageError";
  }
}
function assertKey(key: string): void {
  if (!SOURCE_OBJECT_KEY.test(key)) throw new SourceStorageError("Invalid source object key");
}
function uploadHeaders(bytes: number, contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "x-goog-content-length-range": `${bytes},${bytes}`,
    "x-goog-if-generation-match": "0",
  };
}
async function bounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new SourceStorageError("Source object larger than expected");
  if (!response.body) return new Uint8Array();
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SourceStorageError("Source object larger than expected");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

/**
 * Local fake with GCS-like semantics for tests and development: HMAC-signed PUT URLs bound to
 * one key, exact length, content type, create-only and expiry. It serves only through `fetch`.
 */
export class MemorySourceObjectStore implements SourceObjectStore {
  public readonly origin: string;
  private readonly secret = randomBytes(32);
  private readonly objects = new Map<string, { data: Buffer; generation: string }>();
  private generation = 0;
  private readonly clock: { now(): Date };
  public constructor(options: { origin?: string; clock?: { now(): Date } } = {}) {
    this.origin = options.origin ?? "https://source-storage.test";
    this.clock = options.clock ?? { now: () => new Date() };
  }
  private sign(key: string, expires: string, headers: Record<string, string>): string {
    return createHmac("sha256", this.secret)
      .update(
        [
          "PUT",
          key,
          expires,
          headers["content-type"],
          headers["x-goog-content-length-range"],
          headers["x-goog-if-generation-match"],
        ].join("\n"),
      )
      .digest("hex");
  }
  public createUploadAccess(request: SourceUploadAccessRequest): Promise<SourceUploadAccess> {
    assertKey(request.objectKey);
    const headers = uploadHeaders(request.bytes, request.contentType);
    const expires = String(Math.floor(request.expiresAt.getTime() / 1000));
    const url = new URL(`${this.origin}/upload/${request.objectKey}`);
    url.searchParams.set("expires", expires);
    url.searchParams.set("sig", this.sign(request.objectKey, expires, headers));
    return Promise.resolve({
      method: "PUT",
      url: url.href,
      headers,
      expiresAt: request.expiresAt.toISOString(),
    });
  }
  public stat(objectKey: string): Promise<SourceObjectInfo | null> {
    assertKey(objectKey);
    const value = this.objects.get(objectKey);
    return Promise.resolve(
      value ? { bytes: value.data.length, generation: value.generation } : null,
    );
  }
  public read(
    objectKey: string,
    options: { generation: string; maxBytes: number },
  ): Promise<Uint8Array> {
    assertKey(objectKey);
    const value = this.objects.get(objectKey);
    if (!value || value.generation !== options.generation)
      return Promise.reject(new SourceStorageError("Source object generation changed"));
    if (value.data.length > options.maxBytes)
      return Promise.reject(new SourceStorageError("Source object larger than expected"));
    return Promise.resolve(Buffer.from(value.data));
  }
  public delete(objectKey: string, options: { generation?: string } = {}): Promise<void> {
    assertKey(objectKey);
    const value = this.objects.get(objectKey);
    if (value && (options.generation === undefined || value.generation === options.generation))
      this.objects.delete(objectKey);
    return Promise.resolve();
  }
  /** Test hooks: inspect keys or place bytes as a malicious/racing writer would. */
  public keys(): string[] {
    return [...this.objects.keys()].sort();
  }
  public putRaw(objectKey: string, data: Uint8Array): void {
    this.objects.set(objectKey, { data: Buffer.from(data), generation: String(++this.generation) });
  }
  /** Storage HTTP surface. Anything except a valid signed PUT is refused. */
  public readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const reply = (status: number, code: string) =>
      new Response(`<Error><Code>${code}</Code></Error>`, { status });
    if (url.origin !== this.origin || !url.pathname.startsWith("/upload/"))
      return reply(404, "NoSuchBucket");
    const key = decodeURIComponent(url.pathname.slice("/upload/".length));
    const expires = url.searchParams.get("expires") ?? "";
    const sig = url.searchParams.get("sig") ?? "";
    if (request.method !== "PUT" || !SOURCE_OBJECT_KEY.test(key) || !/^\d{1,12}$/.test(expires))
      return reply(403, "AccessDenied");
    const headers = {
      "content-type": request.headers.get("content-type") ?? "",
      "x-goog-content-length-range": request.headers.get("x-goog-content-length-range") ?? "",
      "x-goog-if-generation-match": request.headers.get("x-goog-if-generation-match") ?? "",
    };
    const expected = Buffer.from(this.sign(key, expires, headers), "hex");
    const actual = Buffer.from(/^[a-f0-9]{64}$/.test(sig) ? sig : "", "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return reply(403, "SignatureDoesNotMatch");
    if (Number(expires) * 1000 <= this.clock.now().getTime()) return reply(400, "ExpiredToken");
    const range = /^(\d+),(\d+)$/.exec(headers["x-goog-content-length-range"]);
    // Interrupted bodies reject here and nothing is stored, like a failed single-request PUT.
    const body = Buffer.from(await request.arrayBuffer());
    if (!range || body.length < Number(range[1]) || body.length > Number(range[2]))
      return reply(400, "EntityTooSmallOrLarge");
    if (headers["x-goog-if-generation-match"] === "0" && this.objects.has(key))
      return reply(412, "PreconditionFailed");
    this.putRaw(key, body);
    return new Response(null, { status: 200 });
  };
}

export interface GcsSourceObjectStoreOptions {
  readonly bucket: string;
  /** Service account whose IAM signBlob produces V4 signatures; no private keys are held. */
  readonly signerEmail: string;
  /** OAuth access token for storage JSON API and IAM credentials calls. */
  readonly accessToken?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}
const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
/** Workload identity token from the Cloud Run metadata server (never caller supplied). */
export function metadataAccessToken(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): () => Promise<string> {
  let cached: { token: string; expires: number } | undefined;
  return async () => {
    if (cached && cached.expires > now() + 60_000) return cached.token;
    const response = await fetcher(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: { "Metadata-Flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok || response.headers.get("metadata-flavor") !== "Google")
      throw new SourceStorageError("Workload identity unavailable");
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number")
      throw new SourceStorageError("Invalid workload identity response");
    cached = { token: body.access_token, expires: now() + body.expires_in * 1000 };
    return cached.token;
  };
}

/**
 * Google Cloud Storage adapter. Upload access is a V4 signed PUT URL (signed through IAM
 * signBlob) bound to one object, exact length (`x-goog-content-length-range`), create-only
 * (`x-goog-if-generation-match: 0`), content type and an expiry of at most 15 minutes.
 * Every provider call has a hard deadline.
 */
export class GcsSourceObjectStore implements SourceObjectStore {
  private readonly fetcher: typeof fetch;
  private readonly token: () => Promise<string>;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  public constructor(private readonly options: GcsSourceObjectStoreOptions) {
    if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(options.bucket))
      throw new TypeError("Invalid source bucket");
    if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(options.signerEmail))
      throw new TypeError("Source signer must be a service account");
    this.fetcher = options.fetch ?? fetch;
    this.token = options.accessToken ?? metadataAccessToken(this.fetcher);
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }
  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.token();
    try {
      return await this.fetcher(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Never surface provider text, URLs or tokens.
      throw new SourceStorageError("Source storage request failed");
    }
  }
  private objectUrl(key: string): string {
    return `https://storage.googleapis.com/storage/v1/b/${this.options.bucket}/o/${encodeURIComponent(key)}`;
  }
  /** Exposed for tests: the exact V4 canonical request and string to sign. */
  public canonical(request: SourceUploadAccessRequest): {
    url: URL;
    canonicalRequest: string;
    stringToSign: string;
    headers: Record<string, string>;
  } {
    assertKey(request.objectKey);
    const now = this.now();
    const seconds = Math.floor((request.expiresAt.getTime() - now.getTime()) / 1000);
    if (seconds < 1 || seconds > 900) throw new SourceStorageError("Invalid upload expiry");
    const stamp = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const date = stamp.slice(0, 8);
    const scope = `${date}/auto/storage/goog4_request`;
    const host = "storage.googleapis.com";
    const headers = uploadHeaders(request.bytes, request.contentType);
    const signed = { ...headers, host };
    const names = Object.keys(signed).sort();
    const signedHeaders = names.join(";");
    const path = `/${this.options.bucket}/${request.objectKey.split("/").map(rfc3986).join("/")}`;
    const query: Record<string, string> = {
      "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
      "X-Goog-Credential": `${this.options.signerEmail}/${scope}`,
      "X-Goog-Date": stamp,
      "X-Goog-Expires": String(seconds),
      "X-Goog-SignedHeaders": signedHeaders,
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((key) => `${rfc3986(key)}=${rfc3986(query[key]!)}`)
      .join("&");
    const canonicalHeaders = names
      .map((name) => `${name}:${signed[name as keyof typeof signed].trim()}\n`)
      .join("");
    const canonicalRequest = [
      "PUT",
      path,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "GOOG4-RSA-SHA256",
      stamp,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    return {
      url: new URL(`https://${host}${path}?${canonicalQuery}`),
      canonicalRequest,
      stringToSign,
      headers,
    };
  }
  public async createUploadAccess(request: SourceUploadAccessRequest): Promise<SourceUploadAccess> {
    const { url, stringToSign, headers } = this.canonical(request);
    const response = await this.call(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(this.options.signerEmail)}:signBlob`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: Buffer.from(stringToSign).toString("base64") }),
      },
    );
    if (!response.ok) throw new SourceStorageError("Upload signing unavailable");
    const body = (await response.json()) as { signedBlob?: unknown };
    if (typeof body.signedBlob !== "string" || !/^[A-Za-z0-9+/=]{16,2048}$/.test(body.signedBlob))
      throw new SourceStorageError("Invalid signing response");
    url.searchParams.set(
      "X-Goog-Signature",
      Buffer.from(body.signedBlob, "base64").toString("hex"),
    );
    return { method: "PUT", url: url.href, headers, expiresAt: request.expiresAt.toISOString() };
  }
  public async stat(objectKey: string): Promise<SourceObjectInfo | null> {
    assertKey(objectKey);
    const response = await this.call(`${this.objectUrl(objectKey)}?fields=size,generation`);
    if (response.status === 404) return null;
    if (!response.ok) throw new SourceStorageError("Source storage unavailable");
    const body = (await response.json()) as { size?: unknown; generation?: unknown };
    const bytes = Number(body.size);
    if (
      !Number.isSafeInteger(bytes) ||
      typeof body.generation !== "string" ||
      !/^\d{1,24}$/.test(body.generation)
    )
      throw new SourceStorageError("Invalid object metadata");
    return { bytes, generation: body.generation };
  }
  public async read(
    objectKey: string,
    options: { generation: string; maxBytes: number },
  ): Promise<Uint8Array> {
    assertKey(objectKey);
    if (!/^\d{1,24}$/.test(options.generation)) throw new SourceStorageError("Invalid generation");
    const response = await this.call(
      `${this.objectUrl(objectKey)}?alt=media&ifGenerationMatch=${options.generation}`,
      { headers: { range: `bytes=0-${options.maxBytes}` } },
    );
    if (!response.ok) throw new SourceStorageError("Source object unavailable");
    try {
      return await bounded(response, options.maxBytes);
    } catch (error) {
      if (error instanceof SourceStorageError) throw error;
      throw new SourceStorageError("Source object read failed");
    }
  }
  public async delete(objectKey: string, options: { generation?: string } = {}): Promise<void> {
    assertKey(objectKey);
    if (options.generation !== undefined && !/^\d{1,24}$/.test(options.generation))
      throw new SourceStorageError("Invalid generation");
    const condition =
      options.generation === undefined ? "" : `?ifGenerationMatch=${options.generation}`;
    const response = await this.call(`${this.objectUrl(objectKey)}${condition}`, {
      method: "DELETE",
    });
    // 404: already gone. 412: the key now holds a newer generation, which is not ours to delete.
    if (!response.ok && response.status !== 404 && !(condition && response.status === 412))
      throw new SourceStorageError("Source object delete failed");
  }
}
