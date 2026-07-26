/**
 * Parse a plugin command's own flags off the raw argv.
 *
 * `CliCommandDefinition.options` has always existed and `embody run` has always
 * ignored it: options arrived as one `--options '<json>'` blob, so a plugin declaring
 * `--reviewer <name>` got a declaration nobody could use. That turns every plugin
 * command into JSON-by-hand:
 *
 *     embody run automation:create --options '{"when":"crm.deal.created","do":"x"}'
 *
 * instead of what the declaration promised:
 *
 *     embody run automation:create --when crm.deal.created --do x
 *
 * Commander cannot register these itself without booting the runtime *before* parsing
 * argv — which would mean connecting to Postgres to print `--help`. So `run` accepts
 * unknown options and this parses the tail against the declarations once the runtime
 * is up. `--options` still works and is merged first, so scripts keep functioning.
 */
import type { CliCommandDefinition, CliOptionDefinition } from "@embody/kernel";

interface OptionSpec {
  /** Long name, camelCased as Commander would: `--run-as` -> `runAs`. */
  key: string;
  /** `--flag` with no value. */
  boolean: boolean;
  /** `--flag <v...>`: collect until the next flag, and repeats accumulate. */
  variadic: boolean;
  flag: string;
}

/** `--reviewer <name>` / `--if <condition...>` / `--failed` -> a spec. */
function parseSpec(def: CliOptionDefinition): OptionSpec | undefined {
  const match = /--([a-z0-9][\w-]*)(\s+[<[]([\w-]+)(\.\.\.)?[>\]])?/i.exec(def.flags);
  if (!match) return undefined;
  const long = match[1]!;
  return {
    key: long.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
    boolean: match[2] === undefined,
    variadic: match[4] === "...",
    flag: `--${long}`,
  };
}

export interface ParsedTail {
  args: string[];
  options: Record<string, unknown>;
}

/**
 * Split `tail` into positional args and declared options.
 *
 * An undeclared flag is an error rather than a silent no-op: a typo'd `--wehn` that
 * quietly created a workflow with no trigger is worse than a failed command.
 */
export function parsePluginTail(def: CliCommandDefinition, tail: string[]): ParsedTail {
  const specs = new Map<string, OptionSpec>();
  for (const o of def.options ?? []) {
    const spec = parseSpec(o);
    if (spec) specs.set(spec.flag, spec);
  }

  const args: string[] = [];
  const options: Record<string, unknown> = {};

  for (let i = 0; i < tail.length; i++) {
    const token = tail[i]!;
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    const spec = specs.get(flag);
    if (!spec) {
      const known = [...specs.keys()];
      throw new Error(
        `Unknown option "${flag}" for "${def.name}".` +
          (known.length ? ` Known options: ${known.join(", ")}` : " It declares no options."),
      );
    }

    if (spec.boolean) {
      options[spec.key] = true;
      continue;
    }

    const values: string[] = [];
    if (eq !== -1) {
      values.push(token.slice(eq + 1));
    } else {
      // Consume following non-flag tokens: one for a normal option, all of them for a
      // variadic like `--if <condition...>`.
      while (i + 1 < tail.length && !tail[i + 1]!.startsWith("--")) {
        values.push(tail[++i]!);
        if (!spec.variadic) break;
      }
      if (values.length === 0) throw new Error(`Option "${flag}" needs a value`);
    }

    if (spec.variadic) {
      const prior = (options[spec.key] as string[] | undefined) ?? [];
      options[spec.key] = [...prior, ...values];
    } else {
      options[spec.key] = values[0];
    }
  }

  // Apply declared defaults for anything the user did not pass.
  for (const o of def.options ?? []) {
    const spec = parseSpec(o);
    if (spec && o.defaultValue !== undefined && !(spec.key in options)) {
      options[spec.key] = o.defaultValue;
    }
  }

  return { args, options };
}

/** The argv after `run <command>`, so plugin flags can be parsed from it. */
export function tailAfterCommand(argv: readonly string[], command: string): string[] {
  const runAt = argv.indexOf("run");
  if (runAt === -1) return [];
  const cmdAt = argv.indexOf(command, runAt + 1);
  if (cmdAt === -1) return [];
  const tail = argv.slice(cmdAt + 1);
  // `--options <json>` belongs to `run` itself, not to the plugin command.
  const optAt = tail.indexOf("--options");
  return optAt === -1 ? tail : [...tail.slice(0, optAt), ...tail.slice(optAt + 2)];
}
