/**
 * The egress policy, tested adversarially.
 *
 * This is the only thing standing between "a workflow can call an API" and "a workflow
 * row can make the server read cloud credentials off the metadata endpoint". The cases
 * below are the actual techniques, not hypotheticals.
 */
import { describe, it, expect } from "vitest";
import { assertEgressAllowed, allowedHostsFromEnv, resolveSecrets, EgressDenied } from "./egress.ts";

const policy = { allowedHosts: ["api.stripe.com", ".hooks.slack.com"] };

describe("allowed destinations", () => {
  it("permits an exact host over https", () => {
    expect(assertEgressAllowed("https://api.stripe.com/v1/charges", policy).hostname).toBe(
      "api.stripe.com",
    );
  });

  it("permits a subdomain of a leading-dot entry", () => {
    expect(() => assertEgressAllowed("https://west.hooks.slack.com/x", policy)).not.toThrow();
    // …and the bare domain itself.
    expect(() => assertEgressAllowed("https://hooks.slack.com/x", policy)).not.toThrow();
  });

  it("returns the parsed URL so the caller cannot check one string and fetch another", () => {
    const url = assertEgressAllowed("https://api.stripe.com/v1?a=1", policy);
    expect(url.href).toBe("https://api.stripe.com/v1?a=1");
  });
});

describe("SSRF defences", () => {
  it("blocks the cloud metadata endpoint even if someone allowlists it", () => {
    // The single most valuable SSRF target: IAM credentials, no auth required.
    expect(() =>
      assertEgressAllowed("https://169.254.169.254/latest/meta-data/", {
        allowedHosts: ["169.254.169.254"],
      }),
    ).toThrow(/link-local \/ cloud metadata/);
    expect(() =>
      assertEgressAllowed("https://metadata.google.internal/x", {
        allowedHosts: ["metadata.google.internal"],
      }),
    ).toThrow(EgressDenied);
  });

  it("blocks loopback and private ranges regardless of the allowlist", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "0.0.0.0",
      "db.internal",
      "printer.local",
    ]) {
      expect(() =>
        assertEgressAllowed(`https://${host}/admin`, { allowedHosts: [host] }),
      ).toThrow(EgressDenied);
    }
  });

  it("does not block a public address that merely looks private", () => {
    // 172.32.x is outside 172.16.0.0/12 — over-blocking is a real bug too.
    expect(() =>
      assertEgressAllowed("https://172.32.0.1/x", { allowedHosts: ["172.32.0.1"] }),
    ).not.toThrow();
  });

  it("blocks IPv6 loopback and link-local", () => {
    for (const host of ["[::1]", "[fe80::1]", "[fd00::1]"]) {
      expect(() => assertEgressAllowed(`https://${host}/`, { allowedHosts: [host] })).toThrow(
        EgressDenied,
      );
    }
  });

  it("refuses a host that is not allowlisted, and says how to fix it", () => {
    expect(() => assertEgressAllowed("https://evil.example.com/x", policy)).toThrow(
      /not in the deployment's allowedHosts/,
    );
  });

  it("is not fooled by a suffix that is not a subdomain", () => {
    // "notstripe.com" must not match "api.stripe.com", and
    // "evilhooks.slack.com.attacker.test" must not match ".hooks.slack.com".
    expect(() => assertEgressAllowed("https://api.stripe.com.evil.test/x", policy)).toThrow();
    expect(() => assertEgressAllowed("https://xapi.stripe.com/x", policy)).toThrow();
    // The classic one: a leading-dot entry must match a dot boundary, so
    // "evilhooks.slack.com" is not a subdomain of ".hooks.slack.com".
    expect(() => assertEgressAllowed("https://evilhooks.slack.com/x", policy)).toThrow();
  });

  it("refuses plain http unless explicitly permitted", () => {
    expect(() => assertEgressAllowed("http://api.stripe.com/x", policy)).toThrow(/plain http/);
    expect(() =>
      assertEgressAllowed("http://api.stripe.com/x", { ...policy, allowInsecure: true }),
    ).not.toThrow();
  });

  it("refuses non-http protocols", () => {
    for (const url of ["file:///etc/passwd", "gopher://api.stripe.com/", "ftp://api.stripe.com/"]) {
      expect(() => assertEgressAllowed(url, { allowedHosts: ["api.stripe.com"] })).toThrow(
        EgressDenied,
      );
    }
  });

  it("refuses credentials embedded in the URL", () => {
    expect(() => assertEgressAllowed("https://user:pw@api.stripe.com/x", policy)).toThrow(
      /credentials in the URL/,
    );
  });

  it("refuses a malformed URL rather than passing it to fetch", () => {
    expect(() => assertEgressAllowed("not a url", policy)).toThrow(/not a valid URL/);
  });

  it("denies everything when the allowlist is empty", () => {
    // Fail closed: a misconfigured deployment must not become open egress.
    expect(() => assertEgressAllowed("https://api.stripe.com/x", { allowedHosts: [] })).toThrow(
      EgressDenied,
    );
  });
});

describe("allowedHostsFromEnv", () => {
  it("splits, trims, and lowercases", () => {
    expect(allowedHostsFromEnv({ EMBODY_HTTP_ALLOWED_HOSTS: " API.Stripe.com , .slack.com " }))
      .toEqual(["api.stripe.com", ".slack.com"]);
  });

  it("is empty when unset, so the default is deny-all", () => {
    expect(allowedHostsFromEnv({})).toEqual([]);
  });
});

describe("resolveSecrets", () => {
  const env = { EMBODY_HTTP_SECRET_SLACK: "xoxb-real-token" };

  it("substitutes a configured secret", () => {
    expect(resolveSecrets("Bearer {{secret:SLACK}}", env)).toBe("Bearer xoxb-real-token");
  });

  it("is case-insensitive on the reference", () => {
    expect(resolveSecrets("{{ secret:slack }}", env)).toBe("xoxb-real-token");
  });

  it("throws for an unconfigured secret rather than sending the literal text", () => {
    // Sending "Bearer {{secret:MISSING}}" to a third party would leak the shape of the
    // config and silently fail auth.
    expect(() => resolveSecrets("Bearer {{secret:MISSING}}", env)).toThrow(
      /secret "MISSING" is not configured/,
    );
  });

  it("leaves ordinary text alone", () => {
    expect(resolveSecrets("application/json", env)).toBe("application/json");
  });
});
