import { z } from "zod";
import {
  GenUiDocumentError,
  parseGenUiDocument,
  parseGenUiEvent,
  type GenUiNode,
  type GenUiEventSchema,
} from "./document.js";

// Standard views must work with script-src policies that forbid unsafe-eval.
z.config({ jitless: true });
export interface GenUiWebEvent {
  readonly nodeId: string;
  readonly intent: "change" | "invoke" | "submit";
  readonly target?: string;
  readonly payload: unknown;
  readonly signal: AbortSignal;
}
export interface GenUiWebOutcome {
  readonly status: "confirmed" | "rejected" | "uncertain";
  readonly reconciled?: boolean;
}
export interface GenUiWebOptions {
  readonly callableTargets: readonly string[];
  readonly resolveAction?: (nodeId: string, values: Readonly<Record<string, string>>) => unknown;
  readonly onEvent: (
    event: GenUiWebEvent,
  ) => void | GenUiWebOutcome | Promise<void | GenUiWebOutcome>;
}
export interface GenUiWebView {
  /** Disable actions after a failed authoritative read; preserve editable drafts. */
  markStale(): void;
  update(
    document: unknown,
    options?: { readonly discardDraft?: boolean },
  ): "updated" | "review-required" | "busy" | "disposed";
  dispose(): void;
}
// Keep forwarding facades pointed at one active leaf, not a recursive chain of disposed views.
const activeReplacement = new WeakMap<GenUiWebView, GenUiWebView>();
function fixedPayload(schema: GenUiEventSchema): unknown {
  if (schema.type === "object")
    return Object.fromEntries(
      schema.required.map((key) => [key, fixedPayload(schema.properties[key]!)]),
    );
  if (schema.type === "string" && schema.enum?.length === 1) return schema.enum[0];
  throw new GenUiDocumentError("GenUI action requires a payload resolver");
}

