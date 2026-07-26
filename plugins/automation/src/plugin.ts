/**
 * @embody/automation — the trigger half of "set a trigger, write a function".
 *
 * The engine is small on purpose, because two decisions do most of the work:
 *
 *   1. EVERY TRIGGER IS AN EVENT. This plugin subscribes to `*` and matches events
 *      against workflow rows. That is the only trigger primitive there is. A cron
 *      schedule is a row that publishes an event; a webhook is a request that
 *      publishes an event; an inbound email is a plugin that publishes an event.
 *      Adding a new kind of trigger therefore requires no change to this file —
 *      it is an ordinary plugin publishing an event, which the SPI already supports.
 *
 *   2. EVERY ACTION IS A TOOL. Dispatch is `runtime.invoke(principal, tool, input)`,
 *      the same executor MCP, the CLI, and the HTTP bridge use. The action's own
 *      `assert` still decides, RLS still scopes the transaction, and an action can be
 *      tested with `embody call` without firing its trigger.
 *
 * What is left is: load matching rows, evaluate a deliberately tiny condition
 * language, build the input, invoke, record the run.
 */
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {
  DomainEvent,
  EmbodyPlugin,
  KernelContext,
  Principal,
  RequestContext,
  Sql,
} from "@embody/plugin-sdk";
import { CronExpressionParser } from "cron-parser";
import { conditionsMatch, buildInput, parseCondition, CONDITION_OPS } from "./rules.ts";
import type { Condition } from "./rules.ts";

/**
 * Validate a cron expression and return its first occurrence.
 *
 * The worker computes fire times too, but this plugin must not import `@embody/host` —
 * a plugin depends on the SPI, not on the runtime that loads it. Both sides use the
 * same public library, which is the ordinary way two packages agree on cron semantics.
 */
function nextRun(cron: string, timezone: string, from: Date): Date | undefined {
  try {
    return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone }).next().toDate();
  } catch {
    return undefined;
  }
}

export const automationMigrationsDir = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

/** The slice of `embody.runtime` this plugin uses. Declared locally so the plugin
 * depends only on @embody/plugin-sdk, exactly as a third-party plugin would. */
interface RuntimeService {
  invoke(principal: Principal, toolName: string, input: unknown): Promise<unknown>;
  tx<T>(orgId: string, userId: string | null, fn: (tx: Sql) => Promise<T>): Promise<T>;
  toolNames(): string[];
  webhookToken(): { token: string; hash: string };
}

export interface WorkflowRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  on_event: string;
  conditions: Condition[];
  action_tool: string;
  input_map: Record<string, unknown> | null;
  run_as_roles: string[];
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Same semantics as an event subscription pattern, so `--when` and `subscribe` agree. */
function patternMatches(pattern: string, name: string): boolean {
  if (pattern === name || pattern === "*") return true;
  return pattern.endsWith(".*") && name.startsWith(pattern.slice(0, -1));
}

const conditionSchema = z.union([
  z.object({
    path: z.string().min(1),
    op: z.enum(CONDITION_OPS),
    value: z.unknown().optional(),
  }),
  z.object({
    any_of: z.array(
      z.object({
        path: z.string().min(1),
        op: z.enum(CONDITION_OPS),
        value: z.unknown().optional(),
      }),
    ),
  }),
]);

