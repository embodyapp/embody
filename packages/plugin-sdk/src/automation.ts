/**
 * `defineAutomation` — declare the *action* half of an automation.
 *
 * The mental model is "set a trigger, write a function that runs when it fires". This
 * is the function. The trigger is configuration (a row in `automation.workflows`), and
 * the two are joined by name.
 *
 * The function is registered as an ordinary MCP tool rather than in some private
 * automation registry, and that is the entire trick. Embody already has one authorized,
 * schema-validated action layer that MCP, the CLI, and the HTTP bridge all share; an
 * action that lives inside it inherits, for free:
 *
 *   - authorization — the handler runs behind `req.assert`, same as any tool;
 *   - discovery     — `embody tools` lists it, so an agent can wire up a workflow;
 *   - testability   — `embody call <name> --input '{...}'` runs the action directly,
 *                     without firing the trigger, which is what you want at 2am.
 *
 * It also means a workflow's action does not have to be an automation at all: any
 * registered tool can be the `--do`, with a field mapping. `defineAutomation` is the
 * convenient case (whole event in, no mapping), not a separate mechanism.
 */
import { z } from "zod";
import type {
  DomainEvent,
  KernelContext,
  McpRegistrar,
  RequestContext,
} from "@embody/kernel";

/**
 * The wire shape of an automation action's input. `orgId` is deliberately absent: it
 * comes from the caller's principal, so invoking one by hand cannot act on another
 * tenant, and the worker cannot be tricked by a stale payload.
 */
export const automationEventInput = z.object({
  /** The event name that fired, e.g. "crm.deal.created". */
  name: z.string().min(1),
  /** The event body. Opaque here; the handler knows its own shape. */
  payload: z.unknown(),
  /** ISO timestamp of the original occurrence, when known. */
  at: z.string().optional(),
});

export interface AutomationSpec {
  /**
   * Tool name, namespaced like any other, e.g. `acme_review_big_deal`. This is what a
   * workflow's `--do` refers to.
   */
  name: string;
  description: string;
  /**
   * Permission checked before the handler runs. Defaults to write on
   * `<pluginId>:automation` — an automation is a write by default, because the
   * overwhelmingly common case is that it changes something.
   */
  permission?: { action: string; resource: string };
  /** The work. `req` is a full RequestContext: `req.tx`, `req.assert`, `req.principal`. */
  run(event: DomainEvent, req: RequestContext): Promise<unknown> | unknown;
}

/**
 * Register an automation action. Call from `registerMcpTools`, whose arguments this
 * function's first two parameters intentionally mirror:
 *
 *     registerMcpTools(mcp, ctx) {
 *       defineAutomation(mcp, ctx, {
 *         name: "acme_review_big_deal",
 *         description: "Open a HIPAA review when a large deal lands",
 *         async run(event, req) {
 *           await req.tx(...);
 *         },
 *       });
 *     }
 */
export function defineAutomation(
  mcp: McpRegistrar,
  ctx: KernelContext,
  spec: AutomationSpec,
): void {
  const permission = spec.permission ?? { action: "write", resource: `${ctx.pluginId}:automation` };

  mcp.tool({
    name: spec.name,
    description: spec.description,
    input: automationEventInput,
    handler: (input, req) => {
      req.assert(permission.action, permission.resource);
      const event: DomainEvent = {
        name: input.name,
        orgId: req.orgId,
        payload: input.payload,
        at: input.at ? new Date(input.at) : new Date(),
      };
      return spec.run(event, req);
    },
  });
}
