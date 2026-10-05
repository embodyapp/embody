import type { z } from "zod";

export interface GenUiOutcome {
  readonly target: string;
  readonly status: "confirmed" | "rejected" | "uncertain";
  readonly code?: string;
}

export interface GenUiSessionState<TSnapshot> {
  readonly phase:
    | "ready"
    | "pending"
    | "rejected"
    | "refreshing"
    | "stale"
    | "uncertain"
    | "disposed"
    | "invalidated";
  readonly generation: string;
  readonly stale: boolean;
  readonly selectedId?: string;
  readonly notice?: "selection-removed";
  readonly reviewRequired: boolean;
  readonly snapshot: TSnapshot;
  readonly draft: Readonly<Record<string, unknown>>;
  readonly outcome?: GenUiOutcome;
}

export interface GenUiSessionOptions<TSchema extends z.ZodType> {
  readonly generation: string;
  readonly initialSnapshot: z.input<TSchema>;
  readonly snapshotSchema: TSchema;
  readonly readTarget: string;
  readonly mutations: Readonly<Record<string, z.ZodType>>;
  /** App-owned selection mapping; never supplied by action input or a model. */
  readonly items?: (snapshot: z.output<TSchema>) => readonly { readonly id: string }[];
  /** The authenticated adapter owns identity and ordinary action execution. */
  readonly dispatch: (target: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
}

const MAX_LOCAL_BYTES = 65_536;

function fingerprint(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : item,
  );
}

function boundedJson(value: unknown, maxBytes: number): unknown {
  const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let count = 0;
  while (queue.length > 0) {
    const item = queue.pop()!;
    if (++count > 10_000 || item.depth > 32)
      throw new Error("GenUI draft exceeds structural limit");
    if (typeof item.value === "string" && item.value.length > maxBytes)
      throw new Error("GenUI draft exceeds byte limit");
    if (item.value !== null && typeof item.value === "object") {
      if (seen.has(item.value)) throw new Error("GenUI draft must be an acyclic JSON tree");
      seen.add(item.value);
      if (
        !Array.isArray(item.value) &&
        Object.getPrototypeOf(item.value) !== Object.prototype &&
        Object.getPrototypeOf(item.value) !== null
      )
        throw new Error("GenUI draft must contain JSON values");
      const children = Object.values(item.value);
      if (children.length + count + queue.length > 10_000)
        throw new Error("GenUI draft exceeds structural limit");
      for (const child of children) queue.push({ value: child, depth: item.depth + 1 });
    } else if (
      typeof item.value !== "string" &&
      typeof item.value !== "boolean" &&
      item.value !== null &&
      !(typeof item.value === "number" && Number.isFinite(item.value))
    ) {
      throw new Error("GenUI draft must contain JSON values");
    }
  }
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).length > maxBytes)
    throw new Error("GenUI draft exceeds byte limit");
  return JSON.parse(serialized) as unknown;
}

