import { URL } from "node:url";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { isValidDelegation, UnauthenticatedError, type Principal } from "@embody/core";

export interface GatewayJwtVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  /** A symmetric HMAC secret or a verification key. */
  readonly key?: Uint8Array;
  /** A remote JWKS endpoint, used when keys rotate. */
  readonly jwksUrl?: string | URL;
  readonly algorithms: readonly string[];
  readonly clockTolerance?: number;
  /** Hosted apps must pin their provisioned workspace, not trust a token's orgId. */
  readonly workspaceId?: string;
  /** Maximum cached remote key lifetime. Defaults to 60 seconds. */
  readonly cacheMaxAge?: number;
}
export interface AppAuthVerifier {
  readonly id: string;
  /** Lets hosts reject the intentionally insecure verifier in production. */
  readonly localDevelopmentOnly?: boolean;
  verify(token: string): Promise<Principal>;
}

function principalFromClaims(claims: JWTPayload): Principal {
  const { orgId, actorId, actorType, roles, scopes, metadata, delegation } = claims;
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
      (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))) ||
    (delegation !== undefined && (actorType !== "agent" || !isValidDelegation(delegation)))
  )
    throw new UnauthenticatedError("Gateway token has invalid principal claims");
  return {
    orgId,
    actorId,
    actorType,
    roles,
    scopes,
    ...(metadata === undefined ? {} : { metadata: metadata as Readonly<Record<string, unknown>> }),
    ...(isValidDelegation(delegation) ? { delegation } : {}),
  };
}

/** Verifies only explicitly allowed algorithms; JWT header algorithms are never trusted alone. */
export function gatewayJwtVerifier(options: GatewayJwtVerifierOptions): AppAuthVerifier {
  if (options.algorithms.length === 0)
    throw new TypeError("At least one JWT algorithm is required");
  if ((options.key === undefined) === (options.jwksUrl === undefined))
    throw new TypeError("Configure exactly one of key or jwksUrl");
  if (
    options.workspaceId !== undefined &&
    (options.algorithms.length !== 1 || options.algorithms[0] !== "ES256" || !options.jwksUrl)
  )
    throw new TypeError("Workspace-bound authentication requires ES256 remote public keys");
  if (
    options.workspaceId !== undefined &&
    ((options.cacheMaxAge ?? 60_000) < 1 ||
      (options.cacheMaxAge ?? 60_000) > 60_000 ||
      (options.clockTolerance ?? 0) !== 0)
  )
    throw new TypeError("Hosted key cache must be 1..60000ms with zero clock tolerance");
  const key =
    options.key ??
    createRemoteJWKSet(new URL(options.jwksUrl!), {
      cacheMaxAge: options.cacheMaxAge ?? 60_000,
      cooldownDuration: options.workspaceId === undefined ? 0 : 1000,
      timeoutDuration: 5000,
    });
  return {
    id: "gateway-jwt",
    verify(token: string): Promise<Principal> {
      return jwtVerify(token, key, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: [...options.algorithms],
        ...(options.clockTolerance === undefined ? {} : { clockTolerance: options.clockTolerance }),
      })
        .then(({ payload, protectedHeader }) => {
          if (
            options.workspaceId !== undefined &&
            (typeof protectedHeader.kid !== "string" ||
              !protectedHeader.kid ||
              protectedHeader.kid.length > 100 ||
              payload["orgId"] !== options.workspaceId ||
              payload.aud !== options.audience ||
              typeof payload.exp !== "number" ||
              typeof payload.iat !== "number" ||
              payload.exp <= payload.iat ||
              payload.exp - payload.iat > 300 ||
              payload.iat > Date.now() / 1000 + (options.clockTolerance ?? 0))
          )
            throw new UnauthenticatedError("Gateway token has invalid workspace or lifetime");
          return principalFromClaims(payload);
        })
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
  return {
    id: "local-dev",
    localDevelopmentOnly: true,
    verify: () => Promise.resolve(options.principal),
  };
}
