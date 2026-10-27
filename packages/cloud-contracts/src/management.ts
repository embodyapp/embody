import { z } from "zod";
import { AppIdSchema, DeploymentIdSchema, WorkspaceIdSchema } from "./profile.js";

/**
 * M15 management contracts: secrets (metadata only; values are write-only), bounded logs and app
 * deletion receipts. See docs/mvp/MANAGEMENT.md.
 */
const version = z.literal(1);
const binding = { workspaceId: WorkspaceIdSchema, appId: AppIdSchema };
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Timestamp");

export const MANAGEMENT_LIMITS = Object.freeze({
  /** Largest secret value (UTF-8 bytes). Secret Manager allows 64 KiB; env values stay small. */
  maxSecretBytes: 32_768,
  /** Versions kept per secret name (older revoked versions are listed until deletion). */
  maxSecretVersions: 100,
  /** Log entries per page and pages' byte bound. */
  maxLogEntries: 200,
  defaultLogEntries: 50,
  /** Oldest log entry a query may ask for (audit retention: HOSTED_PROFILE.logRetentionDays). */
  maxLogAgeDays: 14,
  /** Build log bytes returned for one deployment attempt. */
  maxBuildLogBytes: 65_536,
  /** A deleted app's database is kept this long for operator export/recovery (MD10 pending). */
  deletedDatabaseRetentionDays: 30,
});

/**
 * Environment names the platform sets on every candidate, or the provider reserves. A customer
 * secret can never shadow them.
 */
export const RESERVED_SECRET_NAMES: readonly string[] = Object.freeze([
  "DATABASE_URL",
  "NODE_ENV",
  "PORT",
  "GATEWAY_JWT_ISSUER",
  "GATEWAY_JWKS_URL",
  "NODE_OPTIONS",
  "PATH",
  "HOME",
]);
const RESERVED_PREFIXES = ["EMBODY_", "K_", "CLOUD_RUN_", "GOOGLE_", "NODE_"];
export const SecretNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
  .refine(
    (name) =>
      !RESERVED_SECRET_NAMES.includes(name) &&
      !RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix)),
    "Reserved environment name",
  );
export const SecretIdSchema = z.string().regex(/^sec_[a-z0-9]{8,64}$/);

/** Write-only: the only contract that carries a secret value, and only on the request. */
export const SecretWriteSchema = z
  .strictObject({
    version,
    ...binding,
    name: SecretNameSchema,
    value: z.string().min(1),
    /** Latest version the writer saw (0 to create): a concurrent writer conflicts. */
    expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (value) => Buffer.byteLength(value.value, "utf8") <= MANAGEMENT_LIMITS.maxSecretBytes,
    "Secret value too large",
  );
export const SecretRevokeSchema = z.strictObject({
  version,
  ...binding,
  name: SecretNameSchema,
  secretVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const SecretVersionStatusSchema = z.strictObject({
  secretVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["enabled", "revoked"]),
  createdAt: timestamp,
  revokedAt: timestamp.optional(),
});
/** Metadata only: never a value, a provider name or a provider version. */
export const SecretStatusSchema = z.strictObject({
  version,
  ...binding,
  name: SecretNameSchema,
  secretId: SecretIdSchema,
  versions: z.array(SecretVersionStatusSchema).max(MANAGEMENT_LIMITS.maxSecretVersions),
});
export const SecretListSchema = z.strictObject({
  version,
  ...binding,
  secrets: z.array(SecretStatusSchema).max(32),
});
export type SecretWrite = z.infer<typeof SecretWriteSchema>;
export type SecretStatus = z.infer<typeof SecretStatusSchema>;
export type SecretList = z.infer<typeof SecretListSchema>;

/** One redacted, workspace-scoped entry: platform records only, never payloads or provider text. */
export const LogEntrySchema = z.strictObject({
  time: timestamp,
  kind: z.enum(["request", "deployment"]),
  /** Request ID (requests) or deployment ID (deployments). */
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  target: z.string().max(200),
  outcome: z.string().regex(/^[a-z:_-]{1,40}$/),
  errorCode: z
    .string()
    .regex(/^[A-Z_]{1,40}$/)
    .optional(),
  durationMs: z.number().int().min(0).optional(),
  actorId: z.string().max(200).optional(),
  surface: z.enum(["http", "mcp", "platform"]).optional(),
});
export const LogPageSchema = z.strictObject({
  version,
  ...binding,
  entries: z.array(LogEntrySchema).max(MANAGEMENT_LIMITS.maxLogEntries),
  /** Opaque: pass back as `cursor` for older entries. Absent when nothing older is retained. */
  nextCursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
});
export const DeploymentLogSchema = z.strictObject({
  version,
  ...binding,
  deploymentId: DeploymentIdSchema,
  attempt: z.number().int().min(1).max(3),
  /** Bounded and redacted (`redactBuildLog`); empty when the attempt built nothing. */
  text: z.string(),
  truncated: z.boolean(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;
export type LogPage = z.infer<typeof LogPageSchema>;
export type DeploymentLog = z.infer<typeof DeploymentLogSchema>;

/** Returned by delete and kept as the minimal audit of a deleted app. */
export const AppDeletionReceiptSchema = z.strictObject({
  version,
  ...binding,
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  deletedAt: timestamp,
  actorId: z.string().min(1).max(200),
  /** The fence every deployment and queued task of the app now fails. */
  lifecycleFence: z.number().int().min(0),
  cancelledDeployments: z.array(DeploymentIdSchema).max(20),
  retention: z.strictObject({
    /** Database kept for operator export/recovery, then dropped by operator deprovisioning. */
    databaseUntil: timestamp,
    /** Sources and images are released now; the retention sweeps delete them. */
    sourcesAndImages: z.literal("released"),
    /** Provider backups of the shared instance age out on its backup schedule. */
    backups: z.literal("instance-backup-retention"),
    /** Customer secrets: every version revoked now, deleted at deprovisioning. */
    secrets: z.literal("revoked"),
    /** Audit and this receipt follow the log retention; the receipt is kept with the workspace. */
    audit: z.literal("retained"),
  }),
});
export type AppDeletionReceipt = z.infer<typeof AppDeletionReceiptSchema>;
