/**
 * @embody/cli — the `embody` binary. An AI-agent action tool first (mcp / tools /
 * call), a developer tool second (serve / migrate / seed / new). Every action runs
 * through the shared runtime executor, so an agent and a human hit identical,
 * RLS-and-RBAC-enforced code. The catalog of actions is whatever the enabled apps
 * registered — the CLI hardcodes none of them.
 */
import { Command } from "commander";
import type { z } from "zod";
import { createStderrLogger } from "@embody/kernel";
import {
  loadConfig,
  bootRuntime,
  makeExecutor,
  startHost,
  type Runtime,
} from "@embody/host";
import { startMcpStdio } from "@embody/mcp-server";
import { buildPrincipal, type IdentityOptions } from "./identity.ts";
import { newApp, newCustom, newDeployment, findRepoRoot } from "./scaffold.ts";
import { runDoctor, formatReport } from "./doctor.ts";

/** Boot the runtime with a STDERR logger (so STDOUT stays clean for JSON), run, close. */
async function withRuntime<T>(
  configPath: string,
  fn: (rt: Runtime) => Promise<T>,
): Promise<T> {
  const logger = createStderrLogger({ component: "cli" });
  const config = await loadConfig(configPath);
  const runtime = await bootRuntime({ config, logger });
  try {
    return await fn(runtime);
  } finally {
    await runtime.close();
  }
}

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

interface GlobalOpts extends IdentityOptions {
  config: string;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("embody")
    .description("embody — AI-agent action tool + developer CLI")
    .option("-c, --config <path>", "deployment config", "./embody.config.ts")
    .option("-o, --org <id>", "acting org id (or EMBODY_ORG)")
    .option("-u, --user <id>", "acting user id (or EMBODY_USER)")
    .option("--roles <csv>", "acting roles (or EMBODY_ROLES)");

  const globals = (cmd: Command): GlobalOpts => cmd.optsWithGlobals() as GlobalOpts;

  // ---- Agent-first ----

  program
    .command("mcp")
    .description("Run the stdio MCP server (register this in an AI agent's config)")
    .action(async (_opts, cmd: Command) => {
      const g = globals(cmd);
      const config = await loadConfig(g.config);
      await startMcpStdio({ config, principal: buildPrincipal(g) }); // long-running
    });

  program
    .command("tools")
    .description("List the agent-callable tools in this deployment")
    .action(async (_opts, cmd: Command) => {
      const g = globals(cmd);
      await withRuntime(g.config, async (rt) => {
        out(
          rt.booted.mcp.tools.map((t) => ({
            name: t.name,
            description: t.description,
            params: Object.keys((t.input as z.ZodObject<z.ZodRawShape>).shape),
          })),
        );
      });
    });

  program
    .command("call <tool>")
    .description("Invoke one tool and print its JSON result")
    .option("--input <json>", "tool input as JSON", "{}")
    .action(async (tool: string, opts: { input: string }, cmd: Command) => {
      const g = globals(cmd);
      const principal = buildPrincipal(g);
      const input = JSON.parse(opts.input);
      await withRuntime(g.config, async (rt) => {
        const executor = makeExecutor({ runtime: rt, principal });
        out(await executor.invoke(tool, input));
      });
    });

  // ---- Plugin-contributed commands (registerCliCommands extension surface) ----

  program
    .command("commands")
    .description("List plugin-contributed CLI commands")
    .action(async (_opts, cmd: Command) => {
      const g = globals(cmd);
      await withRuntime(g.config, async (rt) => {
        out(
          rt.booted.cli.commands.map((c) => ({
            name: c.name,
            description: c.description,
            args: c.args ?? [],
          })),
        );
      });
    });

  program
    .command("run <command> [args...]")
    .description("Run a plugin-contributed command")
    .option("--options <json>", "command options as JSON", "{}")
    .action(
      async (command: string, args: string[], opts: { options: string }, cmd: Command) => {
        const g = globals(cmd);
        const principal = buildPrincipal(g);
        await withRuntime(g.config, async (rt) => {
          const def = rt.booted.cli.commands.find((c) => c.name === command);
          if (!def) throw new Error(`Unknown command "${command}" (see \`embody commands\`)`);
          const executor = makeExecutor({ runtime: rt, principal });
          const result = await def.handler({
            args,
            options: JSON.parse(opts.options),
            request: executor.request,
          });
          if (result !== undefined) out(result);
        });
      },
    );

