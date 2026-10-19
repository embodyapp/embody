import { decodeJwt } from "jose";

export interface CloudRunInvocationOptions {
  /** Provisioned gateway workload identity; must match the metadata token's email. */
  readonly serviceAccountEmail: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Obtain private Cloud Run invocation tokens from gateway workload identity only.
 * No caller keys, ADC files, impersonation or caller-controlled metadata URLs are accepted.
 */
export function cloudRunInvocationToken(
  options: CloudRunInvocationOptions,
): (origin: string) => Promise<string> {
  if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(options.serviceAccountEmail))
    throw new TypeError("Cloud Run invocation requires the provisioned gateway service account");
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { token: string; expires: number }>();
  return async (origin) => {
    const audience = new URL(origin);
    if (
      audience.protocol !== "https:" ||
      !audience.hostname.endsWith(".run.app") ||
      audience.origin !== origin ||
      audience.username ||
      audience.password
    )
      throw new TypeError("Cloud Run audience must be an admitted HTTPS origin");
    const cached = cache.get(origin);
    if (cached && cached.expires > now() + 60_000) return cached.token;
    cache.delete(origin);
    const url = new URL(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
    );
    url.searchParams.set("audience", origin);
    url.searchParams.set("format", "full");
    const response = await fetcher(url, {
      headers: { "Metadata-Flavor": "Google" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || response.headers.get("metadata-flavor") !== "Google")
      throw new Error("Gateway workload identity is unavailable");
    const token = await response.text();
    if (token.length > 16_384 || /\s/.test(token))
      throw new Error("Invalid workload identity response");
    // Metadata is the trusted local issuer channel. Cloud Run performs signature verification.
    // Validate the audience/identity/lifetime here to fail closed on wiring mistakes.
    const claims = decodeJwt(token);
    const seconds = Math.floor(now() / 1000);
    if (
      (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") ||
      claims.aud !== origin ||
      claims["email"] !== options.serviceAccountEmail ||
      claims["email_verified"] !== true ||
      typeof claims.exp !== "number" ||
      typeof claims.iat !== "number" ||
      claims.iat > seconds + 5 ||
      claims.exp <= seconds + 60 ||
      claims.exp - claims.iat > 3600
    )
      throw new Error("Workload identity does not match admitted invocation");
    // Bound process-local memory; cold starts reacquire tokens rather than persisting credentials.
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    cache.set(origin, { token, expires: claims.exp * 1000 });
    return token;
  };
}
