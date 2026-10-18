import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";
import { z } from "zod";
import { DigestSchema, HOSTED_PROFILE, WorkspaceIdSchema, AppIdSchema } from "./profile.js";

/**
 * M10 source admission policy. Source archives are data: nothing here imports, requires or
 * evaluates customer files. Configuration is evaluated only by M11's isolated builder.
 */
export const SOURCE_ADMISSION = Object.freeze({
  format: "embody-source-v1",
  contentType: "application/gzip",
  maxSourceBytes: HOSTED_PROFILE.maxSourceBytes,
  maxExpandedSourceBytes: HOSTED_PROFILE.maxExpandedSourceBytes,
  maxSourceFiles: HOSTED_PROFILE.maxSourceFiles,
  /** Files plus explicit directory entries. */
  maxEntries: HOSTED_PROFILE.maxSourceFiles * 2,
  maxPathBytes: 240,
  maxPathDepth: 32,
  /** Expanded tar stream / compressed archive; small archives may expand to the floor. */
  maxCompressionRatio: 100,
  compressionRatioFloorBytes: 1024 * 1024,
  uploadAccessSeconds: 600,
  maxPendingUploadsPerApp: 3,
  maxRetainedSourceBytesPerWorkspace: 100 * 1024 * 1024,
  maxUploadAttempts: 3,
  /** Unpromoted source (pending, rejected or verified, never pinned by a release). */
  retentionDays: HOSTED_PROFILE.sourceRetentionDays,
});

const SOURCE_DIRECTORIES = new Set(["src", "migrations", "public"]);
const SOURCE_EXTENSIONS = new Set([
  "ts",
  "mts",
  "cts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "json",
  "sql",
  "md",
  "txt",
  "css",
  "html",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "woff",
  "woff2",
  "yaml",
  "yml",
]);
const ROOT_FILES = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^package-lock\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^tsconfig(\.[A-Za-z0-9_-]+)?\.json$/,
  /^embody\.config\.(ts|mts|js|mjs)$/,
  /^README\.md$/,
  /^(LICENSE|NOTICE)(\.md|\.txt)?$/,
];
const DEPENDENCY_DIRECTORIES = new Set(["node_modules", "bower_components", "jspm_packages"]);
const BUILD_DIRECTORIES = new Set([
  "dist",
  "build",
  "out",
  "coverage",
  "tmp",
  "temp",
  "target",
  "lib-cov",
]);
const LOCAL_DATABASE =
  /\.(db|db3|sqlite|sqlite3|s3db|sl3|mdb|accdb|ldb)$|\.(db|db3|sqlite|sqlite3)-(wal|shm|journal)$|-(journal|wal|shm)$/i;
const CREDENTIAL_FILE =
  /\.(pem|key|p8|p12|pfx|jks|keystore|kdbx|crt|cer|der|asc|gpg|pgp|ovpn|ppk|tfstate|tfvars)$|^id_(rsa|dsa|ecdsa|ed25519)|^(htpasswd|netrc|pgpass)$/i;
const SECRET_NAME =
  /(^|[-_.])(credentials?|secrets?|service[-_]?accounts?|client[-_]?secrets?|private[-_]?keys?|tokens?|passwords?|api[-_]?keys?)([-_.]|$)/i;
const DATA_EXTENSION = /(\.(json|ya?ml|txt|toml|ini|xml|csv|conf|cfg|properties|env))$|^[^.]+$/i;

export type SourceExclusion =
  | "env-file"
  | "vcs"
  | "dotfile"
  | "dependencies"
  | "build-output"
  | "local-database"
  | "credential"
  | "unsupported";
export type SourcePathDecision =
  { readonly include: true } | { readonly include: false; readonly reason: SourceExclusion };

/**
 * Explicit inclusion rules for `embody-source-v1`. Exclusions win over inclusions and are
 * enforced both by the CLI packer and again by gateway admission, so a hand-built archive
 * cannot smuggle excluded files. `kind` "directory" applies only the exclusion rules.
 */
