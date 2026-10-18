import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ConflictError,
  UnauthenticatedError,
  type EmbodyErrorCode,
  type Principal,
} from "@embody/core";
import {
  HOSTED_PROFILE,
  SOURCE_ADMISSION,
  SourceArchiveError,
  SourceStatusSchema,
  SourceUploadIdSchema,
  SourceUploadRequestSchema,
  hasPermission,
  inspectSourceArchive,
  sourceError,
  type DeploymentSubmission,
  type Permission,
  type SourceErrorCode,
  type SourceStatus,
  type SourceUploadAccess,
} from "@embody/cloud-contracts";
import type { CatalogApp, GatewayStore, WorkspaceCredential } from "./store.js";
import { DispatchRateLimitedError, type AuditRecord } from "./dispatch.js";
import { sourceObjectKey, type SourceObjectStore } from "./source-storage.js";

/** Persisted source identity and retention metadata. One record per (workspace, app, key). */
export interface SourceRecord {
  readonly workspaceId: string;
  readonly appId: string;
  readonly uploadId: string;
  readonly idempotencyKey: string;
  readonly digest: string;
  readonly bytes: number;
  readonly objectKey: string;
  readonly state: "pending" | "verified" | "rejected";
  readonly attempt: number;
  readonly actorId: string;
  readonly createdAt: string;
  readonly accessExpiresAt: string;
  readonly retainUntil: string;
  readonly verifiedAt?: string;
  readonly files?: number;
  readonly expandedBytes?: number;
  readonly treeDigest?: string;
  readonly error?: SourceErrorCode;
  /** Set by M12/M13 when a deployment/release retains the source past unpromoted retention. */
  readonly pinnedBy?: string;
  /**
   * Set (by CAS) by the retention sweep before it deletes the object. A purging record is a
   * tombstone: stores never return, renew or update it, and a new admission with the same key
   * allocates a fresh upload ID and object key.
   */
  readonly purging?: boolean;
  readonly revision: number;
}
export interface SourceAdmitInput {
  readonly workspaceId: string;
  readonly appId: string;
  readonly idempotencyKey: string;
  readonly digest: string;
  readonly bytes: number;
  readonly actorId: string;
  readonly now: Date;
}
export interface SourceUsage {
  /** Pending records for the app with unexpired upload access, excluding the keyed record. */
  readonly pendingForApp: number;
  /** Bytes of all unexpired records in the workspace, excluding the keyed record. */
  readonly retainedBytes: number;
}
/** Atomic source persistence; implemented by the memory and PostgreSQL gateway stores. */
export interface SourceStore {
  /** Ignores purging tombstones: their key is free for a new identity. */
  admitSource(input: SourceAdmitInput): Promise<{ record: SourceRecord; replay: boolean }>;
  /** Never returns a purging tombstone. */
  source(workspaceId: string, appId: string, uploadId: string): Promise<SourceRecord | null>;
  /** CAS on revision; throws ConflictError when another writer won or the record is purging. */
  updateSource(next: SourceRecord, expectedRevision: number): Promise<SourceRecord>;
  /** Expired unpinned records, including purging tombstones left by an interrupted sweep. */
  expiredSources(now: Date, limit: number): Promise<SourceRecord[]>;
  deleteSource(record: SourceRecord): Promise<boolean>;
}
export class SourceAdmissionError extends Error {
  public constructor(public readonly code: SourceErrorCode) {
    super(sourceError(code).message);
    this.name = "SourceAdmissionError";
  }
}
function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}
const RETRYABLE: ReadonlySet<SourceErrorCode> = new Set(["SIZE_MISMATCH", "DIGEST_MISMATCH"]);
const DAY = 86_400_000;

/**
 * Pure admission decision used inside each store's atomic section. Same key and fingerprint
 * always maps to the same upload ID/object key: retries never allocate a second identity.
 */
