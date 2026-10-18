import { z } from "zod";

/** Contract policy, not evidence that infrastructure enforces these limits. */
export const HOSTED_PROFILE = Object.freeze({
  version: "request-only-v1",
  scaffold: "create-embody-app@0.1.0",
  nodeMajors: Object.freeze([22, 24] as const),
  maxSubmissionBytes: 16_384,
  maxSourceBytes: 10 * 1024 * 1024,
  maxExpandedSourceBytes: 50 * 1024 * 1024,
  maxSourceFiles: 2_000,
  maxBuildSeconds: 600,
  maxBuildOutputBytes: 500 * 1024 * 1024,
  actionDeadlineSeconds: 30,
  requestDeadlineSeconds: 60,
  databaseConnectionsPerInstance: 5,
  maxInstancesPerApp: 3,
  maxAppsPerWorkspace: 5,
  maxSecretReferences: 32,
  maxStageAttempts: 3,
  retryDelaySeconds: Object.freeze([5, 30] as const),
  sourceRetentionDays: 7,
  deploymentRetentionDays: 90,
  inactiveReleaseRetentionDays: 30,
  logRetentionDays: 14,
});

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{8,64}$`));
export const WorkspaceIdSchema = id("ws").brand<"WorkspaceId">();
export const AppIdSchema = id("app").brand<"AppId">();
export const ReleaseIdSchema = id("rel").brand<"ReleaseId">();
export const DeploymentIdSchema = id("dep").brand<"DeploymentId">();
export const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
