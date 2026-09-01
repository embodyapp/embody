import { describe, expect, it } from "vitest";
import {
  ConflictError,
  DependencyError,
  DuplicateRegistrationError,
  ForbiddenError,
  HookVetoError,
  InternalError,
  NotFoundError,
  UnauthenticatedError,
  UnavailableError,
  ValidationError,
  toErrorEnvelope,
} from "../src/index.js";

describe("structured errors", () => {
  it.each([
    [
      new ValidationError("bad", [{ path: ["title"], message: "Required" }]),
      422,
      "VALIDATION_ERROR",
    ],
    [new UnauthenticatedError(), 401, "UNAUTHENTICATED"],
    [new ForbiddenError(), 403, "FORBIDDEN"],
    [new NotFoundError(), 404, "NOT_FOUND"],
    [new ConflictError(), 409, "CONFLICT"],
    [new HookVetoError("blocked"), 422, "HOOK_VETO"],
    [new DependencyError("missing"), 500, "DEPENDENCY_ERROR"],
    [new DuplicateRegistrationError("duplicate"), 409, "DUPLICATE_REGISTRATION"],
    [new UnavailableError(), 503, "UNAVAILABLE"],
    [new InternalError(), 500, "INTERNAL_ERROR"],
  ] as const)("maps %s to a safe envelope", (error, status, code) => {
    expect(toErrorEnvelope(error, "req-1", "production")).toEqual({
      status,
      body: {
        error: expect.objectContaining({ code, requestId: "req-1" }),
      },
    });
  });

  it("does not leak unknown production errors", () => {
    const result = toErrorEnvelope(new Error("password=secret SQL SELECT"), "req-2", "production");
    expect(result).toEqual({
      status: 500,
      body: {
        error: {
          code: "INTERNAL_ERROR",
          message: "An internal error occurred",
          requestId: "req-2",
        },
      },
    });
  });
});