export function decideSourceAdmission(
  existing: SourceRecord | undefined,
  input: SourceAdmitInput,
  usage: SourceUsage,
): { record: Omit<SourceRecord, "revision">; replay: boolean; write: boolean } {
  const now = input.now.getTime();
  const access = new Date(now + SOURCE_ADMISSION.uploadAccessSeconds * 1000).toISOString();
  const retain = new Date(now + SOURCE_ADMISSION.retentionDays * DAY).toISOString();
  const quota = () => {
    if (usage.pendingForApp >= SOURCE_ADMISSION.maxPendingUploadsPerApp)
      throw new SourceAdmissionError("LIMIT_EXCEEDED");
    if (usage.retainedBytes + input.bytes > SOURCE_ADMISSION.maxRetainedSourceBytesPerWorkspace)
      throw new SourceAdmissionError("LIMIT_EXCEEDED");
  };
  if (existing) {
    if (existing.digest !== input.digest || existing.bytes !== input.bytes)
      throw new SourceAdmissionError("IDEMPOTENCY_CONFLICT");
    const prior = without(existing, "revision");
    if (Date.parse(existing.retainUntil) <= now && !existing.pinnedBy) {
      // Expired but not yet swept: renew in place under the same identity.
      quota();
      const rest = without(prior, "verifiedAt", "files", "expandedBytes", "treeDigest", "error");
      return {
        record: {
          ...rest,
          state: "pending",
          attempt: 1,
          createdAt: input.now.toISOString(),
          accessExpiresAt: access,
          retainUntil: retain,
        },
        replay: true,
        write: true,
      };
    }
    if (existing.state === "pending") {
      if (Date.parse(existing.accessExpiresAt) <= now) quota();
      return { record: { ...prior, accessExpiresAt: access }, replay: true, write: true };
    }
    if (
      existing.state === "rejected" &&
      existing.error &&
      RETRYABLE.has(existing.error) &&
      existing.attempt < SOURCE_ADMISSION.maxUploadAttempts
    ) {
      quota();
      const rest = without(prior, "error");
      return {
        record: {
          ...rest,
          state: "pending",
          attempt: existing.attempt + 1,
          accessExpiresAt: access,
        },
        replay: true,
        write: true,
      };
    }
    return { record: prior, replay: true, write: false };
  }
  quota();
  const uploadId = `src_${randomBytes(15).toString("hex").slice(0, 24)}`;
  return {
    record: {
      workspaceId: input.workspaceId,
      appId: input.appId,
      uploadId,
      idempotencyKey: input.idempotencyKey,
      digest: input.digest,
      bytes: input.bytes,
      objectKey: sourceObjectKey(input.workspaceId, input.appId, uploadId),
      state: "pending",
      attempt: 1,
      actorId: input.actorId,
      createdAt: input.now.toISOString(),
      accessExpiresAt: access,
      retainUntil: retain,
    },
    replay: false,
    write: true,
  };
}

export function sourceStatus(record: SourceRecord, upload?: SourceUploadAccess): SourceStatus {
  return SourceStatusSchema.parse({
    version: 1,
    workspaceId: record.workspaceId,
    appId: record.appId,
    uploadId: record.uploadId,
    state: record.state,
    digest: record.digest,
    bytes: record.bytes,
    attempt: record.attempt,
    createdAt: record.createdAt,
    retainUntil: record.retainUntil,
    ...(record.files === undefined ? {} : { files: record.files }),
    ...(record.expandedBytes === undefined ? {} : { expandedBytes: record.expandedBytes }),
    ...(record.treeDigest === undefined ? {} : { treeDigest: record.treeDigest }),
    ...(record.error ? { error: sourceError(record.error) } : {}),
    ...(upload && record.state === "pending" ? { upload } : {}),
  });
}

/**
 * For M12: a submission may reference only a verified, unexpired source of the same
 * workspace/app whose stored digest and size equal the submitted ones.
 */
export async function verifySubmissionSource(
  store: Pick<SourceStore, "source">,
  submission: DeploymentSubmission,
  now: Date = new Date(),
): Promise<SourceRecord> {
  const record = await store.source(
    submission.workspaceId,
    submission.appId,
    submission.source.uploadId,
  );
  if (
    !record ||
    record.purging ||
    (Date.parse(record.retainUntil) <= now.getTime() && !record.pinnedBy)
  )
    throw new SourceAdmissionError("NOT_FOUND");
  if (
    record.state !== "verified" ||
    record.digest !== submission.source.digest ||
    record.bytes !== submission.source.bytes
  )
    throw new SourceAdmissionError("INVALID_INPUT");
  return record;
}

