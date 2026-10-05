import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GenUiOutcome } from "@embody/genui/session";
import { z } from "zod";

export interface PiOutcomeReporterOptions {
  /** Trusted app manifest targets, not document- or model-supplied authority. */
  readonly callableTargets: readonly string[];
  readonly readTarget: string;
}
export interface PiOutcomeReporter {
  report(
    outcome: unknown,
    options: { readonly reconciled: boolean },
  ): "recorded" | "invalid" | "busy" | "disposed";
  dispose(): void;
}

const target = z
  .string()
  .max(256)
  .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-zA-Z0-9_-]*)+$/);
const configuration = z.object({ callableTargets: z.array(target).max(100), readTarget: target });
const outcomeSchema = z
  .object({
    target,
    status: z.enum(["confirmed", "rejected", "uncertain"]),
    code: z.string().max(128).optional(),
  })
  .transform((value): GenUiOutcome => ({
    target: value.target,
    status: value.status,
    ...(value.code === undefined ? {} : { code: value.code }),
  }));
const safeCodes = new Set(["HOOK_VETO", "VALIDATION_ERROR", "FORBIDDEN", "UNCERTAIN_OUTCOME"]);

/** Idle-only context delivery spike. This is not an action dispatcher or native renderer. */
export function createPiOutcomeReporter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: PiOutcomeReporterOptions,
): PiOutcomeReporter {
  const configurationResult = configuration.safeParse(options);
  if (!configurationResult.success) throw new Error("Invalid Pi outcome reporter configuration");
  const { callableTargets, readTarget } = configurationResult.data;
  let disposed = false;
  const unsubscribe: (() => void)[] = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const stop of unsubscribe) stop();
    unsubscribe.length = 0;
  };
  unsubscribe.push(
    pi.on("session_before_switch", dispose),
    pi.on("session_before_tree", dispose),
    pi.on("session_before_fork", dispose),
    pi.on("session_shutdown", dispose),
  );
  return {
    report(value, state) {
      if (disposed) return "disposed";
      if (!ctx.isIdle()) return "busy";
      const parsed = outcomeSchema.safeParse(value);
      if (
        !parsed.success ||
        !callableTargets.includes(parsed.data.target) ||
        typeof state.reconciled !== "boolean"
      )
        return "invalid";
      const outcome = parsed.data;
      const code =
        outcome.status === "confirmed"
          ? ""
          : ` (${outcome.code && safeCodes.has(outcome.code) ? outcome.code : "ACTION_OUTCOME_UNAVAILABLE"})`;
      const reconciliation = state.reconciled
        ? "Authoritative state refreshed."
        : "Authoritative state not reconciled.";
      pi.sendMessage(
        {
          customType: "embody.genui.outcome",
          display: true,
          content: `Embody UI: ${outcome.target} ${outcome.status}${code}. ${reconciliation} Read ${readTarget} before relying on current state.`,
        },
        { triggerTurn: false },
      );
      return "recorded";
    },
    dispose,
  };
}
