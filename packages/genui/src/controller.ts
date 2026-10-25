import {
  parseGenUiDocument,
  parseGenUiEvent,
  type GenUiDocument,
  type GenUiNode,
} from "./document.js";
export interface GenUiControllerOptions {
  readonly document: unknown;
  readonly callableTargets: readonly string[];
  readonly readTargets: readonly string[];
  readonly refresh: { readonly target: string; readonly input: unknown };
  /** Trusted installed app code, never a remote resource or model-provided callback. */
  readonly resolveAction: (nodeId: string, values: Readonly<Record<string, string>>) => unknown;
  readonly present: (target: string, result: unknown) => unknown;
  readonly dispatch: (target: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  readonly isCurrent?: () => boolean;
}
export interface GenUiDelivery {
  readonly target: string;
  readonly status: "confirmed" | "rejected" | "uncertain";
  readonly reconciled: boolean;
  readonly document?: GenUiDocument;
  readonly code?: string;
}
export interface GenUiController {
  readonly document: GenUiDocument;
  readonly callableTargets: readonly string[];
  readonly readTargets: readonly string[];
  invoke(
    nodeId: string,
    values: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<GenUiDelivery>;
  submit(nodeId: string, payload: unknown, signal?: AbortSignal): Promise<GenUiDelivery>;
  refresh(signal?: AbortSignal): Promise<GenUiDocument>;
  dispose(): void;
}
function actionTarget(node: GenUiNode, id: string): string | undefined {
  if (node.type === "form" && node.id === id) return node.event.target;
  if (node.type === "actions") return node.actions.find((action) => action.id === id)?.event.target;
  const children = "children" in node ? node.children : node.type === "list" ? node.items : [];
  for (const child of children) {
    const found = actionTarget(child, id);
    if (found) return found;
  }
  return undefined;
}
/** One result-attached view. Identity is held exclusively by its ordinary dispatch callback. */
export function createGenUiController(options: GenUiControllerOptions): GenUiController {
  let document = parseGenUiDocument(options.document);
  const allowed = Object.freeze([...options.callableTargets]);
  const reads = new Set(options.readTargets);
  if (
    !allowed.includes(options.refresh.target) ||
    !reads.has(options.refresh.target) ||
    [...reads].some((target) => !allowed.includes(target))
  )
    throw new Error("Invalid GenUI controller authority");
  let refreshTarget = options.refresh.target;
  let refreshInput: unknown = structuredClone(options.refresh.input);
  let busy = false;
  let unreconciled = false;
  let disposed = false;
  const lifetime = new AbortController();
  const current = () => !disposed && (options.isCurrent?.() ?? true);
  const available = () => {
    if (!current() || busy) throw new Error("GenUI view is unavailable");
  };
  const requestSignal = (signal?: AbortSignal) =>
    AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
  async function read(signal: AbortSignal) {
    signal.throwIfAborted();
    const result = await options.dispatch(refreshTarget, structuredClone(refreshInput), signal);
    if (!current() || signal.aborted) throw new Error("GenUI view is unavailable");
    document = parseGenUiDocument(options.present(refreshTarget, result));
    unreconciled = false;
    return document;
  }
  const controller: GenUiController = {
    get document() {
      return document;
    },
    callableTargets: allowed,
    readTargets: Object.freeze([...reads]),
    async refresh(signal) {
      available();
      busy = true;
      try {
        return await read(requestSignal(signal));
      } catch (error) {
        unreconciled = true;
        throw error;
      } finally {
        busy = false;
      }
    },
    async invoke(id, values, signal) {
      available();
      return controller.submit(id, options.resolveAction(id, values), signal);
    },
    async submit(id, payload, signal) {
      available();
      const target = actionTarget(document.root, id);
      if (!target || !allowed.includes(target)) throw new Error("GenUI view action is unavailable");
      if (unreconciled && !reads.has(target))
        throw new Error("Read current state before another mutation");
      const input = parseGenUiEvent(document, id, payload, { callableTargets: allowed });
      const abort = requestSignal(signal);
      busy = true;
      try {
        abort.throwIfAborted();
        const result = await options.dispatch(target, input, abort);
        if (!current() || abort.aborted) throw new Error("GenUI view is unavailable");
        if (reads.has(target)) {
          if (!current() || abort.aborted) throw new Error("GenUI view is unavailable");
          const next = parseGenUiDocument(options.present(target, result));
          refreshTarget = target;
          refreshInput = structuredClone(input);
          document = next;
          unreconciled = false;
          return Object.freeze({ target, status: "confirmed", reconciled: true, document });
        }
        // The commit is confirmed regardless of rendering, resource or refresh failure.
        try {
          await read(abort);
          return Object.freeze({ target, status: "confirmed", reconciled: true, document });
        } catch {
          unreconciled = true;
          return Object.freeze({ target, status: "confirmed", reconciled: false });
        }
      } catch (cause) {
        const code: unknown =
          cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;
        const safe =
          typeof code === "string" &&
          ["HOOK_VETO", "VALIDATION_ERROR", "FORBIDDEN", "NOT_FOUND"].includes(code);
        if (!safe) unreconciled = true;
        return Object.freeze({
          target,
          status: safe ? "rejected" : "uncertain",
          reconciled: false,
          code: safe ? code : "UNCERTAIN_OUTCOME",
        });
      } finally {
        busy = false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
    },
  };
  return controller;
}
