import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createGenUiController, type GenUiController } from "@embody/genui/controller";
import { createGenUiGatewayConnection, type GenUiGatewayConnection } from "@embody/genui/client";
import { resolveGenUiPayload, type GenUiPayloadBinding } from "@embody/genui/payload";
import { renderGenUiText } from "@embody/genui/text";
import type { GenUiDocument } from "@embody/genui/document";
import { createPiGenUiComponent, type PiGenUiComponent } from "./native.js";
import { createPiOutcomeReporter } from "./outcome.js";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
export interface PiGenUiProvider {
  readonly appId: string;
  readonly target: string;
  readonly viewId: string;
  readonly readTargets: readonly string[];
  /** Installed trusted app builder must validate props with the action's registered schema. */
  readonly present: (target: string, props: unknown) => unknown;
  readonly bindings: (document: GenUiDocument) => Readonly<Record<string, GenUiPayloadBinding>>;
}
export interface PiGenUiExtensionOptions {
  readonly providers: readonly PiGenUiProvider[];
  readonly connect: (appId: string) => Promise<GenUiGatewayConnection>;
}
/** No persistent props, secret drafts, provider calls or resources are created at extension load. */
export function createPiGenUiExtension(options: PiGenUiExtensionOptions): ExtensionFactory {
  const providers = [...options.providers];
  if (
    providers.length > 100 ||
    new Set(providers.map((provider) => provider.appId + ":" + provider.target)).size !==
      providers.length
  )
    throw new Error("Invalid Pi GenUI providers");
  return (pi) => {
    let active: { close: () => void; pending: () => Promise<void> } | undefined;
    const close = () => {
      active?.close();
      active = undefined;
    };
    pi.on("session_before_switch", close);
    pi.on("session_before_tree", close);
    pi.on("session_before_fork", close);
    pi.on("session_shutdown", close);
    // An agent cannot concurrently start a turn against a result-attached native editor.
    pi.on("input", (_event, ctx) => {
      if (!active) return;
      try {
        ctx.ui.notify("Close the Embody view before starting an agent turn", "warning");
      } catch {
        /* UI failure must not allow a concurrent turn. */
      }
      return { action: "handled" };
    });
    pi.on("tool_call", () =>
      active
        ? { block: true, reason: "An Embody view is active; close it and read authoritative state" }
        : undefined,
    );
    pi.registerCommand("embody-view", {
      description:
        "Open an authenticated installed standard view: /embody-view <app-id> <read-target>",
      handler: async (arguments_, ctx) => {
        if (active || !ctx.isIdle()) {
          ctx.ui.notify("Embody view unavailable while another operation is active", "warning");
          return;
        }
        const [appId, target, extra] = arguments_.trim().split(/\s+/);
        const provider = providers.find((item) => item.appId === appId && item.target === target);
        if (extra || !provider) {
          ctx.ui.notify("No installed provider for this view", "error");
          return;
        }
        const lifetime = new AbortController();
        let connection: GenUiGatewayConnection | undefined;
        let component: PiGenUiComponent | undefined;
        let finish: (() => void) | undefined;
        const state = {
          close: () => {
            lifetime.abort();
            component?.dispose();
            finish?.();
          },
          pending: () => component?.settled() ?? Promise.resolve(),
        };
        active = state;
        try {
          connection = await options.connect(provider.appId);
          if (lifetime.signal.aborted) return;
          const discovered = await connection.discover(provider.target);
          if (lifetime.signal.aborted) return;
          if (discovered.view.kind !== "standard" || discovered.view.id !== provider.viewId) {
            ctx.ui.notify(
              "Unsupported view; use the action's ordinary text/JSON result",
              "warning",
            );
            return;
          }
          const props = await discovered.dispatch(provider.target, {}, lifetime.signal);
          if (lifetime.signal.aborted) return;
          const controller: GenUiController = createGenUiController({
            document: provider.present(provider.target, props),
            callableTargets: discovered.view.callableTargets,
            readTargets: provider.readTargets.filter((read) =>
              discovered.view.callableTargets.includes(read),
            ),
            refresh: { target: provider.target, input: {} },
            present: provider.present,
            resolveAction: (id, values) =>
              resolveGenUiPayload(provider.bindings(controller.document)[id], values),
            dispatch: discovered.dispatch,
            isCurrent: () => !lifetime.signal.aborted,
          });
          if (ctx.mode !== "tui" || !ctx.hasUI) {
            pi.sendMessage(
              {
                customType: "embody.genui.fallback",
                display: true,
                content: renderGenUiText(controller.document),
              },
              { triggerTurn: false },
            );
            controller.dispose();
            return;
          }
          const reporter = createPiOutcomeReporter(pi, ctx, {
            callableTargets: discovered.view.callableTargets,
            readTarget: provider.target,
          });
          try {
            await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
              finish = () => done();
              component = createPiGenUiComponent({
                controller,
                requestRender: () => tui.requestRender(),
                onClose: () => done(),
                style: (role, text) => theme.fg(role, text),
                matches: (data, action) => keybindings.matches(data, action),
                publishOutcome: (outcome) => {
                  const recorded = reporter.report(outcome, { reconciled: outcome.reconciled });
                  if (recorded !== "recorded")
                    return Promise.reject(
                      new Error("Agent visibility unavailable; explicitly reconcile"),
                    );
                  return Promise.resolve();
                },
              });
              return component;
            });
            await component?.settled();
          } finally {
            component?.dispose();
            reporter.dispose();
          }
        } catch {
          if (!lifetime.signal.aborted)
            ctx.ui.notify(
              "Embody view unavailable. Use the ordinary action and read current state.",
              "error",
            );
        } finally {
          state.close();
          await state.pending();
          await connection?.close();
          if (active === state) active = undefined;
        }
      },
    });
  };
}
/** Explicit local trusted adapter module; never accept a URL or module path from tool props. */
export default async function extension(pi: ExtensionAPI): Promise<void> {
  const path = process.env["EMBODY_GENUI_ADAPTER"];
  const gatewayUrl = process.env["EMBODY_GATEWAY_URL"];
  const token = process.env["EMBODY_GATEWAY_TOKEN"];
  try {
    if (!path || !isAbsolute(path) || !gatewayUrl || !token) throw new Error();
    const module: unknown = await import(pathToFileURL(path).href);
    if (
      module === null ||
      typeof module !== "object" ||
      !("providers" in module) ||
      !Array.isArray(module.providers)
    )
      throw new Error();
    const providers: unknown[] = module.providers;
    if (
      !providers.every(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          "appId" in item &&
          typeof item.appId === "string" &&
          "target" in item &&
          typeof item.target === "string" &&
          "viewId" in item &&
          typeof item.viewId === "string" &&
          "readTargets" in item &&
          Array.isArray(item.readTargets) &&
          item.readTargets.every((read: unknown) => typeof read === "string") &&
          "present" in item &&
          typeof item.present === "function" &&
          "bindings" in item &&
          typeof item.bindings === "function",
      )
    )
      throw new Error();
    await createPiGenUiExtension({
      providers: providers as PiGenUiProvider[],
      connect: (appId) =>
        createGenUiGatewayConnection({ gatewayUrl, appId, authorization: `Bearer ${token}` }),
    })(pi);
  } catch {
    pi.registerCommand("embody-view", {
      description: "Open an authenticated installed Embody standard view",
      handler: (_args, ctx) => {
        ctx.ui.notify(
          "Configure a trusted absolute EMBODY_GENUI_ADAPTER, EMBODY_GATEWAY_URL and EMBODY_GATEWAY_TOKEN, then reload",
          "error",
        );
        return Promise.resolve();
      },
    });
  }
}