  // ---- Developer ----

  program
    .command("serve")
    .description("Run the HTTP host")
    .action(async (_opts, cmd: Command) => {
      const g = globals(cmd);
      await startHost({ config: await loadConfig(g.config), mode: "serve" });
    });

  program
    .command("migrate")
    .description("Apply migrations, then exit")
    .action(async (_opts, cmd: Command) => {
      const g = globals(cmd);
      await startHost({ config: await loadConfig(g.config), mode: "migrate-only" });
      process.exit(0);
    });

  program
    .command("seed")
    .description("Create a dev org + user and print their ids")
    .option("--name <name>", "org name", "Dev Org")
    .option("--email <email>", "user email")
    .action(async (opts: { name: string; email?: string }, cmd: Command) => {
      const g = globals(cmd);
      await withRuntime(g.config, async (rt) => {
        const rand = Math.random().toString(36).slice(2, 8);
        const email = opts.email ?? `dev-${rand}@example.com`;
        const [org] = await rt.ownerDb
          .sql<{ id: string }[]>`insert into core.orgs (name, slug) values (${opts.name}, ${`dev-${rand}`}) returning id`;
        const [user] = await rt.ownerDb
          .sql<{ id: string }[]>`insert into core.users (email, name) values (${email}, ${"Dev User"}) returning id`;
        await rt.ownerDb
          .sql`insert into core.memberships (org_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
        out({
          orgId: org!.id,
          userId: user!.id,
          email,
          exports: `export EMBODY_ORG=${org!.id} EMBODY_USER=${user!.id}`,
        });
      });
    });

  program
    .command("doctor")
    .description("Check that your changes stay inside custom/ and deploy/ (upgrade safety)")
    .action(async () => {
      const report = await runDoctor(await findRepoRoot());
      const { text, code } = formatReport(report);
      process.stderr.write(text);
      process.exitCode = code;
    });

  const csv = (s: string): string[] =>
    s.split(",").map((v) => v.trim()).filter(Boolean);
  const list = (paths: string[]): string => paths.map((w) => "  " + w).join("\n");

  const nw = program.command("new").description("Scaffold plugins and deployments");

  nw.command("custom <name>")
    .description("Create YOUR OWN plugin under custom/ (the usual way to customize embody)")
    .option("--for <deployment>", "also enable it in this deployment, e.g. deploy/acme")
    .action(async (name: string, opts: { for?: string }) => {
      const written = await newCustom(name, opts.for);
      process.stderr.write(`Created ${name}:\n${list(written)}\n`);
      process.stderr.write(
        opts.for
          ? `\nEnabled in ${opts.for}. Run \`pnpm install\`, then \`pnpm --filter ${name} test\`.\n`
          : `\nNot enabled anywhere yet. Add it to a deployment:\n` +
            `  embody new custom ${name} --for deploy/<yours>\n`,
      );
    });

  nw.command("deployment <name>")
    .description("Create YOUR OWN deployable under deploy/")
    .option("--apps <csv>", "catalog apps to enable, e.g. crm,b2b-saas", "")
    .option("--custom <csv>", "your own custom/ plugins to enable", "")
    .action(async (name: string, opts: { apps: string; custom: string }) => {
      const apps = csv(opts.apps);
      const customs = csv(opts.custom);
      const written = await newDeployment(name, apps, customs);
      process.stderr.write(
        `Created ${name}-deployment (apps: ${apps.join(", ") || "none"}` +
          `${customs.length ? `; custom: ${customs.join(", ")}` : ""}):\n${list(written)}\n`,
      );
    });

  nw.command("app <name>")
    .description("Create a first-party app under catalog/ — UPSTREAM-OWNED, see --internal")
    .option("--internal", "yes, I am contributing this app upstream")
    .action(async (name: string, opts: { internal?: boolean }) => {
      if (!opts.internal) {
        process.stderr.write(
          `catalog/ is upstream-owned: anything you add there conflicts when you merge\n` +
            `upstream. To customize your own instance, use:\n\n` +
            `  embody new custom ${name} --for deploy/<yours>\n\n` +
            `If you really are contributing a first-party app, re-run with --internal.\n`,
        );
        process.exitCode = 1;
        return;
      }
      const written = await newApp(name);
      process.stderr.write(`Created @embody/${name}:\n${list(written)}\n`);
    });

  return program;
}

export async function run(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
