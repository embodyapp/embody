import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { UnauthenticatedError } from "@embody/core";
import { gatewayJwtVerifier, localDevVerifier } from "../src/index.js";

const secret = new TextEncoder().encode("a development secret which is at least thirty two bytes");
const claims = {
  orgId: "org-1",
  actorId: "user-1",
  actorType: "human" as const,
  roles: ["member"],
  scopes: ["kanban:*"],
};
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: "HS256", kid: "current" })
    .setIssuer("gateway")
    .setAudience("kanban")
    .setSubject("user-1")
    .setJti("token-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);
}

describe("gateway JWT verifier", () => {
  it("accepts only configured issuer, audience and algorithms", async () => {
    const verifier = gatewayJwtVerifier({
      issuer: "gateway",
      audience: "kanban",
      key: secret,
      algorithms: ["HS256"],
    });
    await expect(verifier.verify(await token())).resolves.toMatchObject({
      orgId: "org-1",
      actorId: "user-1",
    });
    await expect(verifier.verify(await token({ orgId: "" }))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    const wrongIssuer = new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("other")
      .setAudience("kanban")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);
    await expect(verifier.verify(await wrongIssuer)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
  it("does not enable local development authentication in production", () => {
    expect(() =>
      localDevVerifier({ enabled: true, environment: "production", principal: claims }),
    ).toThrow("disabled");
  });
});

describe("delegation claims", () => {
  const verifier = () =>
    gatewayJwtVerifier({
      issuer: "gateway",
      audience: "kanban",
      key: secret,
      algorithms: ["HS256"],
    });

  it("round-trips a delegated agent", async () => {
    const delegation = { subjectId: "user-1", subjectType: "human", client: "claude" };
    await expect(
      verifier().verify(await token({ actorType: "agent", actorId: "claude:user-1", delegation })),
    ).resolves.toMatchObject({ actorType: "agent", delegation });
  });

  it("rejects delegation on non-agent principals and malformed delegation", async () => {
    for (const overrides of [
      { delegation: { subjectId: "user-1", subjectType: "human" } },
      { actorType: "agent", delegation: { subjectId: "", subjectType: "human" } },
      { actorType: "agent", delegation: { subjectId: "u", subjectType: "agent" } },
      { actorType: "agent", delegation: { subjectId: "u", subjectType: "human", extra: 1 } },
      { actorType: "agent", delegation: "user-1" },
    ])
      await expect(verifier().verify(await token(overrides))).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
  });
});
