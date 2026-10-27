import { createHash } from "node:crypto";
import { z } from "zod";

import {
  HOSTED_PROFILE,
  WorkspaceIdSchema,
  AppIdSchema,
  ReleaseIdSchema,
  DeploymentIdSchema,
  DigestSchema,
} from "./profile.js";
export {
  HOSTED_PROFILE,
  WorkspaceIdSchema,
  AppIdSchema,
  ReleaseIdSchema,
  DeploymentIdSchema,
  DigestSchema,
} from "./profile.js";
export * from "./source.js";
export * from "./build.js";
export * from "./management.js";
import { ArtifactManifestSchema } from "./build.js";

const generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const binding = { workspaceId: WorkspaceIdSchema, appId: AppIdSchema };
const version = z.literal(1);
export const RequestOnlyCapabilitiesSchema = z.strictObject({
  profile: z.literal("request-only-v1"),
  crud: z.boolean(),
  boundedActions: z.boolean(),
  workflows: z.literal(false),
  schedules: z.literal(false),
  subscriptions: z.literal(false),
  appToAppRpc: z.literal(false),
  persistentLocalState: z.literal(false),
  genui: z.literal(false),
});
/**
 * M20 durable profile (M11 manifest amendment): events, subscriptions and workflows may be
 * declared; build admission requires each flag to match the built app exactly.
 */
