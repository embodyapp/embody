/**
 * The error taxonomy is the bridge's real contract with a UI: the status code decides
 * whether a client re-renders a form, disables a control, shows a rule's message, or
 * says "something went wrong". These cases pin that mapping, including the two rules
 * that are easy to get wrong — unwrapping a HookVetoError, and never leaking an
 * internal message.
 *
 * Run: `pnpm --filter @embody/host exec vitest run`
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AuthorizationError, HookVetoError } from "@embody/kernel";
import { EntityNotFoundError } from "@embody/plugin-sdk";
import { toHttpError, UnauthenticatedError, UnavailableError } from "./errors.ts";

/** A real ZodError, so we test what the executor actually throws. */
const zodError = () => {
  const parsed = z.object({ id: z.string().uuid() }).safeParse({ id: "nope" });
  if (parsed.success) throw new Error("expected a parse failure");
  return parsed.error;
};

describe("toHttpError", () => {
  it("maps an authorization failure to 403 denied, message intact", () => {
    const { status, body } = toHttpError(new AuthorizationError("write", "crm:deal"), "crm_update_deal");
    expect(status).toBe(403);
    expect(body.error.kind).toBe("denied");
    expect(body.error.message).toMatch(/Not authorized to write crm:deal/);
    expect(body.error.tool).toBe("crm_update_deal");
  });

  it("maps a missing entity to 404 not_found", () => {
    const { status, body } = toHttpError(new EntityNotFoundError("crm.deal", "abc"));
    expect(status).toBe(404);
    expect(body.error.kind).toBe("not_found");
  });

  it("maps invalid input to 400 and forwards the Zod issues", () => {
    const { status, body } = toHttpError(zodError(), "crm_get_deal");
    expect(status).toBe(400);
    expect(body.error.kind).toBe("invalid_input");
    expect(Array.isArray(body.error.details)).toBe(true);
    expect((body.error.details as unknown[]).length).toBeGreaterThan(0);
  });

  it("maps an unknown tool to 404 unknown_tool", () => {
    const { status, body } = toHttpError(new Error('Unknown tool "nope"'), "nope");
    expect(status).toBe(404);
    expect(body.error.kind).toBe("unknown_tool");
  });

  it("maps a domain veto to 409, naming the hook and plugin", () => {
    const veto = new HookVetoError(
      "crm.deal.beforeUpdate",
      "b2b-saas",
      "Enterprise deals over $50,000 require an approved security review.",
      { cause: new Error("Enterprise deals over $50,000 require an approved security review.") },
    );
    const { status, body, logAs } = toHttpError(veto, "crm_update_deal");
    expect(status).toBe(409);
    expect(body.error.kind).toBe("veto");
    // The rule's own sentence, verbatim and unadorned — this string goes into a toast,
    // so the kernel's `Hook "..." vetoed by plugin "..."` wrapper is stripped and the
    // same facts are carried in `details` instead.
    expect(body.error.message).toBe(
      "Enterprise deals over $50,000 require an approved security review.",
    );
    expect(body.error.details).toEqual({ hook: "crm.deal.beforeUpdate", plugin: "b2b-saas" });
    expect(logAs).toBeUndefined();
  });

  it("falls back to the wrapper message when a hook threw a non-Error", () => {
    const veto = new HookVetoError("crm.deal.beforeUpdate", "acme-crm", "nope", {
      cause: "nope",
    });
    expect(toHttpError(veto).body.error.message).toMatch(/vetoed by plugin "acme-crm"/);
  });

  it("unwraps a framework error raised INSIDE a hook rather than calling it a veto", () => {
    // A rule that calls req.assert is enforcing permissions, not vetoing.
    const denied = new HookVetoError("crm.deal.beforeUpdate", "acme-crm", "nope", {
      cause: new AuthorizationError("write", "crm:deal"),
    });
    expect(toHttpError(denied).status).toBe(403);
    expect(toHttpError(denied).body.error.kind).toBe("denied");

    const missing = new HookVetoError("crm.deal.beforeUpdate", "acme-crm", "nope", {
      cause: new EntityNotFoundError("crm.deal", "abc"),
    });
    expect(toHttpError(missing).status).toBe(404);

    const invalid = new HookVetoError("crm.deal.beforeUpdate", "acme-crm", "nope", {
      cause: zodError(),
    });
    expect(toHttpError(invalid).status).toBe(400);
  });

  it("treats a driver error inside a hook as internal, not as a veto", () => {
    // A unique-constraint violation is a bug or a race, not a domain decision — and
    // its message is not written for a user.
    const pgError = Object.assign(new Error("duplicate key value"), {
      code: "23505",
      severity: "ERROR",
    });
    const wrapped = new HookVetoError("crm.deal.beforeCreate", "crm", "duplicate key value", {
      cause: pgError,
    });
    const { status, body, logAs } = toHttpError(wrapped, "crm_create_deal");
    expect(status).toBe(500);
    expect(body.error.kind).toBe("internal");
    expect(body.error.message).toBe("Internal error");
    expect(logAs).toBe(wrapped);
  });

  it("redacts an unexpected error and hands the original to the caller for logging", () => {
    const bug = new TypeError("cannot read properties of undefined (reading 'id')");
    const { status, body, logAs } = toHttpError(bug, "crm_query_deals");
    expect(status).toBe(500);
    expect(body.error.kind).toBe("internal");
    expect(body.error.message).toBe("Internal error");
    expect(JSON.stringify(body)).not.toMatch(/cannot read properties/);
    expect(logAs).toBe(bug);
  });

  it("maps the API layer's own errors", () => {
    expect(toHttpError(new UnauthenticatedError()).status).toBe(401);
    expect(toHttpError(new UnauthenticatedError()).body.error.kind).toBe("unauthenticated");
    expect(toHttpError(new UnavailableError("login disabled")).status).toBe(501);
    expect(toHttpError(new UnavailableError("login disabled")).body.error.kind).toBe("unavailable");
  });

  it("omits `tool` when the failure was not a tool call", () => {
    expect(toHttpError(new UnauthenticatedError()).body.error.tool).toBeUndefined();
  });
});
