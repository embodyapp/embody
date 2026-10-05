import {
  Input,
  matchesKey,
  Key,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { parseGenUiEvent, type GenUiNode } from "@embody/genui/document";
import { renderGenUiText } from "@embody/genui/text";
import type { GenUiController, GenUiDelivery } from "@embody/genui/controller";
export interface PiGenUiComponentOptions {
  readonly controller: GenUiController;
  readonly requestRender: () => void;
  readonly onClose: () => void;
  readonly publishOutcome: (outcome: Omit<GenUiDelivery, "document">) => Promise<void>;
  readonly style?: (role: "accent" | "muted" | "error", text: string) => string;
  readonly matches?: (
    data: string,
    action:
      | "tui.input.tab"
      | "tui.select.confirm"
      | "tui.select.cancel"
      | "tui.select.up"
      | "tui.select.down",
  ) => boolean;
}
export interface PiGenUiComponent extends Component, Focusable {
  handleInput(data: string): void;
  settled(): Promise<void>;
  dispose(): void;
}
type Control = {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly form?: string;
  readonly node?: Extract<GenUiNode, { type: "field" | "select" }>;
  readonly input?: Input;
};
const safe = (text: string) =>
  renderGenUiText({ version: 1, root: { version: 1, type: "text", text } }).trimEnd();
/** Native controls with Pi's own input/key parsing; never interprets HTML or persists props/drafts. */
export function createPiGenUiComponent(options: PiGenUiComponentOptions): PiGenUiComponent {
  const controller = options.controller;
  let controls: Control[] = [];
  let focus = 0;
  let pending = false;
  let disposed = false;
  let dirty = false;
  let review = false;
  let reconciliationRequired = false;
  let confirmClose = false;
  let message = "Tab: next control; Enter: operate; Ctrl+R: refresh; Esc: close";
  let task = Promise.resolve();
  const lifetime = new AbortController();
  let focused = true;
  function collect(node: GenUiNode, disabled = false, form?: string) {
    disabled =
      disabled || ("disabled" in node && !!node.disabled) || ("pending" in node && !!node.pending);
    if (node.type === "field" || node.type === "select") {
      const input = new Input({ prompt: "" });
      input.setValue(node.value);
      controls.push({
        id: node.id,
        label: node.label,
        disabled,
        node,
        input,
        ...(form ? { form } : {}),
      });
    }
    if ("children" in node)
      for (const child of node.children)
        collect(child, disabled, node.type === "form" ? node.id : form);
    if (node.type === "list") for (const item of node.items) collect(item, disabled, form);
    if (node.type === "form") controls.push({ id: node.id, label: node.label, disabled });
    if (node.type === "actions")
      for (const action of node.actions)
        controls.push({
          id: action.id,
          label: action.label,
          disabled: disabled || !!action.disabled || !!action.pending,
        });
  }
  function reset() {
    for (const item of controls) item.input?.setValue("");
    controls = [];
    collect(controller.document.root);
    focus = 0;
    dirty = false;
    review = false;
  }
  reset();
  const match = (
    data: string,
    action: Parameters<NonNullable<PiGenUiComponentOptions["matches"]>>[1],
    fallback: Parameters<typeof matchesKey>[1],
  ) => options.matches?.(data, action) ?? matchesKey(data, fallback);
  function redraw() {
    if (!disposed) options.requestRender();
  }
  function operate(control: Control) {
    const values = Object.fromEntries(
      controls
        .filter((item) => item.node && !item.disabled && (control.node || item.form === control.id))
        .map((item) => [item.id, item.input!.getValue()]),
    );
    pending = true;
    message = "Submitting…";
    redraw();
    task = (async () => {
      try {
        const delivery = await controller.invoke(control.id, values, lifetime.signal);
        let visibility = "";
        // Only canonical mutations enter conversation context, never local navigation.
        if (!controller.readTargets.includes(delivery.target)) {
          const outcome = {
            target: delivery.target,
            status: delivery.status,
            reconciled: delivery.reconciled,
            ...(delivery.code === undefined ? {} : { code: delivery.code }),
          };
          try {
            await options.publishOutcome(Object.freeze(outcome));
          } catch {
            visibility = " Agent visibility unavailable; explicitly reconcile with the agent.";
          }
        }
        if (disposed) return;
        if (delivery.document) reset();
        if (delivery.reconciled) reconciliationRequired = false;
        else if (delivery.status !== "rejected") {
          reconciliationRequired = true;
          review = true;
        }
        message = `${delivery.status}${delivery.code ? " (" + delivery.code + ")" : ""}. ${delivery.reconciled ? "Authoritative state refreshed." : "Read current state before relying on it."}${visibility}`;
      } catch {
        if (!disposed) message = "Action unavailable; read current state";
      } finally {
        pending = false;
        redraw();
      }
    })();
  }
  const component: PiGenUiComponent = {
    get focused() {
      return focused;
    },
    set focused(value) {
      focused = value;
      for (const [index, item] of controls.entries())
        if (item.input) item.input.focused = value && index === focus && !item.node?.sensitive;
    },
    invalidate() {
      for (const item of controls) item.input?.invalidate();
    },
    render(width) {
      if (width < 1 || disposed) return [];
      const lines = renderGenUiText(controller.document, {
        width: Math.max(2, Math.min(width, 1000)),
      })
        .trimEnd()
        .split("\n");
      for (const [index, item] of controls.entries()) {
        lines.push(
          `${index === focus ? ">" : " "} ${safe(item.label)}${item.disabled || pending || (review && !item.node) ? " [disabled]" : ""}`,
        );
        if (item.input) {
          item.input.focused = focused && index === focus && !item.node?.sensitive;
          lines.push(...(item.node?.sensitive ? ["[hidden]"] : item.input.render(width)));
        }
      }
      lines.push(message);
      return lines.map((line) =>
        truncateToWidth(options.style?.(pending ? "muted" : "accent", line) ?? line, width),
      );
    },
    handleInput(data) {
      if (disposed) return;
      if (match(data, "tui.select.cancel", Key.escape)) {
        if (dirty && !confirmClose) {
          confirmClose = true;
          message = "Unsaved draft; Esc again to discard and close. Any other key keeps editing.";
          redraw();
          return;
        }
        component.dispose();
        options.onClose();
        return;
      }
      confirmClose = false;
      if (pending) return;
      if (matchesKey(data, Key.ctrl("r"))) {
        pending = true;
        message = "Refreshing…";
        task = controller
          .refresh(lifetime.signal)
          .then(() => {
            if (disposed) return;
            reconciliationRequired = false;
            if (dirty) {
              review = true;
              message = "Review current state; Ctrl+D discards the draft";
            } else {
              reset();
              message = "Authoritative state refreshed";
            }
          })
          .catch(() => {
            if (!disposed) {
              review = true;
              reconciliationRequired = true;
              message = "Refresh unavailable; do not rely on stale state";
            }
          })
          .finally(() => {
            pending = false;
            redraw();
          });
        redraw();
        return;
      }
      if (review && matchesKey(data, Key.ctrl("d"))) {
        if (reconciliationRequired) {
          message = "Read current state with Ctrl+R before accepting or discarding this draft";
          redraw();
          return;
        }
        reset();
        message = "Draft discarded; current state accepted";
        redraw();
        return;
      }
      if (match(data, "tui.input.tab", Key.tab) || matchesKey(data, Key.shift("tab"))) {
        const direction = matchesKey(data, Key.shift("tab")) ? -1 : 1;
        for (let step = 0; step < controls.length; step++) {
          focus = (focus + direction + controls.length) % controls.length;
          if (!controls[focus]?.disabled) break;
        }
        redraw();
        return;
      }
      const control = controls[focus];
      if (!control || control.disabled) return;
      if (
        control.node?.type === "select" &&
        (match(data, "tui.select.up", Key.up) || match(data, "tui.select.down", Key.down))
      ) {
        const index = control.node.options.findIndex(
          (option) => option.value === control.input!.getValue(),
        );
        const direction = match(data, "tui.select.up", Key.up) ? -1 : 1;
        control.input!.setValue(
          control.node.options[
            (index + direction + control.node.options.length) % control.node.options.length
          ]!.value,
        );
        dirty = true;
        redraw();
        return;
      }
      if (!control.node && match(data, "tui.select.confirm", Key.enter)) {
        if (review) {
          message = "Review required; refresh or discard draft before submitting";
          redraw();
          return;
        }
        operate(control);
        return;
      }
      if (control.node?.type === "field") {
        const before = control.input!.getValue();
        control.input!.handleInput(data);
        const after = control.input!.getValue();
        try {
          parseGenUiEvent(
            controller.document,
            control.id,
            { value: after },
            { callableTargets: controller.callableTargets },
          );
          dirty ||= before !== after;
        } catch {
          control.input!.setValue(before);
          message = "Invalid field value";
        }
        redraw();
      }
    },
    settled: () => task,
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      controller.dispose();
      for (const control of controls) control.input?.setValue("");
      controls = [];
    },
  };
  return component;
}