export function classifySourcePath(
  path: string,
  kind: "file" | "directory" = "file",
): SourcePathDecision {
  const segments = path.split("/");
  for (const segment of segments) {
    if (/^\.env($|\.)/i.test(segment)) return { include: false, reason: "env-file" };
    if (/^\.(git|hg|svn)$/i.test(segment)) return { include: false, reason: "vcs" };
    if (segment.startsWith(".")) return { include: false, reason: "dotfile" };
    if (DEPENDENCY_DIRECTORIES.has(segment)) return { include: false, reason: "dependencies" };
  }
  if (BUILD_DIRECTORIES.has(segments[0]!) && (segments.length > 1 || kind === "directory"))
    return { include: false, reason: "build-output" };
  if (kind === "directory")
    return segments.length === 1 && !SOURCE_DIRECTORIES.has(segments[0]!)
      ? { include: false, reason: "unsupported" }
      : { include: true };
  const name = segments[segments.length - 1]!;
  if (LOCAL_DATABASE.test(name)) return { include: false, reason: "local-database" };
  if (CREDENTIAL_FILE.test(name) || (SECRET_NAME.test(name) && DATA_EXTENSION.test(name)))
    return { include: false, reason: "credential" };
  if (segments.length === 1)
    return ROOT_FILES.some((pattern) => pattern.test(name))
      ? { include: true }
      : { include: false, reason: "unsupported" };
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return SOURCE_DIRECTORIES.has(segments[0]!) && extension && SOURCE_EXTENSIONS.has(extension)
    ? { include: true }
    : { include: false, reason: "unsupported" };
}

/** Archive rejection reasons; public messages are fixed and never echo archive content. */
export const SourceErrorCodeSchema = z.enum([
  "INVALID_INPUT",
  "FORBIDDEN",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "LIMIT_EXCEEDED",
  "DEPENDENCY_UNAVAILABLE",
  "UPLOAD_INCOMPLETE",
  "SIZE_MISMATCH",
  "DIGEST_MISMATCH",
  "ARCHIVE_INVALID",
  "ARCHIVE_LIMIT",
  "UNSAFE_ENTRY",
  "FORBIDDEN_FILE",
]);
export type SourceErrorCode = z.infer<typeof SourceErrorCodeSchema>;
const sourceMessages: Record<SourceErrorCode, string> = {
  INVALID_INPUT: "Invalid source upload request.",
  FORBIDDEN: "Permission denied.",
  NOT_FOUND: "Resource not found.",
  IDEMPOTENCY_CONFLICT: "Upload key already binds a different source digest or size.",
  LIMIT_EXCEEDED: "Source upload quota exceeded; retry later.",
  DEPENDENCY_UNAVAILABLE: "Source storage unavailable; retry with the same upload key.",
  UPLOAD_INCOMPLETE: "Source object not uploaded; upload it, then complete again.",
  SIZE_MISMATCH: "Uploaded size does not match the declared size.",
  DIGEST_MISMATCH: "Uploaded bytes do not match the declared digest.",
  ARCHIVE_INVALID: "Source is not a valid embody-source-v1 archive.",
  ARCHIVE_LIMIT: "Source archive exceeds file, size, path or compression limits.",
  UNSAFE_ENTRY: "Source archive contains an unsafe path, link or special file.",
  FORBIDDEN_FILE: "Source archive contains excluded or secret-bearing files.",
};
export const SourceErrorSchema = z
  .strictObject({ code: SourceErrorCodeSchema, message: z.string() })
  .refine((value) => value.message === sourceMessages[value.code], "Only fixed messages");
export function sourceError(code: SourceErrorCode) {
  return { code, message: sourceMessages[code] };
}
/** Thrown by archive inspection/extraction with a public code; `detail` stays local. */
export class SourceArchiveError extends Error {
  public constructor(
    public readonly code: Extract<
      SourceErrorCode,
      "ARCHIVE_INVALID" | "ARCHIVE_LIMIT" | "UNSAFE_ENTRY" | "FORBIDDEN_FILE"
    >,
    public readonly detail: string,
  ) {
    super(sourceMessages[code]);
    this.name = "SourceArchiveError";
  }
}