export const DurableCapabilitiesSchema = z.strictObject({
  profile: z.literal("durable-v1"),
  crud: z.boolean(),
  boundedActions: z.boolean(),
  workflows: z.boolean(),
  events: z.boolean(),
  subscriptions: z.boolean(),
  schedules: z.literal(false),
  appToAppRpc: z.literal(false),
  persistentLocalState: z.literal(false),
  genui: z.literal(false),
});
export const CapabilitiesSchema = z.discriminatedUnion("profile", [
  RequestOnlyCapabilitiesSchema,
  DurableCapabilitiesSchema,
]);
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export const SecretReferenceSchema = z.strictObject({
  version,
  ...binding,
  name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  secretId: z.string().regex(/^sec_[a-z0-9]{8,64}$/),
  secretVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const secretReferences = z.array(SecretReferenceSchema).max(HOSTED_PROFILE.maxSecretReferences);
function secretsMatchBinding(value: {
  workspaceId: string;
  appId: string;
  secretReferences: z.infer<typeof secretReferences>;
}): boolean {
  return (
    value.secretReferences.every(
      (ref) => ref.workspaceId === value.workspaceId && ref.appId === value.appId,
    ) &&
    new Set(value.secretReferences.map((ref) => ref.name)).size === value.secretReferences.length
  );
}
export const DeploymentSubmissionSchema = z
  .strictObject({
    version,
    ...binding,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    source: z.strictObject({
      uploadId: z.string().regex(/^src_[a-z0-9]{8,64}$/),
      digest: DigestSchema,
      bytes: z.number().int().positive().max(HOSTED_PROFILE.maxSourceBytes),
    }),
    expectedGeneration: generation,
    capabilities: CapabilitiesSchema,
    secretReferences,
  })
  .refine(secretsMatchBinding, "Secret references must be unique and app/workspace bound");
export type DeploymentSubmission = z.infer<typeof DeploymentSubmissionSchema>;

export const ReleaseManifestSchema = z
  .strictObject({
    version,
    ...binding,
    releaseId: ReleaseIdSchema,
    deploymentId: DeploymentIdSchema,
    sourceDigest: DigestSchema,
    imageDigest: DigestSchema,
    scaffold: z.literal(HOSTED_PROFILE.scaffold),
    nodeMajor: z.union([z.literal(22), z.literal(24)]),
    capabilities: CapabilitiesSchema,
    /** Admitted M11 artifact manifest (profile, events, subscriptions, workflow versions). */
    artifact: ArtifactManifestSchema.optional(),
    secretReferences,
  })
  .refine(secretsMatchBinding, "Secret references must be unique and app/workspace bound");

export const DeploymentStateSchema = z.enum([
  "accepted",
  "validating",
  "building",
  "provisioning",
  "checking",
  "promoting",
  "active",
  "failed",
  "cancelled",
]);
export type DeploymentState = z.infer<typeof DeploymentStateSchema>;
export const PublicErrorCodeSchema = z.enum([
  "INVALID_INPUT",
  "UNSUPPORTED_PROFILE",
  "FORBIDDEN",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "STALE_GENERATION",
  "CANCELLED",
  "LIMIT_EXCEEDED",
  "BUILD_FAILED",
  "CHECK_FAILED",
  "DEPENDENCY_UNAVAILABLE",
  "ROLLBACK_INCOMPATIBLE",
  "SUSPENDED",
  "SECRET_IN_USE",
]);
const publicMessages: Record<z.infer<typeof PublicErrorCodeSchema>, string> = {
  INVALID_INPUT: "Invalid deployment request.",
  UNSUPPORTED_PROFILE: "Use a supported hosted scaffold profile and capabilities.",
  FORBIDDEN: "Permission denied.",
  NOT_FOUND: "Resource not found.",
  IDEMPOTENCY_CONFLICT: "Submission key already binds a different request.",
  STALE_GENERATION: "App generation changed; refresh app status before submitting.",
  CANCELLED: "Deployment cancelled.",
  LIMIT_EXCEEDED: "Hosted profile limit exceeded.",
  BUILD_FAILED: "Build failed; inspect authorized deployment logs.",
  CHECK_FAILED: "Release readiness check failed.",
  DEPENDENCY_UNAVAILABLE: "Deployment dependency unavailable; retry status lookup.",
  ROLLBACK_INCOMPATIBLE:
    "Rollback target is no longer retained or is incompatible with current data or workflows.",
  SUSPENDED:
    "Workspace operations are suspended by the platform operator; status and logs remain readable.",
  SECRET_IN_USE:
    "Secret version is referenced by the active release or a running deployment; roll out a newer version first.",
};
export const PublicErrorSchema = z
  .strictObject({
    code: PublicErrorCodeSchema,
    message: z.string(),
  })
  .refine(
    (value) => value.message === publicMessages[value.code],
    "Only safe fixed messages are public",
  );
export function publicError(code: z.infer<typeof PublicErrorCodeSchema>) {
  return { code, message: publicMessages[code] };
}
export const DeploymentStatusSchema = z
  .strictObject({
    version,
    ...binding,
    deploymentId: DeploymentIdSchema,
    releaseId: ReleaseIdSchema.optional(),
    sourceDigest: DigestSchema,
    state: DeploymentStateSchema,
    stageAttempt: z.number().int().min(1).max(HOSTED_PROFILE.maxStageAttempts),
    expectedGeneration: generation,
    cancellationFence: generation,
    lifecycleFence: generation,
    error: PublicErrorSchema.optional(),
  })
  .refine(
    (value) => (value.state === "failed") === (value.error !== undefined),
    "Only failed deployments carry errors",
  )
  .refine(
    (value) => value.state !== "active" || value.releaseId !== undefined,
    "Active deployments require a release",
  );

const next: Partial<Record<DeploymentState, DeploymentState>> = {
  accepted: "validating",
  validating: "building",
  building: "provisioning",
  provisioning: "checking",
  checking: "promoting",
  promoting: "active",
};
export const DeploymentTransitionSchema = z
  .strictObject({
    version,
    ...binding,
    deploymentId: DeploymentIdSchema,
    from: DeploymentStateSchema,
    to: DeploymentStateSchema,
    attempt: z.number().int().min(1).max(HOSTED_PROFILE.maxStageAttempts),
    nextAttempt: z.number().int().min(1).max(HOSTED_PROFILE.maxStageAttempts),
  })
  .refine((t) => {
    if (!(t.from in next)) return false;
    if (t.to === t.from) return t.from !== "accepted" && t.nextAttempt === t.attempt + 1;
    return (
      t.nextAttempt === 1 && (next[t.from] === t.to || t.to === "failed" || t.to === "cancelled")
    );
  }, "Invalid state transition or retry bound");

export const AppStatusSchema = z.strictObject({
  version,
  ...binding,
  /** The app's CLI/MCP namespace (M14: lets the CLI resolve `--app <name>`). Not an identity. */
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/)
    .optional(),
  generation,
  lifecycleFence: generation,
  status: z.enum(["enabled", "disabled", "deleted"]),
  activeReleaseId: ReleaseIdSchema.nullable(),
});
export const AppListSchema = z
  .strictObject({
    version,
    workspaceId: WorkspaceIdSchema,
    apps: z.array(AppStatusSchema).max(HOSTED_PROFILE.maxAppsPerWorkspace),
  })
  .refine(
    (value) =>
      value.apps.every((app) => app.workspaceId === value.workspaceId) &&
      new Set(value.apps.map((app) => app.appId)).size === value.apps.length,
    "App summaries must be unique and workspace bound",
  );

export const AppManagementSchema = z.discriminatedUnion("operation", [
  z.strictObject({ version, ...binding, operation: z.literal("status") }),
  z.strictObject({
    version,
    ...binding,
    operation: z.literal("disable"),
    expectedGeneration: generation,
  }),
  /** M15: an operator re-enables a disabled app (never a deleted one). */
  z.strictObject({
    version,
    ...binding,
    operation: z.literal("enable"),
    expectedGeneration: generation,
  }),
  /**
   * M15: redeploys the active release's admitted artifact with the app's current secret versions
   * (secret rotation); fenced and checked like a rollback.
   */
  z.strictObject({
    version,
    ...binding,
    operation: z.literal("rollout"),
    expectedGeneration: generation,
  }),
  z
    .strictObject({
      version,
      ...binding,
      operation: z.literal("delete"),
      expectedGeneration: generation,
      confirmAppId: AppIdSchema,
    })
    .refine((value) => value.confirmAppId === value.appId, "Confirm the app being deleted"),
  z.strictObject({
    version,
    ...binding,
    operation: z.literal("rollback"),
    expectedGeneration: generation,
    releaseId: ReleaseIdSchema,
  }),
  z.strictObject({
    version,
    ...binding,
    operation: z.literal("cancel"),
    deploymentId: DeploymentIdSchema,
    cancellationFence: generation,
  }),
]);

export const RoleSchema = z.enum(["deployer", "operator", "app-caller"]);
export type Role = z.infer<typeof RoleSchema>;
export const ScopedGrantSchema = z.strictObject({ version, ...binding, role: RoleSchema });
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>;
export type SecretReference = z.infer<typeof SecretReferenceSchema>;
export type AppManagement = z.infer<typeof AppManagementSchema>;
export type AppStatus = z.infer<typeof AppStatusSchema>;
export type Permission =
  | "app:call"
  | "app:read"
  | "deployment:submit"
  | "deployment:read"
  | "deployment:cancel"
  | "app:rollback"
  | "app:disable"
  | "app:delete"
  | "secret:write"
  | "secret:list"
  | "secret:read";
const grants: Record<Role, readonly Permission[]> = {
  "app-caller": ["app:call", "app:read"],
  deployer: [
    "app:read",
    "deployment:submit",
    "deployment:read",
    "deployment:cancel",
    "app:rollback",
    "secret:list",
  ],
  operator: [
    "app:read",
    "deployment:submit",
    "deployment:read",
    "deployment:cancel",
    "app:rollback",
    "app:disable",
    "app:delete",
    "secret:write",
    "secret:list",
  ],
};
export interface ScopedGrant {
  role: Role;
  workspaceId: string;
  appId: string;
}
/** Runtime treats unknown roles/permissions as denied. A role never implies cross-app access. */
export function hasPermission(
  grant: ScopedGrant,
  target: { workspaceId: string; appId: string },
  permission: Permission,
): boolean {
  return (
    grant.workspaceId === target.workspaceId &&
    grant.appId === target.appId &&
    Object.hasOwn(grants, grant.role) &&
    grants[grant.role].includes(permission)
  );
}

/** Use after verifying upload ownership and digest, before atomic insert+enqueue in M12. */
export function submissionFingerprint(input: unknown): string {
  const request = DeploymentSubmissionSchema.parse(input);
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  return `sha256:${createHash("sha256").update(canonical(request)).digest("hex")}`;
}
export function parseSubmissionJson(json: string): DeploymentSubmission {
  if (Buffer.byteLength(json, "utf8") > HOSTED_PROFILE.maxSubmissionBytes)
    throw new Error("LIMIT_EXCEEDED");
  // No execution/import of customer configuration here or in any schema.
  return DeploymentSubmissionSchema.parse(JSON.parse(json) as unknown);
}

/** Stores must atomically implement this contract, with workspace/app/key uniqueness. */
export interface SubmissionRepository {
  submit(
    request: DeploymentSubmission,
  ): Promise<{ deploymentId: z.infer<typeof DeploymentIdSchema>; replay: boolean }>;
}
export interface PromotionFence {
  expectedGeneration: number;
  lifecycleFence: number;
  cancellationFence: number;
}
/** Cancellation targets one deployment, and cannot undo an already terminal outcome. */
export function canCancel(
  job: { cancellationFence: number },
  deployment: { cancellationFence: number; state: DeploymentState },
): boolean {
  return deployment.state in next && job.cancellationFence === deployment.cancellationFence;
}
/** Must run inside the same transaction/CAS as pointer promotion, never as a pre-check. */
export function canPromote(
  job: PromotionFence,
  app: { generation: number; lifecycleFence: number; enabled: boolean },
  deployment: { cancellationFence: number; state: DeploymentState },
): boolean {
  return (
    deployment.state === "promoting" &&
    app.enabled &&
    job.expectedGeneration === app.generation &&
    job.lifecycleFence === app.lifecycleFence &&
    job.cancellationFence === deployment.cancellationFence
  );
}
