export type EmbodyErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "HOOK_VETO"
  | "DEPENDENCY_ERROR"
  | "DUPLICATE_REGISTRATION"
  | "UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export class EmbodyError extends Error {
  public constructor(
    public readonly code: EmbodyErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: readonly ValidationIssue[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends EmbodyError {
  public constructor(message = "Input is invalid", details?: readonly ValidationIssue[]) {
    super("VALIDATION_ERROR", message, 422, details);
  }
}
export class UnauthenticatedError extends EmbodyError {
  public constructor(message = "Authentication is required") {
    super("UNAUTHENTICATED", message, 401);
  }
}
export class ForbiddenError extends EmbodyError {
  public constructor(message = "Permission denied") {
    super("FORBIDDEN", message, 403);
  }
}
export class NotFoundError extends EmbodyError {
  public constructor(message = "Resource not found") {
    super("NOT_FOUND", message, 404);
  }
}
export class ConflictError extends EmbodyError {
  public constructor(message = "Resource conflict") {
    super("CONFLICT", message, 409);
  }
}
export class HookVetoError extends EmbodyError {
  public constructor(message = "Operation rejected by a guardrail") {
    super("HOOK_VETO", message, 422);
  }
}
export class DependencyError extends EmbodyError {
  public constructor(message = "Required dependency is unavailable") {
    super("DEPENDENCY_ERROR", message, 500);
  }
}
export class DuplicateRegistrationError extends EmbodyError {
  public constructor(message = "Registration already exists") {
    super("DUPLICATE_REGISTRATION", message, 409);
  }
}
export class UnavailableError extends EmbodyError {
  public constructor(message = "Service unavailable") {
    super("UNAVAILABLE", message, 503);
  }
}
export class InternalError extends EmbodyError {
  public constructor(message = "An internal error occurred", options?: ErrorOptions) {
    super("INTERNAL_ERROR", message, 500, undefined, options);
  }
}

export interface ErrorEnvelope {
  readonly error: {
    readonly code: EmbodyErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details?: readonly ValidationIssue[];
  };
}

export function toErrorEnvelope(
  error: unknown,
  requestId: string,
  environment: "development" | "production" = "production",
): { readonly status: number; readonly body: ErrorEnvelope } {
  const known = error instanceof EmbodyError;
  const normalized = known
    ? error
    : new InternalError(
        environment === "development" && error instanceof Error
          ? error.message
          : "An internal error occurred",
        error instanceof Error ? { cause: error } : undefined,
      );
  const details = normalized.details;
  return {
    status: normalized.status,
    body: {
      error: {
        code: normalized.code,
        message: normalized.message,
        requestId,
        ...(details === undefined ? {} : { details }),
      },
    },
  };
}
