/**
 * Minimal session handling. Identity/login is a swappable concern (the premium layer
 * can add SSO/SCIM); this in-memory store is enough for local dev and tests. A
 * session maps an opaque token to a Principal (user + org + roles).
 *
 * NOTE: we deliberately do not handle passwords here — authentication is the
 * responsibility of a pluggable identity provider.
 */
import { randomUUID } from "node:crypto";
import type { Principal } from "@embody/kernel";

export interface Session {
  token: string;
  principal: Principal;
  createdAt: Date;
}

export interface SessionStore {
  create(principal: Principal): Session;
  get(token: string): Session | null;
  revoke(token: string): void;
}

export class InMemorySessionStore implements SessionStore {
  #sessions = new Map<string, Session>();

  create(principal: Principal): Session {
    const session: Session = { token: randomUUID(), principal, createdAt: new Date() };
    this.#sessions.set(session.token, session);
    return session;
  }

  get(token: string): Session | null {
    return this.#sessions.get(token) ?? null;
  }

  revoke(token: string): void {
    this.#sessions.delete(token);
  }
}
