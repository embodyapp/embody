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
const workflowManifestSchema = z
  .object({
    description: z.string().max(2_000).optional(),
    version: safeString,
    inputSchema: jsonSchema,
    outputSchema: jsonSchema.optional(),
    steps: z
      .array(z.object({ name: safeString, dependsOn: z.array(safeString) }).strict())
      .max(1_000),
    controls: z
      .object({
        start: targetSchema,
        status: targetSchema,
        cancel: targetSchema,
        retry: targetSchema,
      })
      .strict(),
  })
  .strict();
const viewIdSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9-]*$/);
const semanticVersionSchema = z
  .string()
  .min(5)
  .max(100)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const viewResourceUriSchema = z
  .string()
  .min(8)
  .max(500)
  .regex(
    /^ui:\/\/[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  );
const integritySchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const actionManifestSchema = z
  .object({
    description: z.string().max(2_000).optional(),
    inputSchema: jsonSchema,
    outputSchema: jsonSchema.optional(),
    generated: z.boolean(),
    presentation: z.object({ view: viewIdSchema }).strict().optional(),
  })
  .strict();
const viewManifestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    id: viewIdSchema,
    kind: z.enum(["standard", "custom"]),
    description: z.string().max(2_000).optional(),
    propsSchema: jsonSchema,
    resourceUri: viewResourceUriSchema,
    version: semanticVersionSchema,
    callableTargets: z.array(targetSchema).max(100),
    fallback: z.enum(["markdown", "text", "json"]),
    integrity: integritySchema,
  })
  .strict();
const viewManifestRecordSchema = z
  .record(viewIdSchema, viewManifestSchema)
  .refine((views) => Object.keys(views).length <= 500, "Too many views");

export const appManifestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    plugins: z.array(z.object({ id: identifier, version: safeString }).strict()).max(500),
    entities: z.record(z.string(), entityManifestSchema),
    actions: z.record(z.string(), actionManifestSchema),
    workflows: z.record(z.string(), workflowManifestSchema).default({}),
    views: viewManifestRecordSchema.optional(),
    eventSubscriptions: z.array(targetSchema).max(10_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    const views = manifest.views ?? {};
    const resourceUris = new Set<string>();
    for (const [viewId, view] of Object.entries(views)) {
      if (view.id !== viewId)
        context.addIssue({
          code: "custom",
          path: ["views", viewId, "id"],
          message: "View ID must match its manifest key",
        });
      const resource = new URL(view.resourceUri);
      if (resource.pathname !== `/${viewId}@${view.version}`)
        context.addIssue({
          code: "custom",
          path: ["views", viewId, "resourceUri"],
          message: "Resource URI must match the view ID and version",
        });
      if (resourceUris.has(view.resourceUri))
        context.addIssue({
          code: "custom",
          path: ["views", viewId, "resourceUri"],
          message: "Resource URI must be unique",
        });
      resourceUris.add(view.resourceUri);
      if (new Set(view.callableTargets).size !== view.callableTargets.length)
        context.addIssue({
          code: "custom",
          path: ["views", viewId, "callableTargets"],
          message: "Callable targets must be unique",
        });
      for (const target of view.callableTargets)
        if (manifest.actions[target] === undefined)
          context.addIssue({
            code: "custom",
            path: ["views", viewId, "callableTargets"],
            message: "Callable target must reference an action",
          });
    }
    for (const [target, action] of Object.entries(manifest.actions)) {
      if (action.presentation === undefined) continue;
      if (action.outputSchema === undefined)
        context.addIssue({
          code: "custom",
          path: ["actions", target, "outputSchema"],
          message: "Presented action must declare an output schema",
        });
      if (views[action.presentation.view] === undefined)
        context.addIssue({
          code: "custom",
          path: ["actions", target, "presentation", "view"],
          message: "Presented action must reference a declared view",
        });
    }
  });

export const registrationRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    appId: identifier,
    version: safeString,
    endpoint: z.url().max(2_000),
    healthCheckUrl: z.url().max(2_000),
    manifest: appManifestSchema,
  })
  .strict()
  .superRefine((registration, context) => {
    for (const [viewId, view] of Object.entries(registration.manifest.views ?? {}))
      if (new URL(view.resourceUri).hostname !== registration.appId)
        context.addIssue({
          code: "custom",
          path: ["manifest", "views", viewId, "resourceUri"],
          message: "Resource URI authority must match the app ID",
        });
  });

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

export const eventDeliveryRequestSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    deliveryId: z.uuid(),
    destinationAppId: identifier,
    attempt: z.number().int().positive(),
    event: eventEnvelopeSchema,
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
          "RATE_LIMITED",
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
export type EventDeliveryRequest = z.infer<typeof eventDeliveryRequestSchema>;