/**
 * Retention sweep (M16 schedules it). Each record is first fenced by CAS (`purging`), so a
 * concurrent renewal either wins the CAS (the record is skipped) or, once fenced, gets a fresh
 * identity and object key. Only then is the object deleted, and the tombstone last, so no live
 * record ever points at a deleted object and a failed sweep leaves a tombstone to retry.
 */
export async function purgeExpiredSources(options: {
  store: Pick<SourceStore, "expiredSources" | "deleteSource" | "updateSource">;
  objects: Pick<SourceObjectStore, "delete">;
  now?: Date;
  limit?: number;
}): Promise<{ deleted: number; failed: number; skipped: number }> {
  const records = await options.store.expiredSources(
    options.now ?? new Date(),
    options.limit ?? 100,
  );
  let deleted = 0;
  let failed = 0;
  let skipped = 0;
  for (const record of records) {
    try {
      let fenced = record;
      if (!record.purging) {
        try {
          fenced = await options.store.updateSource({ ...record, purging: true }, record.revision);
        } catch (error) {
          // Renewed or pinned since it was listed: no longer expired, not ours to delete.
          if (error instanceof ConflictError) {
            skipped += 1;
            continue;
          }
          throw error;
        }
      }
      await options.objects.delete(fenced.objectKey);
      if (await options.store.deleteSource(fenced)) deleted += 1;
      else skipped += 1;
    } catch {
      failed += 1;
    }
  }
  return { deleted, failed, skipped };
}

export interface SourceAdmissionOptions {
  readonly objects: SourceObjectStore;
  /** Defaults to the workspace gateway store when it implements SourceStore. */
  readonly store?: SourceStore;
  readonly storageTimeoutMs?: number;
}
export interface SourceRequestContext {
  readonly credential: WorkspaceCredential;
  readonly principal: Principal;
  readonly catalog: readonly CatalogApp[];
}

function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SourceAdmissionError("DEPENDENCY_UNAVAILABLE")), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}
const STATUS: Record<SourceErrorCode, number> = {
  INVALID_INPUT: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  LIMIT_EXCEEDED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
  UPLOAD_INCOMPLETE: 409,
  SIZE_MISMATCH: 400,
  DIGEST_MISMATCH: 400,
  ARCHIVE_INVALID: 400,
  ARCHIVE_LIMIT: 400,
  UNSAFE_ENTRY: 400,
  FORBIDDEN_FILE: 400,
};
const AUDIT_CODE: Partial<Record<SourceErrorCode, EmbodyErrorCode>> = {
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  IDEMPOTENCY_CONFLICT: "CONFLICT",
  UPLOAD_INCOMPLETE: "CONFLICT",
  LIMIT_EXCEEDED: "RATE_LIMITED",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_ERROR",
};

/**
 * Management routes for authenticated source admission. Order on every request: authenticate
 * (workspace hook) → exact app grant → durable quota/audit admission → storage. Archive bytes
 * are inspected as data only; no customer configuration is imported or evaluated here.
 */