export const automationPlugin: EmbodyPlugin = {
  id: "automation",
  schema: "automation",
  dependsOn: ["core"],
  capabilities: {
    // `*`: the engine cannot know in advance which events workflows will reference.
    events: { subscribe: ["*"] },
    // Acting as a chosen principal is exactly the authority an automation engine
    // needs, and declaring it here is what makes that visible rather than implicit.
    services: { consume: ["embody.runtime"] },
  },
  migrations: { dir: automationMigrationsDir, schema: "automation" },

  init(ctx) {
    ctx.logger.info("automation engine ready");
  },

  // ── The trigger side ───────────────────────────────────────────────────────
  subscribe(bus, ctx) {
    const runtime = ctx.services.get<RuntimeService>("embody.runtime");
    if (!runtime) {
      ctx.logger.warn("embody.runtime unavailable; automations will not run");
      return;
    }

    bus.subscribe("*", async (event: DomainEvent) => {
      // Read as the org's own tenant, so RLS scopes the lookup exactly as it would for
      // a user. A workflow can only ever be found for the org that owns the event.
      const candidates = await runtime.tx<WorkflowRow[]>(event.orgId, null, async (tx) => [
        ...(await tx<WorkflowRow[]>`
          select * from automation.workflows
          where org_id = ${event.orgId} and enabled
        `),
      ]);

      const matched = candidates.filter(
        (w) => patternMatches(w.on_event, event.name) && conditionsMatch(w.conditions, event),
      );

      for (const workflow of matched) {
        await runWorkflow(ctx, runtime, workflow, event);
      }
    });
  },

  // ── Managing workflows: MCP tools, so an agent can author automations ──────
  registerMcpTools(mcp, ctx) {
    const runtime = () => ctx.services.get<RuntimeService>("embody.runtime");

    mcp.tool({
      name: "automation_create_workflow",
      description:
        "Create an automation: when <event> [if <conditions>] run <tool>. The tool must " +
        "already be registered by some plugin — list them with `embody tools`.",
      input: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        on: z.string().min(1).describe('Event name or pattern, e.g. "crm.deal.created" or "crm.*"'),
        conditions: z.array(conditionSchema).optional(),
        do: z.string().min(1).describe("Tool to invoke"),
        inputMap: z
          .record(z.unknown())
          .optional()
          .describe('Template, e.g. {"dealId": "{{payload.id}}"}. Omit to pass the event.'),
        runAsRoles: z.array(z.string()).optional(),
        enabled: z.boolean().optional(),
      }),
      handler: async (input, req) => {
        req.assert("write", "automation:workflow");
        const roles = input.runAsRoles ?? [...req.principal.roles];
        // Without this, `member` could create a workflow that runs as `owner` and
        // then trigger it — privilege escalation through a config row. Narrowing is
        // fine: an owner may create a viewer-scoped automation.
        req.assertMayDelegate(roles);
        const rt = runtime();
        if (rt) assertToolExists(rt, input.do);

        return req.tx(async (tx) => {
          const [row] = await tx<WorkflowRow[]>`
            insert into automation.workflows
              (org_id, name, description, on_event, conditions, action_tool,
               input_map, run_as_roles, enabled, created_by)
            values (
              ${req.orgId}, ${input.name}, ${input.description ?? null}, ${input.on},
              ${JSON.stringify(input.conditions ?? [])}::jsonb, ${input.do},
              ${input.inputMap ? JSON.stringify(input.inputMap) : null}::jsonb,
              ${roles as string[]}, ${input.enabled ?? true},
              ${req.principal.userId || null}
            )
            returning *
          `;
          return row!;
        });
      },
    });

    mcp.tool({
      name: "automation_list_workflows",
      description: "List the automations configured for the current org.",
      input: z.object({ event: z.string().optional() }),
      handler: async (input, req) => {
        req.assert("read", "automation:workflow");
        const rows = await req.tx((tx) =>
          tx<WorkflowRow[]>`select * from automation.workflows order by name`,
        );
        return input.event ? rows.filter((w) => patternMatches(w.on_event, input.event!)) : rows;
      },
    });

    mcp.tool({
      name: "automation_set_enabled",
      description: "Enable or disable an automation without deleting it.",
      input: z.object({ name: z.string().min(1), enabled: z.boolean() }),
      handler: async (input, req) => {
        req.assert("write", "automation:workflow");
        return req.tx(async (tx) => {
          const [row] = await tx<WorkflowRow[]>`
            update automation.workflows set enabled = ${input.enabled}, updated_at = now()
            where name = ${input.name} returning *
          `;
          if (!row) throw new Error(`No automation named "${input.name}"`);
          return row;
        });
      },
    });

    mcp.tool({
      name: "automation_delete_workflow",
      description: "Delete an automation and its run history.",
      input: z.object({ name: z.string().min(1) }),
      handler: async (input, req) => {
        req.assert("delete", "automation:workflow");
        return req.tx(async (tx) => {
          const rows = await tx`
            delete from automation.workflows where name = ${input.name} returning id
          `;
          if (rows.length === 0) throw new Error(`No automation named "${input.name}"`);
          return { deleted: input.name };
        });
      },
    });

    mcp.tool({
      name: "automation_list_runs",
      description:
        "Recent automation runs, newest first — what fired, whether it worked, and why not.",
      input: z.object({
        workflow: z.string().optional(),
        status: z.enum(["ok", "error"]).optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
      handler: async (input, req) => {
        req.assert("read", "automation:run");
        return req.tx((tx) =>
          tx`
            select r.*, w.name as workflow_name
            from automation.runs r join automation.workflows w on w.id = r.workflow_id
            where (${input.workflow ?? null}::text is null or w.name = ${input.workflow ?? null})
              and (${input.status ?? null}::text is null or r.status = ${input.status ?? null})
            order by r.started_at desc
            limit ${input.limit ?? 50}
          `,
        );
      },
    });

    // ── Schedules ────────────────────────────────────────────────────────────
    // A schedule does not run an action. It publishes an event on a cron, which an
    // ordinary workflow then triggers on. Two small concepts that compose, rather
    // than a second trigger system inside the engine:
    //
    //   embody run automation:schedule --name nightly --cron '0 2 * * *' --event ops.nightly
    //   embody run automation:create   --when ops.nightly --do acme_nightly_sync
    //
    // The table is framework-level (`embody.schedules`) so any plugin can schedule
    // work; these tools are just the place a person looks for it.
    mcp.tool({
      name: "automation_create_schedule",
      description:
        "Publish an event on a cron schedule. Pair it with a workflow that triggers " +
        "on that event.",
      input: z.object({
        name: z.string().min(1),
        cron: z.string().min(1).describe('Standard 5-field cron, e.g. "0 2 * * *"'),
        event: z.string().min(1).describe("Event name to publish"),
        payload: z.record(z.unknown()).optional(),
        timezone: z.string().optional().describe('IANA zone, default "UTC"'),
      }),
      handler: async (input, req) => {
        req.assert("write", "automation:schedule");
        // Reject a bad expression here rather than letting the worker discover it and
        // disable the schedule at 2am.
        const first = nextRun(input.cron, input.timezone ?? "UTC", new Date());
        if (!first) throw new Error(`"${input.cron}" is not a valid cron expression`);

        return req.tx(async (tx) => {
          const [row] = await tx`
            insert into embody.schedules
              (org_id, name, cron, event_name, payload, timezone, next_run_at)
            values (
              ${req.orgId}, ${input.name}, ${input.cron}, ${input.event},
              ${JSON.stringify(input.payload ?? {})}::jsonb,
              ${input.timezone ?? "UTC"}, ${first.toISOString()}::timestamptz
            )
            on conflict (org_id, name) do update
              set cron = excluded.cron, event_name = excluded.event_name,
                  payload = excluded.payload, timezone = excluded.timezone,
                  next_run_at = excluded.next_run_at, enabled = true
            returning *
          `;
          return row!;
        });
      },
    });

    mcp.tool({
      name: "automation_list_schedules",
      description: "List cron schedules for the current org, with their next fire time.",
      input: z.object({}),
      handler: (_input, req) => {
        req.assert("read", "automation:schedule");
        return req.tx((tx) => tx`select * from embody.schedules order by name`);
      },
    });

    mcp.tool({
      name: "automation_delete_schedule",
      description: "Delete a cron schedule.",
      input: z.object({ name: z.string().min(1) }),
      handler: async (input, req) => {
        req.assert("delete", "automation:schedule");
        return req.tx(async (tx) => {
          const rows = await tx`
            delete from embody.schedules where name = ${input.name} returning id`;
          if (rows.length === 0) throw new Error(`No schedule named "${input.name}"`);
          return { deleted: input.name };
        });
      },
    });

    // ── Webhook endpoints ────────────────────────────────────────────────────
    // Same shape as schedules: an endpoint does not run an action, it publishes an
    // event that an ordinary workflow triggers on. The table is framework-level
    // (`embody.webhook_endpoints`); these tools are where a person looks for it.
    mcp.tool({
      name: "automation_create_endpoint",
      description:
        "Create an inbound webhook URL for a plugin's hook. Returns the token ONCE — " +
        "only its hash is stored, so it cannot be shown again.",
      input: z.object({
        name: z.string().min(1),
        plugin: z.string().min(1).describe("Plugin id that registered the hook"),
        hook: z.string().min(1).describe('Hook name, e.g. "inbound"'),
        secret: z.string().optional().describe("Shared secret for the provider's signature"),
      }),
      handler: async (input, req) => {
        req.assert("write", "automation:endpoint");
        const rt = runtime();
        if (!rt) throw new Error("embody.runtime unavailable");
        const { token, hash } = rt.webhookToken();

        return req.tx(async (tx) => {
          const [row] = await tx<{ id: string; name: string }[]>`
            insert into embody.webhook_endpoints
              (org_id, name, plugin_id, hook, token_hash, secret)
            values (${req.orgId}, ${input.name}, ${input.plugin}, ${input.hook},
                    ${hash}, ${input.secret ?? null})
            on conflict (org_id, name) do update
              set plugin_id = excluded.plugin_id, hook = excluded.hook,
                  token_hash = excluded.token_hash, secret = excluded.secret,
                  enabled = true
            returning id, name
          `;
          return {
            ...row!,
            token,
            url: `POST /hooks/${token}`,
            warning: "Store this token now — it is not recoverable.",
          };
        });
      },
    });

    mcp.tool({
      name: "automation_list_endpoints",
      description: "List inbound webhook endpoints. Tokens are not included.",
      input: z.object({}),
      handler: (_input, req) => {
        req.assert("read", "automation:endpoint");
        return req.tx((tx) => tx`
          select id, name, plugin_id, hook, enabled, last_seen_at, created_at
          from embody.webhook_endpoints order by name
        `);
      },
    });

    mcp.tool({
      name: "automation_delete_endpoint",
      description: "Delete an inbound webhook endpoint, revoking its token.",
      input: z.object({ name: z.string().min(1) }),
      handler: async (input, req) => {
        req.assert("delete", "automation:endpoint");
        return req.tx(async (tx) => {
          const rows = await tx`
            delete from embody.webhook_endpoints where name = ${input.name} returning id`;
          if (rows.length === 0) throw new Error(`No endpoint named "${input.name}"`);
          return { deleted: input.name };
        });
      },
    });

    mcp.tool({
      name: "automation_test",
      description:
        "Run an automation against a sample event WITHOUT waiting for the real trigger. " +
        "Reports whether the conditions matched and what the action returned.",
      input: z.object({
        name: z.string().min(1),
        event: z.string().min(1),
        payload: z.record(z.unknown()).optional(),
      }),
      handler: async (input, req) => {
        req.assert("write", "automation:workflow");
        const rt = runtime();
        if (!rt) throw new Error("embody.runtime unavailable");

        const [workflow] = await req.tx((tx) =>
          tx<WorkflowRow[]>`select * from automation.workflows where name = ${input.name}`,
        );
        if (!workflow) throw new Error(`No automation named "${input.name}"`);

        const event: DomainEvent = {
          name: input.event,
          orgId: req.orgId,
          payload: input.payload ?? {},
          at: new Date(),
        };
        if (!patternMatches(workflow.on_event, event.name)) {
          return { matched: false, reason: `on_event "${workflow.on_event}" does not match` };
        }
        if (!conditionsMatch(workflow.conditions, event)) {
          return { matched: false, reason: "conditions did not match" };
        }
        // Runs as the caller, not as run_as_roles: a test must not be a way to borrow
        // authority you do not have.
        const result = await rt.invoke(
          req.principal,
          workflow.action_tool,
          buildInput(workflow.input_map, event),
        );
        return { matched: true, result };
      },
    });
  },

  // ── The same operations from a terminal ────────────────────────────────────
  registerCliCommands(cli, ctx) {
    const call = (req: RequestContext, tool: string, input: unknown) => {
      const rt = ctx.services.get<RuntimeService>("embody.runtime");
      if (!rt) throw new Error("embody.runtime unavailable");
      return rt.invoke(req.principal, tool, input);
    };

    cli.command({
      name: "automation:create",
      description: "Create an automation: --when <event> [--if <cond>] --do <tool>",
      options: [
        { flags: "--name <name>", description: "Workflow name (defaults to <event>-<tool>)" },
        { flags: "--when <event>", description: 'Event name or pattern, e.g. "crm.deal.created"' },
        {
          flags: "--if <condition...>",
          description: 'Condition like "payload.amount > 50000". Repeat to AND.',
        },
        { flags: "--do <tool>", description: "Tool to invoke" },
        { flags: "--map <json>", description: 'Input template, e.g. {"dealId":"{{payload.id}}"}' },
        { flags: "--roles <roles>", description: "Comma-separated roles to run as" },
      ],
      handler: (cmd) => {
        const o = cmd.options as Record<string, string | string[] | undefined>;
        const when = str(o.when);
        const tool = str(o.do);
        if (!when || !tool) throw new Error("--when and --do are required");
        const raw = o.if === undefined ? [] : Array.isArray(o.if) ? o.if : [String(o.if)];
        return call(cmd.request, "automation_create_workflow", {
          name: str(o.name) ?? `${when}-${tool}`,
          on: when,
          do: tool,
          conditions: raw.map(parseCondition),
          inputMap: o.map ? (JSON.parse(String(o.map)) as Record<string, unknown>) : undefined,
          runAsRoles: o.roles ? String(o.roles).split(",").map((r) => r.trim()) : undefined,
        });
      },
    });

    cli.command({
      name: "automation:list",
      description: "List configured automations",
      handler: (cmd) => call(cmd.request, "automation_list_workflows", {}),
    });

    cli.command({
      name: "automation:schedule",
      description: "Publish an event on a cron schedule: --name <n> --cron <expr> --event <e>",
      options: [
        { flags: "--name <name>", description: "Schedule name" },
        { flags: "--cron <expr>", description: 'Standard 5-field cron, e.g. "0 2 * * *"' },
        { flags: "--event <event>", description: "Event name to publish" },
        { flags: "--timezone <tz>", description: "IANA zone (default UTC)" },
        { flags: "--payload <json>", description: "Extra payload merged into the event" },
      ],
      handler: (cmd) => {
        const o = cmd.options as Record<string, unknown>;
        const name = str(o.name);
        const cron = str(o.cron);
        const event = str(o.event);
        if (!name || !cron || !event) throw new Error("--name, --cron and --event are required");
        return call(cmd.request, "automation_create_schedule", {
          name,
          cron,
          event,
          timezone: str(o.timezone),
          payload: o.payload ? (JSON.parse(String(o.payload)) as Record<string, unknown>) : undefined,
        });
      },
    });

    cli.command({
      name: "automation:schedules",
      description: "List cron schedules and when they next fire",
      handler: (cmd) => call(cmd.request, "automation_list_schedules", {}),
    });

    cli.command({
      name: "automation:endpoint",
      description: "Create an inbound webhook URL: --name <n> --plugin <p> --hook <h>",
      options: [
        { flags: "--name <name>", description: "Endpoint name" },
        { flags: "--plugin <id>", description: "Plugin that registered the hook" },
        { flags: "--hook <hook>", description: 'Hook name, e.g. "inbound"' },
        { flags: "--secret <secret>", description: "Shared secret for signature checks" },
      ],
      handler: (cmd) => {
        const o = cmd.options as Record<string, unknown>;
        const name = str(o.name);
        const plugin = str(o.plugin);
        const hook = str(o.hook);
        if (!name || !plugin || !hook) {
          throw new Error("--name, --plugin and --hook are required");
        }
        return call(cmd.request, "automation_create_endpoint", {
          name,
          plugin,
          hook,
          secret: str(o.secret),
        });
      },
    });

    cli.command({
      name: "automation:endpoints",
      description: "List inbound webhook endpoints",
      handler: (cmd) => call(cmd.request, "automation_list_endpoints", {}),
    });

    cli.command({
      name: "automation:runs",
      description: "Show recent automation runs",
      options: [
        { flags: "--workflow <name>", description: "Only this workflow" },
        { flags: "--failed", description: "Only failures" },
        { flags: "--limit <n>", description: "How many (default 50)" },
      ],
      handler: (cmd) => {
        const o = cmd.options as Record<string, unknown>;
        return call(cmd.request, "automation_list_runs", {
          workflow: str(o.workflow),
          status: o.failed ? "error" : undefined,
          limit: o.limit ? Number(o.limit) : undefined,
        });
      },
    });

    cli.command({
      name: "automation:disable",
      description: "Disable an automation",
      args: ["<name>"],
      handler: (cmd) =>
        call(cmd.request, "automation_set_enabled", { name: cmd.args[0], enabled: false }),
    });

    cli.command({
      name: "automation:enable",
      description: "Enable an automation",
      args: ["<name>"],
      handler: (cmd) =>
        call(cmd.request, "automation_set_enabled", { name: cmd.args[0], enabled: true }),
    });
  },
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Fail at creation time, not at 3am when the trigger finally fires. A typo'd tool name
 * is the single most likely mistake when wiring an automation by hand, and it is
 * otherwise invisible until the event happens.
 */
function assertToolExists(runtime: RuntimeService, tool: string): void {
  const known = runtime.toolNames();
  if (!known.includes(tool)) {
    throw new Error(
      `No registered tool named "${tool}". Available: ${known.slice(0, 20).join(", ")}` +
        (known.length > 20 ? ", …" : ""),
    );
  }
}

/** Invoke one workflow's action and record the outcome. */
async function runWorkflow(
  ctx: KernelContext,
  runtime: RuntimeService,
  workflow: WorkflowRow,
  event: DomainEvent,
): Promise<void> {
  const principal: Principal = {
    orgId: workflow.org_id,
    userId: "",
    roles: workflow.run_as_roles,
    system: true,
  };
  const started = new Date();

  const record = (status: "ok" | "error", error: string | null, result: unknown) =>
    runtime.tx(workflow.org_id, null, (tx) =>
      tx`
        insert into automation.runs
          (org_id, workflow_id, event_name, status, error, result, started_at, finished_at)
        values (
          ${workflow.org_id}, ${workflow.id}, ${event.name}, ${status}, ${error},
          ${result === undefined ? null : JSON.stringify(result)}::jsonb,
          ${started.toISOString()}::timestamptz, now()
        )
      `,
    );

  try {
    const result = await runtime.invoke(
      principal,
      workflow.action_tool,
      buildInput(workflow.input_map, event),
    );
    await record("ok", null, result);
    ctx.logger.info("automation ran", { workflow: workflow.name, event: event.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await record("error", message, null);
    ctx.logger.error("automation failed", {
      workflow: workflow.name,
      event: event.name,
      error: message,
    });
    // Deliberately NOT rethrown, which means a failed automation is not retried.
    //
    // The outbox retries a *delivery*, and this plugin's delivery is one subscription
    // covering every workflow that matched. Rethrowing would replay the whole set, so
    // three workflows that succeeded would run a second time to give the fourth
    // another chance — turning one broken automation into duplicated side effects
    // elsewhere. Recording the failure and moving on is the predictable trade: the
    // error is visible in `automation:runs --failed`. Per-workflow retry needs a
    // dedup key tying a workflow to a specific outbox row, which is worth adding when
    // something actually needs it.
  }
}