const version = z.literal(1);
export const SourceUploadIdSchema = z.string().regex(/^src_[a-z0-9]{8,64}$/);
export const SourceUploadRequestSchema = z.strictObject({
  version,
  workspaceId: WorkspaceIdSchema,
  appId: AppIdSchema,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  format: z.literal(SOURCE_ADMISSION.format),
  digest: DigestSchema,
  bytes: z.number().int().positive().max(SOURCE_ADMISSION.maxSourceBytes),
});
export type SourceUploadRequest = z.infer<typeof SourceUploadRequestSchema>;
export const SourceUploadAccessSchema = z.strictObject({
  method: z.literal("PUT"),
  url: z.url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type SourceUploadAccess = z.infer<typeof SourceUploadAccessSchema>;
export const SourceStateSchema = z.enum(["pending", "verified", "rejected"]);
export const SourceStatusSchema = z
  .strictObject({
    version,
    workspaceId: WorkspaceIdSchema,
    appId: AppIdSchema,
    uploadId: SourceUploadIdSchema,
    state: SourceStateSchema,
    digest: DigestSchema,
    bytes: z.number().int().positive().max(SOURCE_ADMISSION.maxSourceBytes),
    attempt: z.number().int().min(1).max(SOURCE_ADMISSION.maxUploadAttempts),
    createdAt: z.iso.datetime(),
    retainUntil: z.iso.datetime(),
    files: z.number().int().min(1).max(SOURCE_ADMISSION.maxSourceFiles).optional(),
    expandedBytes: z.number().int().min(0).max(SOURCE_ADMISSION.maxExpandedSourceBytes).optional(),
    treeDigest: DigestSchema.optional(),
    error: SourceErrorSchema.optional(),
    upload: SourceUploadAccessSchema.optional(),
  })
  .refine((value) => (value.state === "rejected") === (value.error !== undefined), "Errors")
  .refine((value) => value.state === "pending" || value.upload === undefined, "Access")
  .refine(
    (value) => (value.state === "verified") === (value.treeDigest !== undefined),
    "Verified sources carry a tree digest",
  );
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

// ---------------------------------------------------------------------------------------------
// embody-source-v1: gzip-compressed POSIX ustar with regular files and directories only.

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
// eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected.
const CONTROL = /[\u0000-\u001f\u007f]/;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

/** Returns a reason string when a normalized archive path is unsafe, else undefined. */
export function unsafeSourcePath(path: string): string | undefined {
  if (!path) return "empty path";
  if (Buffer.byteLength(path) > SOURCE_ADMISSION.maxPathBytes) return "path too long";
  if (CONTROL.test(path)) return "control character";
  if (path.startsWith("/")) return "absolute path";
  if (path.includes("\\")) return "backslash";
  if (path.includes(":")) return "colon";
  if (path.normalize("NFC") !== path) return "non-NFC unicode";
  const segments = path.split("/");
  if (segments.length > SOURCE_ADMISSION.maxPathDepth) return "path too deep";
  for (const segment of segments) {
    if (!segment) return "empty segment";
    if (segment === "." || segment === "..") return "traversal";
    if (segment.endsWith(" ") || segment.endsWith(".")) return "ambiguous segment";
  }
  return undefined;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}
function header(path: string, size: number, mode: number, type: "0" | "5"): Buffer {
  const block = Buffer.alloc(BLOCK);
  const bytes = Buffer.from(encoder.encode(path));
  let name = bytes;
  let prefix = Buffer.alloc(0);
  if (bytes.length > 100) {
    let split = -1;
    for (let index = bytes.length - 1; index >= 0; index -= 1)
      if (bytes[index] === 0x2f && bytes.length - index - 1 <= 100 && index <= 155) {
        split = index;
        break;
      }
    if (split <= 0) throw new SourceArchiveError("ARCHIVE_LIMIT", `path too long: ${path}`);
    prefix = bytes.subarray(0, split);
    name = bytes.subarray(split + 1);
  }
  name.copy(block, 0);
  block.write(octal(mode, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(0, 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(type, 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  prefix.copy(block, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

export interface SourceArchiveFile {
  readonly path: string;
  readonly content: Uint8Array;
  readonly executable?: boolean;
}
/**
 * Deterministic writer: sorted paths, zero mtime/owner, normalized modes, fixed gzip header.
 * Same files therefore produce the same digest, so retries reuse one upload identity.
 */
export function createSourceArchive(files: readonly SourceArchiveFile[]): Buffer {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Buffer[] = [];
  for (const file of sorted) {
    const reason = unsafeSourcePath(file.path);
    if (reason) throw new SourceArchiveError("UNSAFE_ENTRY", `${reason}: ${file.path}`);
    chunks.push(header(file.path, file.content.byteLength, file.executable ? 0o755 : 0o644, "0"));
    chunks.push(Buffer.from(file.content));
    const padding = (BLOCK - (file.content.byteLength % BLOCK)) % BLOCK;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9 });
  archive[9] = 0xff; // gzip OS byte: "unknown" instead of the build platform.
  return archive;
}

/** Test/adversary helper: raw ustar entries, including types the reader must reject. */
export function rawTarEntry(
  path: string,
  content: Uint8Array,
  options: { type?: string; linkname?: string; mode?: number; magic?: string } = {},
): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(path, 0, 100, "utf8");
  block.write(octal(options.mode ?? 0o644, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(content.byteLength, 12), 124, "ascii");
  block.write(octal(0, 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(options.type ?? "0", 156, "ascii");
  if (options.linkname) block.write(options.linkname, 157, 100, "utf8");
  block.write(options.magic ?? "ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  const padding = (BLOCK - (content.byteLength % BLOCK)) % BLOCK;
  return Buffer.concat([block, Buffer.from(content), Buffer.alloc(padding)]);
}

export interface SourceArchiveEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly size: number;
  readonly executable: boolean;
  /** `sha256:<hex>` of file content; undefined for directories. */
  readonly digest?: string;
}
export interface SourceArchiveSummary {
  readonly digest: string;
  readonly bytes: number;
  readonly files: number;
  readonly expandedBytes: number;
  /** Digest over sorted `path\0size\0digest\n` lines; binds the reviewed file tree. */
  readonly treeDigest: string;
  readonly entries: readonly SourceArchiveEntry[];
}
export interface SourceArchiveOptions {
  /** Default true: apply `classifySourcePath`, required files and private-key scanning. */
  readonly enforcePolicy?: boolean;
}

function field(block: Buffer, offset: number, length: number): Buffer {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return end < 0 ? slice : slice.subarray(0, end);
}
function parseOctal(block: Buffer, offset: number, length: number): number {
  const text = block
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/[\0 ]+$/, "");
  if (!/^[0-7]{1,11}$/.test(text)) throw new SourceArchiveError("ARCHIVE_INVALID", "bad octal");
  return parseInt(text, 8);
}
function parseHeader(block: Buffer): Omit<SourceArchiveEntry, "digest"> {
  const stored = parseOctal(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1)
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  if (sum !== stored) throw new SourceArchiveError("ARCHIVE_INVALID", "checksum");
  if (block.toString("ascii", 257, 263) !== "ustar\0" || block.toString("ascii", 263, 265) !== "00")
    throw new SourceArchiveError("ARCHIVE_INVALID", "not POSIX ustar");
  const type = String.fromCharCode(block[156]!);
  if (type === "1" || type === "2")
    throw new SourceArchiveError("UNSAFE_ENTRY", type === "1" ? "hard link" : "symbolic link");
  if (type !== "0" && type !== "\0" && type !== "5")
    throw new SourceArchiveError(
      ["3", "4", "6", "7"].includes(type) ? "UNSAFE_ENTRY" : "ARCHIVE_INVALID",
      `unsupported entry type ${JSON.stringify(type)}`,
    );
  if (field(block, 157, 100).length)
    throw new SourceArchiveError("UNSAFE_ENTRY", "link target on non-link");
  const mode = parseOctal(block, 100, 8);
  if (mode & 0o7000) throw new SourceArchiveError("UNSAFE_ENTRY", "setuid/setgid/sticky mode");
  const size = parseOctal(block, 124, 12);
  let path: string;
  try {
    const name = decoder.decode(field(block, 0, 100));
    const prefix = decoder.decode(field(block, 345, 155));
    path = prefix ? `${prefix}/${name}` : name;
  } catch {
    throw new SourceArchiveError("UNSAFE_ENTRY", "invalid UTF-8 path");
  }
  const directory = type === "5";
  if (directory) {
    if (size !== 0) throw new SourceArchiveError("ARCHIVE_INVALID", "directory with content");
    path = path.replace(/\/$/, "");
  }
  const reason = unsafeSourcePath(path);
  if (reason) throw new SourceArchiveError("UNSAFE_ENTRY", reason);
  return {
    path,
    type: directory ? "directory" : "file",
    size,
    executable: !directory && (mode & 0o111) !== 0,
  };
}

/**
 * Streams an archive (never fully expanded in memory), validating every header before any
 * content is accepted. `onFile` receives content chunks of validated files only.
 */
async function walkArchive(
  archive: Uint8Array,
  options: SourceArchiveOptions,
  onFile?: {
    start(entry: Omit<SourceArchiveEntry, "digest">): Promise<void>;
    data(chunk: Buffer): Promise<void>;
    end(digest: string): Promise<void>;
    directory(path: string): Promise<void>;
  },
): Promise<SourceArchiveSummary> {
  const limits = SOURCE_ADMISSION;
  if (archive.byteLength > limits.maxSourceBytes)
    throw new SourceArchiveError("ARCHIVE_LIMIT", "compressed archive too large");
  if (archive.byteLength < 18 || archive[0] !== 0x1f || archive[1] !== 0x8b)
    throw new SourceArchiveError("ARCHIVE_INVALID", "not gzip");
  const enforce = options.enforcePolicy ?? true;
  const maxStream = Math.min(
    limits.maxExpandedSourceBytes + (limits.maxEntries + 2) * BLOCK * 2,
    Math.max(limits.compressionRatioFloorBytes, archive.byteLength * limits.maxCompressionRatio),
  );
  const entries: SourceArchiveEntry[] = [];
  const seen = new Map<string, "file" | "directory">();
  let streamed = 0;
  let expanded = 0;
  let files = 0;
  let pending: Buffer = Buffer.alloc(0);
  let current:
    { entry: Omit<SourceArchiveEntry, "digest">; remaining: number; padding: number } | undefined;
  let hash: ReturnType<typeof createHash> | undefined;
  let tail = "";
  let ended = false;
  const register = (path: string, type: "file" | "directory") => {
    const key = path.normalize("NFC").toLowerCase();
    const prior = seen.get(key);
    if (prior && (prior === "file" || type === "file"))
      throw new SourceArchiveError("UNSAFE_ENTRY", "duplicate or case-colliding path");
    seen.set(key, type);
    const segments = key.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const parent = segments.slice(0, depth).join("/");
      if (seen.get(parent) === "file")
        throw new SourceArchiveError("UNSAFE_ENTRY", "file used as directory");
      if (!seen.has(parent)) seen.set(parent, "directory");
    }
  };
  const gunzip = createGunzip({ chunkSize: 64 * 1024 });
  const input = Readable.from([Buffer.from(archive)]);
  input.pipe(gunzip);
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      streamed += chunk.length;
      if (streamed > maxStream)
        throw new SourceArchiveError("ARCHIVE_LIMIT", "expanded stream exceeds ratio/size limit");
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length) {
        if (ended) {
          if (pending.some((byte) => byte !== 0))
            throw new SourceArchiveError("ARCHIVE_INVALID", "data after end of archive");
          pending = Buffer.alloc(0);
          break;
        }
        if (current) {
          if (current.remaining > 0) {
            const take = Math.min(current.remaining, pending.length);
            const data = pending.subarray(0, take);
            hash!.update(data);
            if (enforce) {
              const text = tail + data.toString("latin1");
              if (PRIVATE_KEY.test(text))
                throw new SourceArchiveError(
                  "FORBIDDEN_FILE",
                  `private key in ${current.entry.path}`,
                );
              tail = text.slice(-64);
            }
            await onFile?.data(data);
            current.remaining -= take;
            pending = pending.subarray(take);
            if (current.remaining > 0) break;
          }
          if (pending.length < current.padding) break;
          if (pending.subarray(0, current.padding).some((byte) => byte !== 0))
            throw new SourceArchiveError("ARCHIVE_INVALID", "non-zero padding");
          pending = pending.subarray(current.padding);
          const digest = `sha256:${hash!.digest("hex")}`;
          entries.push({ ...current.entry, digest });
          await onFile?.end(digest);
          current = undefined;
          hash = undefined;
          tail = "";
          continue;
        }
        if (pending.length < BLOCK) break;
        const block = pending.subarray(0, BLOCK);
        pending = pending.subarray(BLOCK);
        if (block.every((byte) => byte === 0)) {
          ended = true;
          continue;
        }
        const entry = parseHeader(block);
        if (entries.length + 1 > limits.maxEntries)
          throw new SourceArchiveError("ARCHIVE_LIMIT", "too many entries");
        if (enforce) {
          const decision = classifySourcePath(entry.path, entry.type);
          if (!decision.include)
            throw new SourceArchiveError(
              decision.reason === "unsupported" ? "ARCHIVE_INVALID" : "FORBIDDEN_FILE",
              `${decision.reason}: ${entry.path}`,
            );
        }
        register(entry.path, entry.type);
        if (entry.type === "directory") {
          entries.push(entry);
          await onFile?.directory(entry.path);
          continue;
        }
        files += 1;
        expanded += entry.size;
        if (files > limits.maxSourceFiles)
          throw new SourceArchiveError("ARCHIVE_LIMIT", "too many files");
        if (expanded > limits.maxExpandedSourceBytes)
          throw new SourceArchiveError("ARCHIVE_LIMIT", "expanded size too large");
        current = { entry, remaining: entry.size, padding: (BLOCK - (entry.size % BLOCK)) % BLOCK };
        hash = createHash("sha256");
        await onFile?.start(entry);
      }
    }
  } catch (error) {
    input.unpipe(gunzip);
    gunzip.destroy();
    if (error instanceof SourceArchiveError) throw error;
    // zlib reports corrupt/truncated input as Z_* codes; filesystem errors from callbacks pass.
    if (String((error as { code?: unknown }).code ?? "").startsWith("Z_"))
      throw new SourceArchiveError("ARCHIVE_INVALID", "corrupt gzip stream");
    throw error;
  }
  if (!ended || current || pending.length)
    throw new SourceArchiveError("ARCHIVE_INVALID", "truncated archive");
  if (files === 0) throw new SourceArchiveError("ARCHIVE_INVALID", "empty archive");
  if (enforce) {
    const paths = new Set(entries.filter((e) => e.type === "file").map((e) => e.path));
    if (!paths.has("package.json") || ![...paths].some((p) => /^embody\.config\./.test(p)))
      throw new SourceArchiveError("ARCHIVE_INVALID", "missing package.json or embody.config");
  }
  const tree = createHash("sha256");
  for (const entry of [...entries]
    .filter((e) => e.type === "file")
    .sort((a, b) => (a.path < b.path ? -1 : 1)))
    tree.update(`${entry.path}\0${entry.size}\0${entry.digest}\n`);
  return {
    digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    bytes: archive.byteLength,
    files,
    expandedBytes: expanded,
    treeDigest: `sha256:${tree.digest("hex")}`,
    entries,
  };
}

/** Validates an archive completely without writing anything. Never evaluates content. */
export function inspectSourceArchive(
  archive: Uint8Array,
  options: SourceArchiveOptions = {},
): Promise<SourceArchiveSummary> {
  return walkArchive(archive, options);
}

/**
 * Inspects first, then extracts into a new directory using exclusive no-follow creates.
 * Nothing is written unless the whole archive passes. Intended for M11's isolated builder.
 */
export async function extractSourceArchive(
  archive: Uint8Array,
  destination: string,
  options: SourceArchiveOptions = {},
): Promise<SourceArchiveSummary> {
  const summary = await walkArchive(archive, options);
  const root = resolve(destination);
  await mkdir(root, { mode: 0o700 }); // Must not exist: never merge into existing trees.
  const real = await realpath(root);
  const inside = async (path: string) => {
    const target = resolve(real, ...path.split("/"));
    if (!target.startsWith(real + sep)) throw new SourceArchiveError("UNSAFE_ENTRY", "escape");
    const parent = await realpath(resolve(target, ".."));
    if (parent !== real && !parent.startsWith(real + sep))
      throw new SourceArchiveError("UNSAFE_ENTRY", "escape");
    return target;
  };
  const expected = new Map(summary.entries.map((entry) => [entry.path, entry.digest]));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let path = "";
  try {
    await walkArchive(archive, options, {
      directory: async (dir) => {
        await mkdir(resolve(real, ...dir.split("/")), { recursive: true, mode: 0o755 });
        await inside(dir);
      },
      start: async (entry) => {
        path = entry.path;
        await mkdir(resolve(real, ...entry.path.split("/").slice(0, -1)), {
          recursive: true,
          mode: 0o755,
        });
        handle = await open(
          await inside(entry.path),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          entry.executable ? 0o755 : 0o644,
        );
      },
      data: async (chunk) => {
        await handle!.write(chunk);
      },
      end: async (digest) => {
        await handle!.close();
        handle = undefined;
        if (expected.get(path) !== digest)
          throw new SourceArchiveError("ARCHIVE_INVALID", "content changed between passes");
      },
    });
  } finally {
    await handle?.close();
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Packaging (CLI side). Reads only regular files; never follows links or imports anything.

export interface PackedSourceExclusion {
  readonly path: string;
  readonly reason: SourceExclusion | "symlink" | "special-file";
}
export interface PackedSource {
  readonly archive: Buffer;
  readonly digest: string;
  readonly bytes: number;
  readonly files: readonly string[];
  readonly expandedBytes: number;
  readonly excluded: readonly PackedSourceExclusion[];
}
export class SourcePackError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SourcePackError";
  }
}
export async function packSource(directory: string): Promise<PackedSource> {
  const root = await realpath(resolve(directory));
  const files: SourceArchiveFile[] = [];
  const excluded: PackedSourceExclusion[] = [];
  let expanded = 0;
  const visit = async (absolute: string): Promise<void> => {
    const names = (await readdir(absolute)).sort();
    for (const name of names) {
      const full = join(absolute, name);
      const path = relative(root, full).split(sep).join("/");
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        excluded.push({ path, reason: "symlink" });
        continue;
      }
      if (info.isDirectory()) {
        const decision = classifySourcePath(path, "directory");
        if (!decision.include) excluded.push({ path: `${path}/`, reason: decision.reason });
        else await visit(full);
        continue;
      }
      if (!info.isFile()) {
        excluded.push({ path, reason: "special-file" });
        continue;
      }
      const decision = classifySourcePath(path);
      if (!decision.include) {
        excluded.push({ path, reason: decision.reason });
        continue;
      }
      const unsafe = unsafeSourcePath(path);
      if (unsafe) throw new SourcePackError(`Unsupported path (${unsafe}): ${path}`);
      if (files.length + 1 > SOURCE_ADMISSION.maxSourceFiles)
        throw new SourcePackError(`More than ${SOURCE_ADMISSION.maxSourceFiles} source files`);
      expanded += info.size;
      if (expanded > SOURCE_ADMISSION.maxExpandedSourceBytes)
        throw new SourcePackError("Source exceeds the expanded size limit");
      const content = await readFile(full);
      if (PRIVATE_KEY.test(content.toString("latin1")))
        throw new SourcePackError(`Private key material detected; remove it from ${path}`);
      files.push({ path, content, executable: (info.mode & 0o111) !== 0 });
    }
  };
  await visit(root);
  const collisions = new Set<string>();
  for (const file of files) {
    const key = file.path.normalize("NFC").toLowerCase();
    if (collisions.has(key)) throw new SourcePackError(`Case-colliding paths: ${file.path}`);
    collisions.add(key);
  }
  if (!files.some((f) => f.path === "package.json"))
    throw new SourcePackError("package.json is required at the source root");
  if (!files.some((f) => /^embody\.config\./.test(f.path)))
    throw new SourcePackError("embody.config.ts (or .mts/.js/.mjs) is required");
  const archive = createSourceArchive(files);
  if (archive.byteLength > SOURCE_ADMISSION.maxSourceBytes)
    throw new SourcePackError("Compressed source exceeds the 10 MiB limit");
  // Validate with the same reader the gateway uses so packaging bugs fail locally.
  try {
    await inspectSourceArchive(archive);
  } catch (error) {
    throw new SourcePackError(
      error instanceof SourceArchiveError
        ? `Archive self-check failed: ${error.detail}`
        : "Archive self-check failed",
    );
  }
  return {
    archive,
    digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
    bytes: archive.byteLength,
    files: files.map((f) => f.path).sort(),
    expandedBytes: expanded,
    excluded,
  };
}