/** Transport-independent local state; neither a business executor nor a wire protocol. */
export function createGenUiSession<TSchema extends z.ZodType>(
  options: GenUiSessionOptions<TSchema>,
) {
  function parseSnapshot(value: unknown): z.output<TSchema> {
    const parsed = options.snapshotSchema.parse(boundedJson(value, 1_048_576));
    boundedJson(parsed, 1_048_576);
    return parsed;
  }
  let state: GenUiSessionState<z.output<TSchema>> = {
    phase: "ready",
    generation: options.generation,
    stale: false,
    reviewRequired: false,
    snapshot: parseSnapshot(options.initialSnapshot),
    draft: {},
  };
  let clearConfirmedDraft = false;
  let requestId = 0;
  let controller: AbortController | undefined;
  function assertActive() {
    if (state.phase === "disposed" || state.phase === "invalidated")
      throw new Error(`GenUI session is ${state.phase}`);
  }
  async function refresh(clearDraft = false) {
    assertActive();
    if (state.phase === "pending") return false;
    clearDraft = clearDraft || clearConfirmedDraft;
    const id = ++requestId;
    controller?.abort();
    controller = new AbortController();
    state = { ...state, phase: "refreshing", stale: true };
    try {
      const snapshot = parseSnapshot(
        await options.dispatch(options.readTarget, {}, controller.signal),
      );
      if (id !== requestId) return false;
      const previousItem = options
        .items?.(state.snapshot)
        .find((item) => item.id === state.selectedId);
      const nextItem = options.items?.(snapshot).find((item) => item.id === state.selectedId);
      const changed = fingerprint(previousItem) !== fingerprint(nextItem);
      state = {
        ...state,
        phase: "ready",
        stale: false,
        reviewRequired: clearDraft
          ? false
          : state.reviewRequired || (changed && Object.keys(state.draft).length > 0),
        snapshot,
        ...(clearDraft ? { draft: {} } : {}),
      };
      if (state.selectedId !== undefined && options.items !== undefined && nextItem === undefined) {
        const remaining = { ...state };
        delete remaining.selectedId;
        state = { ...remaining, draft: {}, reviewRequired: false, notice: "selection-removed" };
      }
      clearConfirmedDraft = false;
      return true;
    } catch {
      if (id === requestId) state = { ...state, phase: "stale" };
      return false;
    }
  }
  function dispose() {
    ++requestId;
    controller?.abort();
    state = { ...state, phase: "disposed", stale: true, draft: {}, reviewRequired: false };
  }
  return {
    get state() {
      return structuredClone(state);
    },
    refresh: () => refresh(),
    confirmReview() {
      assertActive();
      if (state.stale || state.phase === "pending" || state.phase === "refreshing") return;
      state = { ...state, reviewRequired: false };
    },
    async openItem(id: string, confirmation: { readonly discardDraft?: boolean } = {}) {
      assertActive();
      if (options.items === undefined) throw new Error("GenUI selection mapping is not declared");
      const switching = state.selectedId !== id;
      if (switching && Object.keys(state.draft).length > 0 && !confirmation.discardDraft)
        throw new Error("GenUI draft discard requires confirmation");
      if (!(await refresh())) return;
      if (!options.items(state.snapshot).some((item) => item.id === id))
        throw new Error("GenUI selected item was not found");
      const remaining = { ...state };
      delete remaining.notice;
      state = {
        ...remaining,
        selectedId: id,
        ...(switching ? { draft: {}, reviewRequired: false } : {}),
      };
    },
    dispose,
    close(confirmation: { readonly discardDraft?: boolean } = {}) {
      if (Object.keys(state.draft).length > 0 && !confirmation.discardDraft)
        throw new Error("GenUI draft discard requires confirmation");
      dispose();
    },
    invalidateGeneration(generation: string) {
      if (
        generation === state.generation ||
        state.phase === "disposed" ||
        state.phase === "invalidated"
      )
        return;
      ++requestId;
      controller?.abort();
      state = { ...state, phase: "invalidated", stale: true };
    },
    cancel() {
      if (state.phase === "disposed" || state.phase === "invalidated") return;
      ++requestId;
      controller?.abort();
      if (state.phase === "pending" && state.outcome) {
        state = {
          ...state,
          phase: "uncertain",
          stale: true,
          outcome: { target: state.outcome.target, status: "uncertain" },
        };
      } else if (state.phase === "refreshing") {
        state = { ...state, phase: "stale", stale: true };
      }
    },
    edit(draft: Readonly<Record<string, unknown>>) {
      assertActive();
      if (state.phase === "pending" || state.phase === "refreshing") return;
      const nextDraft = boundedJson(draft, MAX_LOCAL_BYTES) as Record<string, unknown>;
      clearConfirmedDraft = false;
      state = { ...state, draft: nextDraft };
    },
    async submit(target: string) {
      assertActive();
      if (
        state.phase === "pending" ||
        state.phase === "refreshing" ||
        state.stale ||
        state.reviewRequired
      )
        return;
      const schema = Object.hasOwn(options.mutations, target)
        ? options.mutations[target]
        : undefined;
      if (schema === undefined) throw new Error("GenUI mutation target is not declared");
      const parsed = schema.safeParse(state.draft);
      if (!parsed.success) {
        state = {
          ...state,
          phase: "rejected",
          outcome: { target, status: "rejected", code: "VALIDATION_ERROR" },
        };
        return;
      }
      const input = parsed.data;
      const id = ++requestId;
      controller = new AbortController();
      state = { ...state, phase: "pending", outcome: { target, status: "uncertain" } };
      try {
        await options.dispatch(target, input, controller.signal);
        if (id !== requestId) return;
        clearConfirmedDraft = true;
        state = { ...state, phase: "ready", outcome: { target, status: "confirmed" } };
        await refresh(true);
      } catch (error) {
        if (id !== requestId) return;
        // Only definitive pre-commit failures are safe to label rejected. Transport
        // failures, cancellation, and unknown adapter errors may follow a commit.
        const code =
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          (error.code === "HOOK_VETO" ||
            error.code === "VALIDATION_ERROR" ||
            error.code === "FORBIDDEN")
            ? error.code
            : undefined;
        state =
          code === undefined
            ? {
                ...state,
                phase: "uncertain",
                stale: true,
                outcome: { target, status: "uncertain" },
              }
            : { ...state, phase: "rejected", outcome: { target, status: "rejected", code } };
      }
    },
  };
}