export function registerSourceRoutes(
  app: FastifyInstance,
  deps: {
    current: () => SourceRequestContext;
    admission: Pick<GatewayStore, "admit" | "complete">;
    store: SourceStore;
    objects: SourceObjectStore;
    clock: { now(): Date };
    storageTimeoutMs?: number;
  },
): void {
  const timeout = deps.storageTimeoutMs ?? 10_000;
  const prefix = "/v1/workspaces/:workspace/apps/:app/sources";
  const fail = (reply: FastifyReply, code: SourceErrorCode, source?: SourceStatus) =>
    reply.status(STATUS[code]).send({ error: sourceError(code), ...(source ? { source } : {}) });
  const authorize = (request: FastifyRequest, permission: Permission) => {
    const { workspace, app: appId } = request.params as { workspace: string; app: string };
    const { credential, catalog, principal } = deps.current();
    if (credential.workspaceId !== workspace) throw new UnauthenticatedError();
    const grants = credential.grants.filter(
      (grant) => grant.workspaceId === workspace && grant.appId === appId,
    );
    const target = catalog.find((entry) => entry.appId === appId && entry.state !== "deleted");
    // Do not reveal apps the caller holds no grant for.
    if (!grants.length || !target) throw new SourceAdmissionError("NOT_FOUND");
    if (
      !grants.some((grant) => hasPermission(grant, { workspaceId: workspace, appId }, permission))
    )
      throw new SourceAdmissionError("FORBIDDEN");
    if (target.state === "disabled") throw new SourceAdmissionError("FORBIDDEN");
    return { workspace, appId, principal };
  };
  const audited = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    scope: { workspace: string; appId: string; principal: Principal },
    target: string,
    work: () => Promise<T>,
    /** Returned results that are still failures (a persisted rejection). */
    rejection?: (result: T) => SourceErrorCode | undefined,
  ): Promise<T> => {
    const started = Date.now();
    const base = {
      requestId: String(reply.getHeader("x-request-id") ?? request.id),
      orgId: scope.workspace,
      appId: scope.appId,
      target,
      actorId: scope.principal.actorId,
      ...(scope.principal.delegation
        ? {
            subjectId: scope.principal.delegation.subjectId,
            ...(scope.principal.delegation.client
              ? { client: scope.principal.delegation.client }
              : {}),
          }
        : {}),
      surface: "http" as const,
    };
    try {
      await deps.admission.admit({ ...base, outcome: "unknown", durationMs: 0 });
    } catch (error) {
      if (error instanceof DispatchRateLimitedError) {
        reply.header("retry-after", String(error.retryAfterSeconds));
        throw new SourceAdmissionError("LIMIT_EXCEEDED");
      }
      throw new SourceAdmissionError("DEPENDENCY_UNAVAILABLE");
    }
    let record: AuditRecord = { ...base, outcome: "failure", durationMs: 0 };
    const failure = (code: SourceErrorCode | undefined): AuditRecord => ({
      ...base,
      outcome: "failure",
      errorCode: code ? (AUDIT_CODE[code] ?? "VALIDATION_ERROR") : "INTERNAL_ERROR",
      durationMs: Date.now() - started,
    });
    try {
      const result = await work();
      const rejected = rejection?.(result);
      record = rejected
        ? failure(rejected)
        : { ...base, outcome: "success", durationMs: Date.now() - started };
      return result;
    } catch (error) {
      record = failure(error instanceof SourceAdmissionError ? error.code : undefined);
      throw error;
    } finally {
      await deadline(deps.admission.complete(record), 5_000).catch(() => undefined);
    }
  };
  const routeOptions = {
    bodyLimit: HOSTED_PROFILE.maxSubmissionBytes,
    errorHandler: (
      error: Error & { statusCode?: number; code?: string },
      _request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      if (error instanceof SourceAdmissionError) return fail(reply, error.code);
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE")
        return reply.status(413).send({ error: sourceError("INVALID_INPUT") });
      if (
        error.code?.startsWith("FST_ERR_CTP_") ||
        error.statusCode === 400 ||
        error.statusCode === 415
      )
        return reply
          .status(error.statusCode === 415 ? 415 : 400)
          .send({ error: sourceError("INVALID_INPUT") });
      throw error; // Authentication and unexpected errors use the gateway envelope.
    },
  };

  app.post(prefix, routeOptions, async (request, reply) => {
    const scope = authorize(request, "deployment:submit");
    const parsed = SourceUploadRequestSchema.safeParse(request.body);
    if (
      !parsed.success ||
      parsed.data.workspaceId !== scope.workspace ||
      parsed.data.appId !== scope.appId
    )
      throw new SourceAdmissionError("INVALID_INPUT");
    const body = parsed.data;
    const result = await audited(request, reply, scope, "source.create", async () => {
      const admitted = await deadline(
        deps.store.admitSource({
          workspaceId: scope.workspace,
          appId: scope.appId,
          idempotencyKey: body.idempotencyKey,
          digest: body.digest,
          bytes: body.bytes,
          actorId: scope.principal.actorId,
          now: deps.clock.now(),
        }),
        timeout,
      ).catch((error: unknown) => {
        throw error instanceof SourceAdmissionError
          ? error
          : new SourceAdmissionError("DEPENDENCY_UNAVAILABLE");
      });
      const { record } = admitted;
      let upload: SourceUploadAccess | undefined;
      if (record.state === "pending")
        upload = await deadline(
          deps.objects.createUploadAccess({
            objectKey: record.objectKey,
            bytes: record.bytes,
            contentType: SOURCE_ADMISSION.contentType,
            expiresAt: new Date(record.accessExpiresAt),
          }),
          timeout,
        ).catch(() => {
          throw new SourceAdmissionError("DEPENDENCY_UNAVAILABLE");
        });
      return { ...admitted, upload };
    });
    return reply.status(result.replay ? 200 : 201).send(sourceStatus(result.record, result.upload));
  });

  app.post(`${prefix}/:upload/complete`, routeOptions, async (request, reply) => {
    const scope = authorize(request, "deployment:submit");
    const uploadId = (request.params as { upload: string }).upload;
    if (!SourceUploadIdSchema.safeParse(uploadId).success)
      throw new SourceAdmissionError("NOT_FOUND");
    const outcome = await audited(
      request,
      reply,
      scope,
      "source.complete",
      async () => {
        const load = () =>
          deadline(deps.store.source(scope.workspace, scope.appId, uploadId), timeout).catch(() => {
            throw new SourceAdmissionError("DEPENDENCY_UNAVAILABLE");
          });
        const record = await load();
        if (!record) throw new SourceAdmissionError("NOT_FOUND");
        if (record.state !== "pending") return record;
        const storage = <T>(promise: Promise<T>) =>
          deadline(promise, timeout).catch(() => {
            throw new SourceAdmissionError("DEPENDENCY_UNAVAILABLE");
          });
        const info = await storage(deps.objects.stat(record.objectKey));
        if (!info) throw new SourceAdmissionError("UPLOAD_INCOMPLETE");
        const reject = async (code: SourceErrorCode) => {
          // Pinned to the inspected generation: a stale completion must never delete a newer,
          // re-armed upload under the same key.
          await storage(deps.objects.delete(record.objectKey, { generation: info.generation }));
          return deps.store.updateSource(
            { ...without(record, "verifiedAt"), state: "rejected", error: code },
            record.revision,
          );
        };
        const settle = async (write: () => Promise<SourceRecord>) => {
          try {
            return await write();
          } catch (error) {
            if (error instanceof SourceAdmissionError) throw error;
            if (!(error instanceof ConflictError))
              throw new SourceAdmissionError("DEPENDENCY_UNAVAILABLE");
            // A concurrent completion won the CAS; report its authoritative outcome.
            const latest = await load();
            if (!latest) throw new SourceAdmissionError("NOT_FOUND");
            return latest;
          }
        };
        if (info.bytes !== record.bytes) return settle(() => reject("SIZE_MISMATCH"));
        const archive = await storage(
          deps.objects.read(record.objectKey, {
            generation: info.generation,
            maxBytes: record.bytes,
          }),
        );
        const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
        if (archive.byteLength !== record.bytes) return settle(() => reject("SIZE_MISMATCH"));
        if (digest !== record.digest) return settle(() => reject("DIGEST_MISMATCH"));
        let summary: Awaited<ReturnType<typeof inspectSourceArchive>>;
        try {
          summary = await inspectSourceArchive(archive);
        } catch (error) {
          const code = error instanceof SourceArchiveError ? error.code : "ARCHIVE_INVALID";
          return settle(() => reject(code));
        }
        const { revision, ...rest } = record;
        return settle(() =>
          deps.store.updateSource(
            {
              ...rest,
              state: "verified",
              verifiedAt: deps.clock.now().toISOString(),
              files: summary.files,
              expandedBytes: summary.expandedBytes,
              treeDigest: summary.treeDigest,
              revision,
            },
            revision,
          ),
        );
      },
      (result) => (result.state === "rejected" ? result.error : undefined),
    );
    const status = sourceStatus(outcome);
    if (outcome.state === "rejected" && outcome.error) return fail(reply, outcome.error, status);
    return reply.status(200).send(status);
  });

  app.get(`${prefix}/:upload`, routeOptions, async (request, reply) => {
    const scope = authorize(request, "deployment:read");
    const uploadId = (request.params as { upload: string }).upload;
    if (!SourceUploadIdSchema.safeParse(uploadId).success)
      throw new SourceAdmissionError("NOT_FOUND");
    const record = await deadline(
      deps.store.source(scope.workspace, scope.appId, uploadId),
      timeout,
    ).catch(() => {
      throw new SourceAdmissionError("DEPENDENCY_UNAVAILABLE");
    });
    if (!record) throw new SourceAdmissionError("NOT_FOUND");
    return reply.status(200).send(sourceStatus(record));
  });
}
