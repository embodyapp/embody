import { z } from "zod";
import { mountGenUiWeb, type GenUiWebView } from "./web.js";
import { resolveGenUiPayload } from "./payload.js";
const bootstrapSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  document: z.unknown(),
  callableTargets: z.array(z.string().max(256)).max(100),
  bindings: z.record(z.string().max(63), z.unknown()),
});
const deliverySchema = z.object({
  status: z.enum(["confirmed", "rejected", "uncertain"]),
  document: z.unknown().optional(),
  reconciled: z.boolean(),
  recorded: z.boolean(),
  bindings: z.record(z.string().max(63), z.unknown()).optional(),
});
/** Browser-owned capability is held only in this closure, never local/session storage or URL queries. */
export async function startGenUiBrowser(
  container: HTMLElement,
  status: HTMLElement,
): Promise<() => void> {
  const browser = container.ownerDocument.defaultView;
  if (!browser) throw new Error("Browser presentation unavailable");
  const window = browser;
  let token = window.location.hash.slice(1);
  window.history.replaceState(null, "", window.location.pathname);
  const lifetime = new AbortController();
  let view: GenUiWebView | undefined;
  let update: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let dirty = false;
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!dirty || disposed) return;
    event.preventDefault();
    event.returnValue = "";
  };
  const refresh = container.ownerDocument.createElement("button");
  refresh.textContent = "Refresh authoritative state";
  const discard = container.ownerDocument.createElement("button");
  discard.textContent = "Discard draft and accept current state";
  discard.hidden = true;
  let pendingDocument: unknown;
  let bindings: Record<string, unknown> = {};
  async function request(path: string, body?: unknown): Promise<unknown> {
    const response = await window.fetch(path, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? "{}" : JSON.stringify(body),
      signal: lifetime.signal,
    });
    if (!response.ok) throw new Error("Browser presentation unavailable");
    const text = await response.text();
    if (text.length > 1_048_576) throw new Error("Browser presentation unavailable");
    return JSON.parse(text) as unknown;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    // The session capability authorizes only this view, and is never added to a navigation URL.
    void window
      .fetch("/close", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "omit",
        keepalive: true,
      })
      .catch(() => {});
    token = "";
    lifetime.abort();
    if (update !== undefined) clearTimeout(update);
    view?.dispose();
    refresh.remove();
    discard.remove();
    window.removeEventListener("pagehide", dispose);
    window.removeEventListener("beforeunload", beforeUnload);
  }
  function replace(document: unknown, explicit = false) {
    if (disposed) return;
    const result = view?.update(document, { discardDraft: explicit });
    if (result === "review-required") {
      pendingDocument = document;
      discard.hidden = false;
      status.textContent = "Current state changed. Review or discard your draft before submitting.";
    } else {
      discard.hidden = true;
      pendingDocument = undefined;
      if (explicit) dirty = false;
    }
  }
  refresh.addEventListener("click", () => {
    if (refresh.disabled || disposed) return;
    refresh.disabled = true;
    void request("/refresh")
      .then((result) => {
        const parsed = z
          .strictObject({ document: z.unknown(), bindings: z.record(z.string(), z.unknown()) })
          .parse(result);
        bindings = parsed.bindings;
        replace(parsed.document);
        status.textContent = discard.hidden ? "Authoritative state refreshed" : status.textContent;
      })
      .catch(() => {
        view?.markStale();
        pendingDocument = undefined;
        discard.hidden = true;
        status.textContent = "Refresh unavailable; do not rely on stale state";
      })
      .finally(() => {
        refresh.disabled = false;
      });
  });
  discard.addEventListener("click", () => replace(pendingDocument, true));
  window.addEventListener("pagehide", dispose);
  window.addEventListener("beforeunload", beforeUnload);
  try {
    const result = bootstrapSchema.parse(await request("/session"));
    token = result.token;
    bindings = result.bindings;
    view = mountGenUiWeb(container, result.document, {
      callableTargets: result.callableTargets,
      resolveAction: (id, values) => resolveGenUiPayload(bindings[id], values),
      onEvent: async (event) => {
        if (event.intent === "change") {
          dirty = true;
          return;
        }
        refresh.disabled = true;
        try {
          const delivery = deliverySchema.parse(
            await request("/action", { nodeId: event.nodeId, payload: event.payload }),
          );
          if (!disposed) {
            if (delivery.status === "confirmed" && delivery.reconciled) dirty = false;
            if (delivery.bindings !== undefined) bindings = delivery.bindings;
            status.textContent = `${delivery.status}. ${delivery.reconciled ? "Authoritative state refreshed." : "Read current state before relying on it."} ${delivery.recorded ? "Outcome recorded by host." : "Agent visibility unavailable; explicitly reconcile with the agent."}`;
            if (delivery.document !== undefined)
              update = setTimeout(
                () => replace(delivery.document, delivery.status === "confirmed"),
                0,
              );
          }
          return { status: delivery.status, reconciled: delivery.reconciled };
        } finally {
          refresh.disabled = false;
        }
      },
    });
    container.after(refresh, discard);
    status.textContent = "Temporary view connected";
    return dispose;
  } catch {
    dispose();
    container.replaceChildren();
    status.textContent = "Presentation unavailable or expired";
    return dispose;
  }
}
