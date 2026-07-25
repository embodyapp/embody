/**
 * CLI registrar interface — the extension surface that lets a plugin add its own
 * `embody` subcommands (ARCHITECTURE.md §4 step 11). The concrete binary lives in
 * @embody/cli; the kernel only collects declarations during boot, exactly like it does
 * for MCP tools, so first-party apps and custom/ plugins can extend the CLI itself.
 *
 * Commands are described declaratively (name, args, options) so the CLI package can
 * wire them to Commander without the kernel depending on Commander. A command's
 * handler runs an action; the CLI supplies a per-invocation RequestContext (same
 * principal + tenant + authz as MCP/REST), so plugin commands are not a back door.
 */
import type { RequestContext } from "./request-context.ts";

export interface CliOptionDefinition {
  /** Flag spec, e.g. "--stage <stage>" or "--json". */
  flags: string;
  description: string;
  /** Optional default value. */
  defaultValue?: string | boolean;
}

export interface CliCommandContext {
  /** Positional args, in declared order. */
  readonly args: string[];
  /** Parsed options keyed by their long name (e.g. `stage`, `json`). */
  readonly options: Record<string, unknown>;
  /** Same principal/tenant/authz surface as MCP tools and REST routes. */
  readonly request: RequestContext;
}

export type CliCommandHandler = (ctx: CliCommandContext) => Promise<unknown> | unknown;

export interface CliCommandDefinition {
  /** Command name, namespaced by convention, e.g. "crm:import" or "crm import". */
  name: string;
  description: string;
  /** Positional argument specs, e.g. ["<file>"]. */
  args?: string[];
  options?: CliOptionDefinition[];
  handler: CliCommandHandler;
}

export interface CliRegistrar {
  command(def: CliCommandDefinition): void;
}

/** A collecting registrar the kernel uses to gather plugin CLI commands during boot. */
export class CollectingCliRegistrar implements CliRegistrar {
  readonly commands: CliCommandDefinition[] = [];

  command(def: CliCommandDefinition): void {
    this.commands.push(def);
  }
}
