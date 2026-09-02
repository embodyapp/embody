import { URL } from "node:url";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { UnauthenticatedError, type Principal } from "@embody/core";

export interface GatewayJwtVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  /** A symmetric HMAC secret or a verification key. */
  readonly key?: Uint8Array;
  /** A remote JWKS endpoint, used when keys rotate. */
  readonly jwksUrl?: string | URL;
  readonly algorithms: readonly string[];
  readonly clockTolerance?: number;
}
export interface AppAuthVerifier {
  readonly id: string;
  verify(token: string): Promise<Principal>;
}

function principalFromClaims(claims: JWTPayload): Principal {
  const { orgId, actorId, actorType, roles, scopes, metadata } = claims;
  if (
    typeof orgId !== "string" ||
    !orgId ||
    typeof actorId !== "string" ||
    !actorId ||
    (actorType !== "agent" && actorType !== "human" && actorType !== "system") ||
    !Array.isArray(roles) ||
    !roles.every((value) => typeof value === "string") ||
    !Array.isArray(scopes) ||
    !scopes.every((value) => typeof value === "string") ||
    (metadata !== undefined &&
      (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)))
  )
    throw new UnauthenticatedError("Gateway token has invalid principal claims");
  return {
    orgId,
    actorId,
    actorType,
    roles,
    scopes,
    ...(metadata === undefined ? {} : { metadata: metadata as Readonly<Record<string, unknown>> }),
  };
}

/** Verifies only explicitly allowed algorithms; JWT header algorithms are never trusted alone. */
export function gatewayJwtVerifier(options: GatewayJwtVerifierOptions): AppAuthVerifier {
  if (options.algorithms.length === 0)
    throw new TypeError("At least one JWT algorithm is required");
  if ((options.key === undefined) === (options.jwksUrl === undefined))
    throw new TypeError("Configure exactly one of key or jwksUrl");
  const key = options.key ?? createRemoteJWKSet(new URL(options.jwksUrl!));
  return {
    id: "gateway-jwt",
    verify(token: string): Promise<Principal> {
      return jwtVerify(token, key, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: [...options.algorithms],
        ...(options.clockTolerance === undefined ? {} : { clockTolerance: options.clockTolerance }),
      })
        .then(({ payload }) => principalFromClaims(payload))
        .catch((error: unknown) => {
          if (error instanceof UnauthenticatedError) throw error;
          throw new UnauthenticatedError("Gateway token is invalid");
        });
    },
  };
}

export interface LocalDevVerifierOptions {
  readonly enabled: boolean;
  readonly environment: "development" | "production";
  readonly principal: Principal;
}
/** Intended exclusively for an explicitly configured loopback development host. */
export function localDevVerifier(options: LocalDevVerifierOptions): AppAuthVerifier {
  if (!options.enabled || options.environment !== "development")
    throw new Error("Local development authentication is disabled outside development");
  return { id: "local-dev", verify: () => Promise.resolve(options.principal) };
}
