import { z } from "zod";
import { parseTarget } from "./target.js";

export const PROTOCOL_VERSION = 1 as const;
const protocolVersionSchema = z.literal(PROTOCOL_VERSION);
const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][A-Za-z0-9_-]*$/);
const safeString = z.string().min(1).max(500);
const targetSchema = z
  .string()
  .min(3)
  .max(200)
  .superRefine((value, context) => {
    try {
      parseTarget(value);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid canonical target" });
    }
  });
const jsonSchema = z.record(z.string(), z.unknown());

export const principalSchema = z
  .object({
    orgId: safeString,
    actorId: safeString,
    actorType: z.enum(["agent", "human", "system"]),
    roles: z.array(z.string().min(1).max(100)).max(100),
    scopes: z.array(z.string().min(1).max(200)).max(500),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const entityManifestSchema = z
  .object({
    description: z.string().max(2_000).optional(),
    schema: jsonSchema,
    indexes: z.array(z.string().max(100)).max(100),
    defaultSort: z
      .object({ field: z.string(), direction: z.enum(["asc", "desc"]) })
      .strict()
      .optional(),
  })
  .strict();
const actionManifestSchema = z
  .object({
    description: z.string().max(2_000).optional(),
    inputSchema: jsonSchema,
    outputSchema: jsonSchema.optional(),
    generated: z.boolean(),
  })
  .strict();

export const appManifestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    plugins: z.array(z.object({ id: identifier, version: safeString }).strict()).max(500),
    entities: z.record(z.string(), entityManifestSchema),
    actions: z.record(z.string(), actionManifestSchema),
    eventSubscriptions: z.array(targetSchema).max(10_000),
  })
  .strict();

export const registrationRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    appId: identifier,
    version: safeString,
    endpoint: z.url().max(2_000),
    healthCheckUrl: z.url().max(2_000),
    manifest: appManifestSchema,
  })
  .strict();

export const heartbeatRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    appId: identifier,
    generation: safeString,
  })
  .strict();

export const executionRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    target: targetSchema,
    input: z.unknown(),
  })
  .strict();

export const principalClaimsSchema = principalSchema
  .extend({
    iss: safeString,
    aud: safeString,
    sub: safeString,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    nbf: z.number().int().nonnegative().optional(),
    jti: safeString,
  })
  .strict();

export const eventEnvelopeSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    id: z.uuid(),
    name: targetSchema,
    orgId: safeString,
    producerAppId: identifier,
    producerPluginId: identifier.optional(),
    payload: z.unknown(),
    occurredAt: z.iso.datetime({ offset: true }),
    correlationId: z.string().max(200).optional(),
    causationId: z.string().max(200).optional(),
    schemaVersion: z.string().max(100).optional(),
  })
  .strict();

export const progressUpdateSchema = z
  .object({
    percent: z.number().finite().min(0).max(100).optional(),
    message: z.string().min(1).max(10_000),
  })
  .strict();

const validationIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  })
  .strict();

export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          "VALIDATION_ERROR",
          "UNAUTHENTICATED",
          "FORBIDDEN",
          "NOT_FOUND",
          "CONFLICT",
          "HOOK_VETO",
          "DEPENDENCY_ERROR",
          "DUPLICATE_REGISTRATION",
          "UNAVAILABLE",
          "INTERNAL_ERROR",
        ]),
        message: z.string().min(1).max(2_000),
        details: z.array(validationIssueSchema).max(1_000).optional(),
        requestId: safeString,
      })
      .strict(),
  })
  .strict();

export type RegistrationRequest = z.infer<typeof registrationRequestSchema>;
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;
export type PrincipalClaims = z.infer<typeof principalClaimsSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