/** DOM-only renderer. No supplied value is parsed as markup, CSS, a URL or executable code. */
export function mountGenUiWeb(
  container: HTMLElement,
  value: unknown,
  options: GenUiWebOptions,
): GenUiWebView {
  const document = parseGenUiDocument(value);
  const callableTargets = [...options.callableTargets];
  const dom = container.ownerDocument;
  const lifetime = new AbortController();
  let disposed = false;
  let busy = false;
  let dirty = false;
  let reviewRequired = false;
  let replacement: GenUiWebView | undefined;
  const cleanup: (() => void)[] = [];
  const controls: {
    element: HTMLInputElement | HTMLSelectElement | HTMLButtonElement;
    disabled: boolean;
  }[] = [];
  const fields: { id: string; input: HTMLInputElement | HTMLSelectElement; form?: string }[] = [];
  const element = (tag: string, text?: string) => {
    const result = dom.createElement(tag);
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const status = element("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-label", "Presentation status");
  status.setAttribute("aria-live", "polite");
  const listen = (target: HTMLElement, name: string, handler: (event: Event) => void) => {
    target.addEventListener(name, handler);
    cleanup.push(() => target.removeEventListener(name, handler));
  };
  const register = (
    control: HTMLInputElement | HTMLSelectElement | HTMLButtonElement,
    disabled: boolean,
  ) => {
    control.disabled = disabled;
    controls.push({ element: control, disabled });
  };
  const setBusy = (pending: boolean) => {
    busy = pending;
    container.setAttribute("aria-busy", String(pending));
    for (const control of controls)
      control.element.disabled =
        pending || control.disabled || (reviewRequired && control.element.tagName === "BUTTON");
  };
  const submit = async (
    nodeId: string,
    event: { intent: "submit" | "invoke"; target: string; schema: GenUiEventSchema },
    form?: string,
  ) => {
    if (disposed || busy || reviewRequired) return;
    let payload: unknown;
    try {
      const values = Object.fromEntries(
        fields
          .filter((field) => field.form === form && !field.input.disabled)
          .map((field) => {
            parseGenUiEvent(document, field.id, { value: field.input.value }, { callableTargets });
            return [field.id, field.input.value];
          }),
      );
      payload = options.resolveAction
        ? options.resolveAction(nodeId, Object.freeze(values))
        : fixedPayload(event.schema);
      payload = parseGenUiEvent(document, nodeId, payload, { callableTargets });
    } catch {
      status.textContent = "Invalid or unavailable action";
      return;
    }
    setBusy(true);
    status.textContent = "Submitting…";
    try {
      const outcome = await options.onEvent({
        nodeId,
        intent: event.intent,
        target: event.target,
        payload,
        signal: lifetime.signal,
      });
      if (
        !disposed &&
        outcome?.status === "confirmed" &&
        outcome.reconciled !== false &&
        event.intent === "submit"
      )
        dirty = false;
      if (
        !disposed &&
        (outcome?.status === "uncertain" ||
          (outcome?.status === "confirmed" && outcome.reconciled === false))
      )
        reviewRequired = true;
      if (!disposed)
        status.textContent =
          outcome?.status === "rejected"
            ? "Action rejected"
            : outcome?.status === "uncertain"
              ? "Outcome uncertain; read current state"
              : outcome?.status === "confirmed"
                ? "Action confirmed; refresh current state"
                : "Request handled; read current state";
    } catch {
      if (!disposed) {
        reviewRequired = true;
        status.textContent = "Outcome uncertain; read current state";
      }
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  const render = (
    node: GenUiNode,
    level = 1,
    inheritedDisabled = false,
    form?: string,
  ): HTMLElement => {
    const disabled =
      inheritedDisabled ||
      ("disabled" in node && !!node.disabled) ||
      ("pending" in node && !!node.pending);
    switch (node.type) {
      case "section": {
        const section = element("section");
        section.setAttribute("aria-label", node.title);
        section.append(element(`h${Math.min(level, 6)}`, node.title));
        for (const child of node.children) section.append(render(child, level + 1, disabled, form));
        return section;
      }
      case "stack":
      case "columns": {
        const layout = element("div");
        layout.className = `genui-${node.type}`;
        for (const child of node.children) layout.append(render(child, level, disabled, form));
        return layout;
      }
      case "text":
        return element("p", node.sensitive ? "[redacted]" : node.text);
      case "badge": {
        const badge = element("span", node.text);
        badge.className = "genui-badge";
        return badge;
      }
      case "callout":
      case "emptyState":
      case "errorState": {
        const state = element("p", node.text);
        state.setAttribute("role", node.type === "errorState" ? "alert" : "status");
        return state;
      }
      case "keyValue": {
        const list = element("dl");
        list.append(
          element("dt", node.label),
          element("dd", node.sensitive ? "[redacted]" : node.value),
        );
        return list;
      }
      case "list": {
        const list = element("ul");
        for (const child of node.items) {
          const item = element("li");
          item.append(render(child, level, disabled, form));
          list.append(item);
        }
        return list;
      }
      case "field":
      case "select": {
        const label = element("label", node.label);
        const input =
          node.type === "field" ? dom.createElement("input") : dom.createElement("select");
        input.name = node.id;
        input.setAttribute("aria-label", node.label);
        input.dataset["genuiId"] = node.id;
        if (node.type === "field" && input instanceof dom.defaultView!.HTMLInputElement) {
          input.type = node.sensitive ? "password" : "text";
          input.autocomplete = "off";
          const schema = node.event.schema;
          if (schema.type === "object" && schema.properties["value"]?.type === "string")
            input.maxLength = schema.properties["value"].maxLength;
        }
        if (node.type === "select")
          for (const [index, option] of node.options.entries()) {
            const choice = dom.createElement("option");
            choice.value = option.value;
            choice.textContent = node.sensitive ? `Option ${index + 1}` : option.label;
            input.append(choice);
          }
        input.value = node.value;
        register(input, disabled);
        fields.push({ id: node.id, input, ...(form === undefined ? {} : { form }) });
        label.append(input);
        listen(input, node.type === "field" ? "input" : "change", () => {
          if (disposed || busy || input.disabled) return;
          dirty = true;
          let payload: unknown;
          try {
            payload = parseGenUiEvent(
              document,
              node.id,
              { value: input.value },
              { callableTargets },
            );
            input.removeAttribute("aria-invalid");
          } catch {
            input.setAttribute("aria-invalid", "true");
            status.textContent = "Invalid input";
            return;
          }
          void Promise.resolve()
            .then(() =>
              disposed
                ? undefined
                : options.onEvent({
                    nodeId: node.id,
                    intent: "change",
                    payload,
                    signal: lifetime.signal,
                  }),
            )
            .catch(() => {
              if (!disposed) status.textContent = "Input was not accepted";
            });
        });
        return label;
      }
      case "form": {
        if (form !== undefined) throw new GenUiDocumentError("GenUI nested forms are unavailable");
        const result = dom.createElement("form");
        result.setAttribute("aria-label", node.label);
        result.setAttribute("aria-description", node.effect);
        for (const child of node.children) result.append(render(child, level, disabled, node.id));
        const button = dom.createElement("button");
        // Native form submission is suppressed by opaque iframe sandboxing. Use declared events only.
        button.type = "button";
        button.textContent = node.label;
        register(button, disabled || !callableTargets.includes(node.event.target));
        result.append(button);
        listen(button, "click", () => {
          if (!button.disabled) void submit(node.id, node.event, node.id);
        });
        listen(result, "keydown", (input) => {
          if (
            input instanceof dom.defaultView!.KeyboardEvent &&
            input.key === "Enter" &&
            !input.isComposing &&
            input.target instanceof dom.defaultView!.HTMLInputElement
          ) {
            input.preventDefault();
            if (!button.disabled) void submit(node.id, node.event, node.id);
          }
        });
        listen(result, "submit", (input) => {
          input.preventDefault();
          if (!button.disabled) void submit(node.id, node.event, node.id);
        });
        return result;
      }
      case "actions": {
        const group = element("div");
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", "Actions");
        for (const action of node.actions) {
          const button = dom.createElement("button");
          button.type = "button";
          button.textContent = action.label;
          button.setAttribute("aria-description", action.effect);
          register(
            button,
            disabled ||
              !!action.disabled ||
              !!action.pending ||
              !callableTargets.includes(action.event.target),
          );
          listen(button, "click", () => {
            if (!button.disabled) void submit(action.id, action.event, form);
          });
          group.append(button);
        }
        return group;
      }
    }
  };
  const root = element("div");
  root.className = "genui-view";
  const style = dom.createElement("style");
  style.textContent = `.genui-view{color-scheme:light dark;color:CanvasText;background:Canvas;font:inherit;padding:1rem;box-sizing:border-box;overflow-wrap:anywhere}.genui-view *{box-sizing:border-box;min-width:0}.genui-view p{white-space:pre-wrap}.genui-stack,.genui-view form{display:grid;gap:.75rem}.genui-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr));gap:1rem}.genui-view label{display:grid;gap:.25rem}.genui-view input,.genui-view select{width:100%;font:inherit;color:CanvasText;background:Canvas;padding:.5rem;border:1px solid GrayText}.genui-view button{font:inherit;padding:.5rem .75rem;margin:.25rem;color:ButtonText;background:ButtonFace;border:1px solid GrayText}.genui-view :focus-visible{outline:3px solid Highlight;outline-offset:2px}.genui-badge{display:inline-block;border:1px solid GrayText;border-radius:.25rem;padding:.15rem .35rem}.genui-view [aria-invalid=true]{outline:2px solid MarkText}@media(prefers-reduced-motion:reduce){.genui-view *{animation:none!important;transition:none!important}}@media(forced-colors:active){.genui-view :focus-visible{outline-color:Highlight}}`;
  root.append(style, render(document.root), status);
  container.replaceChildren(root);
  const view: GenUiWebView = {
    markStale() {
      if (replacement) return replacement.markStale();
      if (disposed) return;
      reviewRequired = true;
      setBusy(busy);
      status.textContent = "Snapshot stale; read current state before submitting";
    },
    update(next, updateOptions = {}) {
      if (replacement) {
        const result = replacement.update(next, updateOptions);
        replacement = activeReplacement.get(replacement) ?? replacement;
        activeReplacement.set(view, replacement);
        return result;
      }
      if (disposed) return "disposed";
      const parsed = parseGenUiDocument(next);
      if (busy) return "busy";
      if (dirty && !updateOptions.discardDraft) {
        reviewRequired = true;
        setBusy(false);
        status.textContent = "Data changed; review or discard your draft";
        return "review-required";
      }
      view.dispose();
      replacement = mountGenUiWeb(container, parsed, { ...options, callableTargets });
      activeReplacement.set(view, replacement);
      return "updated";
    },
    dispose() {
      if (replacement) replacement.dispose();
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      for (const remove of cleanup) remove();
      container.removeAttribute("aria-busy");
      root.remove();
    },
  };
  return view;
}
