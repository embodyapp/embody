import { importPKCS8, importJWK, exportJWK, type JWK } from "jose";
import type { GatewayTokenOptions } from "./index.js";

/** Load gateway-only signing material; validate every published key before serving it. */
export async function hostedSigningIdentity(options: {
  issuer: string;
  kid: string;
  privateKeyPem: string;
  publicKeys: readonly JWK[];
}): Promise<GatewayTokenOptions> {
  if (!options.issuer || !options.kid || options.publicKeys.length === 0)
    throw new TypeError("Hosted signing identity requires issuer, kid and public keys");
  const publicJwks = publicSigningKeys(options.publicKeys);
  for (const key of publicJwks.keys) {
    await importJWK(key, "ES256");
  }
  const key = await importPKCS8(options.privateKeyPem, "ES256", { extractable: true });
  const derived = await exportJWK(key);
  const active = publicJwks.keys.find((item) => item.kid === options.kid);
  if (!active || active.x !== derived.x || active.y !== derived.y)
    throw new TypeError("Active public key does not match signing key");
  return {
    issuer: options.issuer,
    key: await importPKCS8(options.privateKeyPem, "ES256"),
    kid: options.kid,
    algorithm: "ES256",
    publicJwks,
  };
}

/** Reject secret fields and copy only the fields needed for public verification. */
export function publicSigningKeys(keys: readonly JWK[]): { keys: JWK[] } {
  const isArray = (value: unknown): boolean => Array.isArray(value);
  if (!isArray(keys) || keys.length === 0 || keys.length > 10)
    throw new TypeError("JWKS requires 1..10 public signing keys");
  const seen = new Set<string>();
  for (const key of keys) {
    if (
      !key ||
      key.kty !== "EC" ||
      key.crv !== "P-256" ||
      key.alg !== "ES256" ||
      key.use !== "sig" ||
      typeof key.kid !== "string" ||
      !key.kid ||
      key.kid.length > 100 ||
      typeof key.x !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(key.x) ||
      typeof key.y !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(key.y) ||
      seen.has(key.kid) ||
      key.d !== undefined ||
      key.k !== undefined ||
      (key.key_ops !== undefined &&
        (!Array.isArray(key.key_ops) || key.key_ops.some((op: unknown) => op !== "verify")))
    )
      throw new TypeError("JWKS must contain unique public ES256 signing keys only");
    seen.add(key.kid);
  }
  return {
    keys: keys.map(({ kid, x, y }) => ({
      kty: "EC",
      crv: "P-256",
      alg: "ES256",
      use: "sig",
      kid: kid!,
      x: x!,
      y: y!,
    })),
  };
}
