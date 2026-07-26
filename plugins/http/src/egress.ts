/**
 * Egress policy: which URLs an automation is allowed to call.
 *
 * This file exists because of one specific hazard. A workflow's action and its inputs
 * are *data in the database*, editable at runtime by anyone with `write` on
 * `automation:workflow`. Give that data a generic "make an HTTP request" tool and you
 * have built a confused deputy: a config row can make your server POST to
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and mail the
 * result somewhere, or reach an internal admin panel that is firewalled from the
 * internet but not from your own app server. This is SSRF, and it is the most common
 * serious vulnerability in workflow engines.
 *
 * The mitigation is that the allowlist lives in **deployment configuration**, never in
 * the database. The database is exactly the thing an attacker who reaches the
 * automation tools can already edit; an allowlist stored there would protect nothing.
 *
 * Pure functions, no I/O, so the policy is testable on its own.
 */

export interface EgressPolicy {
  /**
   * Hosts that may be called. `api.stripe.com` matches that host exactly;
   * `.example.com` matches any subdomain of it. There is deliberately no `*` — an
   * allowlist that can be set to "everything" is not an allowlist, and the failure
   * mode of forgetting it is unrestricted egress.
   */
  allowedHosts: readonly string[];
  /** Permit plain HTTP. Off by default: credentials in a webhook call deserve TLS. */
  allowInsecure?: boolean;
}

export class EgressDenied extends Error {
  constructor(reason: string) {
    super(`Egress denied: ${reason}`);
    this.name = "EgressDenied";
  }
}

/**
 * Literal IPs that must never be reachable, whatever the allowlist says.
 *
 * Checked even for an allowlisted host, because "allowlisted" is about intent and this
 * is about reach: `localhost.mycompany.com` resolving to 127.0.0.1 is a real technique.
 */
const BLOCKED_PATTERNS: { test: (host: string) => boolean; why: string }[] = [
  { test: (h) => h === "localhost" || h.endsWith(".localhost"), why: "localhost" },
  { test: (h) => h === "127.0.0.1" || h.startsWith("127."), why: "loopback" },
  { test: (h) => h === "::1" || h === "[::1]", why: "IPv6 loopback" },
  { test: (h) => h === "0.0.0.0", why: "unspecified address" },
  { test: (h) => h.startsWith("10."), why: "private range 10.0.0.0/8" },
  { test: (h) => h.startsWith("192.168."), why: "private range 192.168.0.0/16" },
  {
    test: (h) => /^172\.(1[6-9]|2\d|3[01])\./.test(h),
    why: "private range 172.16.0.0/12",
  },
  { test: (h) => h.startsWith("169.254."), why: "link-local / cloud metadata" },
  { test: (h) => h.startsWith("[fd") || h.startsWith("[fc"), why: "IPv6 unique-local" },
  { test: (h) => h.startsWith("[fe80"), why: "IPv6 link-local" },
  { test: (h) => h.endsWith(".internal") || h.endsWith(".local"), why: "internal TLD" },
  { test: (h) => h === "metadata.google.internal", why: "cloud metadata" },
];

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith(".")) return host === pattern.slice(1) || host.endsWith(pattern);
    return host === pattern;
  });
}

/**
 * Throw unless `rawUrl` is permitted. Returns the parsed URL so a caller cannot
 * accidentally check one string and fetch another.
 */
export function assertEgressAllowed(rawUrl: string, policy: EgressPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressDenied(`"${rawUrl}" is not a valid URL`);
  }

  if (url.protocol !== "https:" && !(policy.allowInsecure && url.protocol === "http:")) {
    throw new EgressDenied(
      url.protocol === "http:"
        ? "plain http is not permitted (set allowInsecure to override)"
        : `protocol "${url.protocol}" is not permitted`,
    );
  }

  const host = url.hostname.toLowerCase();
  const blocked = BLOCKED_PATTERNS.find((p) => p.test(host));
  if (blocked) throw new EgressDenied(`${host} is a ${blocked.why} address`);

  if (!hostAllowed(host, policy.allowedHosts)) {
    throw new EgressDenied(
      `${host} is not in the deployment's allowedHosts. Add it to the http plugin's ` +
        `configuration — this list is deliberately not editable at runtime.`,
    );
  }

  // Credentials in the URL would be invisible in a workflow row's rendering and are
  // never the right way to authenticate.
  if (url.username || url.password) {
    throw new EgressDenied("credentials in the URL are not permitted; use a secret");
  }

  return url;
}

/**
 * Read allowlisted hosts from the environment.
 *
 * Env rather than the config file so a deployment can widen egress per environment
 * without a code change, and — more importantly — so the value lives where the
 * database cannot reach it.
 */
export function allowedHostsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env.EMBODY_HTTP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Resolve `{{secret:NAME}}` references against the environment.
 *
 * Header values in a workflow row must never contain the API key itself: the row is
 * readable by anyone who can list automations, and it ends up in backups and logs. A
 * reference keeps the secret in the deployment's environment where it belongs.
 */
export function resolveSecrets(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return value.replace(/\{\{\s*secret:([A-Z0-9_]+)\s*\}\}/gi, (_, name: string) => {
    const key = `EMBODY_HTTP_SECRET_${name.toUpperCase()}`;
    const secret = env[key];
    if (secret === undefined) {
      throw new EgressDenied(`secret "${name}" is not configured (expected ${key})`);
    }
    return secret;
  });
}
