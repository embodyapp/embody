import { App } from "@modelcontextprotocol/ext-apps";
interface StandardInitialResult {
  readonly structuredContent?: unknown;
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
}
import { createGenUiController, type GenUiController } from "./controller.js";
import { mountGenUiWeb, type GenUiWebView } from "./web.js";
import { resolveGenUiPayload, type GenUiPayloadBinding } from "./payload.js";
import type { GenUiDocument } from "./document.js";
export interface GenUiAppRuntimeOptions {
  readonly container: HTMLElement;
  readonly status: HTMLElement;
  readonly readTarget: string;
  readonly readTargets: readonly string[];
  readonly tools: Readonly<Record<string, string>>;
  readonly present: (target: string, props: unknown) => unknown;
  readonly bindings: (document: GenUiDocument) => Readonly<Record<string, GenUiPayloadBinding>>;
}
/** Official result-attached standard App. Installed app code owns composition; resources contain no props. */
export async function startGenUiApp(
  options: GenUiAppRuntimeOptions,
): Promise<{ readonly app: App; dispose(): void }> {
  const app = new App({ name: "Embody standard view", version: "1.0.0" }, {}, { autoResize: true });
  let controller: GenUiController | undefined;
  let view: GenUiWebView | undefined;
  let disposed = false;
  let update: ReturnType<typeof setTimeout> | undefined;
  const lifetime = new AbortController();
  const refresh = options.container.ownerDocument.createElement("button");
  refresh.textContent = "Refresh authoritative state";
  const review = options.container.ownerDocument.createElement("button");
  review.textContent = "Discard draft and accept current state";
  review.hidden = true;
  let pendingDocument: GenUiDocument | undefined;
  function context(value: unknown) {
    if (!value || disposed || typeof value !== "object" || Array.isArray(value)) return;
    if ("theme" in value && (value.theme === "dark" || value.theme === "light"))
      options.container.style.colorScheme = value.theme;
    // No host CSS, URLs, font URLs or arbitrary style values are interpreted.
    if (
      "displayMode" in value &&
      (value.displayMode === "inline" ||
        value.displayMode === "fullscreen" ||
        value.displayMode === "pip")
    )
      options.container.dataset["displayMode"] = value.displayMode;
  }
  function replace(document: GenUiDocument, discardDraft = false) {
    if (disposed) return;
    const result = view?.update(document, { discardDraft });
    if (result === "review-required") {
      pendingDocument = document;
      review.hidden = false;
      options.status.textContent =
        "Current state changed. Review or discard the draft before submitting.";
    } else {
      pendingDocument = undefined;
      review.hidden = true;
    }
  }
  const dispatch = async (
    target: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const name = options.tools[target];
    const capabilities: unknown = app.getHostCapabilities();
    if (
      !name ||
      disposed ||
      capabilities === null ||
      typeof capabilities !== "object" ||
      !("serverTools" in capabilities) ||
      !capabilities.serverTools
    )
      throw new Error("View action unavailable");
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new Error("View input invalid");
    const result = await app.callServerTool(
      { name, arguments: input as Record<string, unknown> },
      { signal },
    );
    if (result.isError) {
      const code: unknown = result._meta?.["embody/errorCode"];
      throw Object.assign(new Error("View action unavailable"), {
        code:
          typeof code === "string" &&
          ["HOOK_VETO", "VALIDATION_ERROR", "FORBIDDEN", "NOT_FOUND"].includes(code)
            ? code
            : "UNCERTAIN_OUTCOME",
      });
    }
    if (result.structuredContent !== undefined) return result.structuredContent;
    const text = result.content.find((content) => content.type === "text");
    if (!text || text.type !== "text" || text.text.length > 1_048_576)
      throw new Error("View result unavailable");
    return JSON.parse(text.text) as unknown;
  };
  app.onhostcontextchanged = context;
  app.ontoolresult = (result: StandardInitialResult) => {
    if (disposed) return;
    // No revision is supplied by this domain. Do not apply unsolicited replacements over an active draft.
    if (controller) {
      options.status.textContent = "New result available; refresh authoritative state explicitly";
      return;
    }
    try {
      const text = result.content?.find((content) => content.type === "text");
      const props: unknown =
        result.structuredContent ??
        (text?.type === "text" && typeof text.text === "string" && text.text.length <= 1_048_576
          ? (JSON.parse(text.text) as unknown)
          : undefined);
      controller = createGenUiController({
        document: options.present(options.readTarget, props),
        callableTargets: Object.keys(options.tools),
        readTargets: options.readTargets,
        refresh: { target: options.readTarget, input: {} },
        present: options.present,
        resolveAction: (id, values) =>
          resolveGenUiPayload(options.bindings(controller!.document)[id], values),
        dispatch,
        isCurrent: () => !disposed,
      });
      view = mountGenUiWeb(options.container, controller.document, {
        callableTargets: controller.callableTargets,
        resolveAction: (id, values) =>
          resolveGenUiPayload(options.bindings(controller!.document)[id], values),
        onEvent: async (event) => {
          if (event.intent === "change") return;
          const delivery = await controller!.submit(event.nodeId, event.payload, event.signal);
          if (!disposed) {
            options.status.textContent = `${delivery.status}. ${delivery.reconciled ? "Authoritative state refreshed." : "Read current state before relying on it."} The host must record this outcome for the agent; otherwise explicitly reconcile.`;
            if (delivery.document)
              update = setTimeout(
                () => replace(delivery.document!, delivery.status === "confirmed"),
                0,
              );
          }
          return { status: delivery.status, reconciled: delivery.reconciled };
        },
      });
      context(app.getHostContext());
      options.container.after(refresh, review);
      options.status.textContent = "View connected";
    } catch {
      options.status.textContent = "Presentation unavailable; use ordinary text/JSON output";
    }
  };
  refresh.addEventListener("click", () => {
    if (disposed || refresh.disabled || !controller) return;
    refresh.disabled = true;
    void controller
      .refresh(lifetime.signal)
      .then((document) => replace(document))
      .catch(() => {
        view?.markStale();
        pendingDocument = undefined;
        review.hidden = true;
        options.status.textContent = "Refresh unavailable; do not rely on stale state";
      })
      .finally(() => {
        refresh.disabled = false;
      });
  });
  review.addEventListener("click", () => {
    if (pendingDocument) replace(pendingDocument, true);
  });
  function dispose() {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    if (update !== undefined) clearTimeout(update);
    view?.dispose();
    controller?.dispose();
    refresh.remove();
    review.remove();
    void (app as App & { close(): Promise<void> }).close();
  }
  app.onteardown = () => {
    dispose();
    return Promise.resolve({});
  };
  try {
    await app.connect();
    context(app.getHostContext());
  } catch {
    dispose();
    options.status.textContent = "Host unavailable; use ordinary text/JSON output";
  }
  return { app, dispose };
}
