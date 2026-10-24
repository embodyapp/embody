// M14 journey cases: a user drives the PACKED CLI (spawned binary, protected profiles) against a
// hosted gateway after the operator provisioned the workspace, reserved two apps and issued
// keys. Shared by the local runner (`pnpm test:m14`) and the live suite: everything
// topology-specific comes in through `t`.
//
// `t` = {
//   cli(args, { profile?, stdin?, env?, interruptWhen? }) → { code, out, err },
//   names: { cards, flow }, appIds: { cards, flow }, workspace, root, edge?,
//   projects: { cards, flow, variant(base, kind) → dir },   kinds: v2 | v3 | broken | malformed
//   profiles: { deployer, caller, edge, stale },
//   pause(appId), resume(appId), tasks() → recorded or listed wake tasks | null,
//   mcpClient(configFile) → { tools(): names[], call(name, args) → result },
//   secrets: string[], scan() → text to search for secrets (logs, audit, objects),
// }
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const { setTimeout } = globalThis;

export const M14_CASES = Object.freeze([
  "M14.a.deploy-returns-id",
  "M14.a.reconnect-by-id",
  "M14.a.discover",
  "M14.a.crud",
  "M14.a.durable-workflow",
  "M14.a.interrupt-keeps-running",
  "M14.a.cancel-fenced",
  "M14.a.rollback",
  "M14.a.mcp-setup",
  "M14.b.malformed-source",
  "M14.b.build-failure",
  "M14.b.missing-scope",
  "M14.b.stale-key",
  "M14.b.cold-timeout",
  "M14.c.workspace-prefixes",
  "M14.c.no-secrets",
]);

const json = (text) => JSON.parse(text.trim().split("\n").at(-1));

export async function runM14Journey(t) {
  const cases = {};
  const record = async (id, run) => {
    const started = Date.now();
    try {
      const details = (await run()) ?? {};
      cases[id] = { pass: true, ms: Date.now() - started, ...details };
    } catch (error) {
      cases[id] = { pass: false, ms: Date.now() - started, error: String(error?.message ?? error) };
    }
  };
  const expect = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const outputs = [];
  const cli = async (args, options = {}) => {
    const result = await t.cli(args, options);
    outputs.push(result.out, result.err);
    return result;
  };
  const cards = t.names.cards;
  const flow = t.names.flow;
  let first;
  let firstRelease;
  let cardId;

  await record("M14.a.deploy-returns-id", async () => {
    const result = await cli(
      ["deploy", t.projects.cards, "--app", cards, "--no-wait", "--output", "json"],
      { profile: t.profiles.deployer },
    );
    expect(result.code === 0, `deploy --no-wait exited ${result.code}: ${result.err}`);
    first = json(result.out);
    expect(/^dep_/.test(first.deploymentId), "no deployment ID");
    expect(
      result.err.includes(`embody deployments status ${first.deploymentId}`),
      "no resume hint",
    );
    return { deploymentId: first.deploymentId, state: first.state };
  });

  await record("M14.a.reconnect-by-id", async () => {
    expect(first, "no deployment to reconnect to");
    // A fresh process: nothing local survives but the ID.
    const replay = await cli(
      ["deploy", t.projects.cards, "--app", cards, "--no-wait", "--output", "json"],
      { profile: t.profiles.deployer },
    );
    expect(json(replay.out).deploymentId === first.deploymentId, "rerun did not resume");
    const waited = await cli(
      ["deployments", "status", first.deploymentId, "--app", cards, "--wait", "--output", "json"],
      { profile: t.profiles.deployer },
    );
    expect(waited.code === 0, `status --wait exited ${waited.code}: ${waited.err}`);
    const status = json(waited.out);
    expect(status.state === "active" && /^rel_/.test(status.releaseId), "not active");
    firstRelease = status.releaseId;
    return { releaseId: status.releaseId, resumedSameId: true };
  });

  await record("M14.a.discover", async () => {
    const list = await cli(["apps", "list", "--output", "json"], { profile: t.profiles.caller });
    expect(list.code === 0, `apps list exited ${list.code}: ${list.err}`);
    expect(JSON.parse(list.out).includes(cards), "deployed app not discovered");
    const status = await cli(["apps", "status", "--output", "json"], {
      profile: t.profiles.deployer,
    });
    const apps = JSON.parse(status.out).apps;
    expect(
      apps.some((app) => app.name === cards && app.activeReleaseId) &&
        apps.some((app) => app.name === flow),
      "apps status missing apps",
    );
    const inspect = await cli(["apps", "inspect", cards], { profile: t.profiles.caller });
    expect(inspect.code === 0 && inspect.out.includes("app.card.create"), "inspect failed");
    return { apps: apps.length };
  });

  await record("M14.a.crud", async () => {
    const run = (args) => cli([cards, ...args, "--output", "json"], { profile: t.profiles.caller });
    const created = await run(["card", "create", "--title", "First card"]);
    expect(created.code === 0, `create exited ${created.code}: ${created.err}`);
    cardId = json(created.out).id;
    expect(cardId, "no record ID");
    const got = await run(["card", "get", cardId]);
    expect(json(got.out).title === "First card", "get mismatch");
    const updated = await run(["card", "update", cardId, "--title", "Renamed"]);
    expect(updated.code === 0 && json(updated.out).title === "Renamed", "update failed");
    const extra = await run(["card", "create", "--title", "Second card"]);
    const extraId = json(extra.out).id;
    const deleted = await run(["card", "delete", extraId]);
    expect(deleted.code === 0, `delete exited ${deleted.code}`);
    const listed = await run(["card", "list"]);
    const items = json(listed.out).items ?? json(listed.out);
    expect(
      Array.isArray(items) && items.length === 1 && items[0].id === cardId,
      "list after delete is wrong",
    );
    return { operations: 6 };
  });

  await record("M14.a.durable-workflow", async () => {
    const deployed = await cli(["deploy", t.projects.flow, "--app", flow, "--output", "json"], {
      profile: t.profiles.deployer,
    });
    expect(deployed.code === 0, `durable deploy exited ${deployed.code}: ${deployed.err}`);
    const started = await cli([flow, "followUp", "start", "--json", "--output", "json"], {
      profile: t.profiles.caller,
      stdin: JSON.stringify({ input: { title: "Journey" }, idempotencyKey: "m14-journey-0001" }),
    });
    expect(started.code === 0, `workflow start exited ${started.code}: ${started.err}`);
    const instance = json(started.out);
    expect(instance.id && instance.status, "no workflow instance");
    const status = await cli([flow, "followUp", "status", instance.id, "--output", "json"], {
      profile: t.profiles.caller,
    });
    expect(status.code === 0, `workflow status exited ${status.code}: ${status.err}`);
    const read = json(status.out);
    expect(read.id === instance.id && typeof read.status === "string", "status mismatch");
    const tasks = await t.tasks();
    // The delayed step's wake task exists (created before the start committed, MD12).
    expect(tasks === null || tasks.length > 0, "no wake task for the delayed step");
    return {
      releaseId: json(deployed.out).releaseId,
      instanceStatus: read.status,
      wakeTasks: tasks?.length ?? "not observable",
    };
  });

  await record("M14.a.interrupt-keeps-running", async () => {
    const dir = await t.projects.variant(t.projects.cards, "v2");
    const interrupted = await cli(["deploy", dir, "--app", cards, "--output", "json"], {
      profile: t.profiles.deployer,
      interruptWhen: (stderr) => /Submitted deployment dep_/.test(stderr),
    });
    expect(interrupted.code === 130, `Ctrl-C exited ${interrupted.code}: ${interrupted.err}`);
    expect(interrupted.err.includes("NOT cancelled"), "no continue-on-server notice");
    const id = /Submitted deployment (dep_[a-z0-9]+)/.exec(interrupted.err)?.[1];
    expect(id, "no ID before the interrupt");
    const waited = await cli(
      ["deployments", "status", id, "--app", cards, "--wait", "--output", "json"],
      { profile: t.profiles.deployer },
    );
    expect(waited.code === 0, `the interrupted deployment did not finish: ${waited.err}`);
    // Data survives the update.
    const got = await cli([cards, "card", "get", cardId, "--output", "json"], {
      profile: t.profiles.caller,
    });
    expect(got.code === 0 && json(got.out).title === "Renamed", "data lost across the update");
    return { deploymentId: id, finalState: json(waited.out).state };
  });

  await record("M14.a.cancel-fenced", async () => {
    const dir = await t.projects.variant(t.projects.cards, "v3");
    const submitted = await cli(["deploy", dir, "--app", cards, "--no-wait", "--output", "json"], {
      profile: t.profiles.deployer,
    });
    const id = json(submitted.out).deploymentId;
    const cancelled = await cli(["deployments", "cancel", id, "--app", cards, "--output", "json"], {
      profile: t.profiles.deployer,
    });
    expect(cancelled.code === 0, `cancel exited ${cancelled.code}: ${cancelled.err}`);
    const fence = json(cancelled.out).cancellationFence;
    expect(json(cancelled.out).state === "cancelled", "not cancelled");
    const again = await cli(["deployments", "cancel", id, "--app", cards, "--output", "json"], {
      profile: t.profiles.deployer,
    });
    expect(again.code === 0 && json(again.out).cancellationFence === fence, "fence advanced");
    const waited = await cli(["deployments", "status", id, "--app", cards, "--wait"], {
      profile: t.profiles.deployer,
    });
    expect(waited.code === 9, `cancelled wait exited ${waited.code}`);
    const list = await cli([cards, "card", "list", "--output", "json"], {
      profile: t.profiles.caller,
    });
    expect(list.code === 0, "previous release stopped serving after cancel");
    return { deploymentId: id, fence };
  });

  await record("M14.a.rollback", async () => {
    expect(firstRelease, "no first release to roll back to");
    const back = await cli(["rollback", cards, firstRelease, "--output", "json"], {
      profile: t.profiles.deployer,
    });
    expect(back.code === 0, `rollback exited ${back.code}: ${back.err}`);
    const status = json(back.out);
    expect(status.state === "active" && status.releaseId !== firstRelease, "not a new release");
    const app = await cli(["apps", "status", cards, "--output", "json"], {
      profile: t.profiles.deployer,
    });
    expect(JSON.parse(app.out).activeReleaseId === status.releaseId, "not the active release");
    // Route rollback keeps the data.
    const got = await cli([cards, "card", "get", cardId, "--output", "json"], {
      profile: t.profiles.caller,
    });
    expect(got.code === 0 && json(got.out).title === "Renamed", "data changed by rollback");
    return { rolledBackTo: firstRelease, newRelease: status.releaseId };
  });

  await record("M14.a.mcp-setup", async () => {
    const file = join(t.scratch, `mcp-${Date.now()}.json`);
    const setup = await cli(["mcp", "setup", "--app", cards, "--write", file], {
      profile: t.profiles.caller,
    });
    expect(setup.code === 0, `mcp setup exited ${setup.code}: ${setup.err}`);
    expect(((await stat(file)).mode & 0o777) === 0o600, "config file not private");
    const config = JSON.parse(await readFile(file, "utf8")).mcpServers.embody;
    expect(config.url.endsWith(`/w/${t.workspace}/mcp/${cards}`), "wrong MCP URL");
    const client = await t.mcpClient(file);
    try {
      const tools = await client.tools();
      expect(
        tools.some((name) => name.includes("card")),
        "no app tools listed",
      );
      const result = await client.call(
        tools.find((name) => /card.*list|list.*card/.test(name)),
        {},
      );
      expect(!result.isError, "MCP list call failed");
    } finally {
      await client.close();
    }
    return { url: config.url.replace(t.root, "<gateway>") };
  });

  await record("M14.b.malformed-source", async () => {
    const dir = await t.projects.variant(t.projects.cards, "malformed");
    const result = await cli(["deploy", dir, "--app", cards], { profile: t.profiles.deployer });
    expect(result.code === 2, `malformed source exited ${result.code}`);
    expect(/Packaging failed: embody\.config\.ts/.test(result.err), "not actionable");
    return { exit: result.code, message: result.err.trim().split("\n")[0] };
  });

  await record("M14.b.build-failure", async () => {
    const dir = await t.projects.variant(t.projects.cards, "broken");
    const result = await cli(["deploy", dir, "--app", cards, "--output", "json"], {
      profile: t.profiles.deployer,
    });
    expect(result.code === 8, `build failure exited ${result.code}: ${result.err}`);
    expect(json(result.out).error?.code === "BUILD_FAILED", "not BUILD_FAILED");
    expect(result.err.includes("pnpm install --frozen-lockfile && pnpm build"), "no fix-it hint");
    const list = await cli([cards, "card", "list"], { profile: t.profiles.caller });
    expect(list.code === 0, "previous release stopped serving after a failed build");
    return { exit: result.code };
  });

  await record("M14.b.missing-scope", async () => {
    const result = await cli(["deploy", t.projects.cards, "--app", cards], {
      profile: t.profiles.caller,
    });
    expect(result.code === 4, `caller deploy exited ${result.code}`);
    expect(result.err.includes("deployer credential"), "not actionable");
    return { exit: result.code };
  });

  await record("M14.b.stale-key", async () => {
    const deploy = await cli(["deploy", t.projects.cards, "--app", cards], {
      profile: t.profiles.stale,
    });
    const list = await cli(["apps", "list"], { profile: t.profiles.stale });
    expect(deploy.code === 3 && list.code === 3, `stale key exited ${deploy.code}/${list.code}`);
    expect(deploy.err.includes("new key"), "not actionable");
    return { exits: [deploy.code, list.code] };
  });

  await record("M14.b.cold-timeout", async () => {
    await t.pause(t.appIds.cards);
    let slow;
    try {
      slow = await cli([cards, "card", "list", "--request-timeout", "3"], {
        profile: t.profiles.caller,
      });
    } finally {
      await t.resume(t.appIds.cards);
    }
    expect(slow.code === 7, `cold timeout exited ${slow.code}: ${slow.err}`);
    expect(slow.err.includes("may be starting from zero"), "not actionable");
    // Allow the resumed instance to answer again.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await cli([cards, "card", "list"], { profile: t.profiles.caller });
    expect(after.code === 0, "app did not recover");
    return { exit: slow.code };
  });

  await record("M14.c.workspace-prefixes", async () => {
    const forms = [
      { label: "workspace URL", args: [], profile: t.profiles.deployer },
      { label: "root + profile workspace", args: [], profile: t.profiles.caller },
      ...(t.profiles.edge ? [{ label: "reverse proxy", args: [], profile: t.profiles.edge }] : []),
    ];
    for (const form of forms) {
      const result = await cli(["apps", "status", ...form.args, "--output", "json"], {
        profile: form.profile,
      });
      expect(result.code === 0, `${form.label}: apps status exited ${result.code}`);
      expect(JSON.parse(result.out).workspaceId === t.workspace, `${form.label}: workspace`);
    }
    const flag = await cli(["apps", "status", "--workspace", t.workspace], {
      profile: t.profiles.deployer,
      env: { EMBODY_GATEWAY_URL: t.root },
    });
    expect(flag.code === 0, "--workspace with a root URL failed");
    if (t.profiles.edge) {
      const crud = await cli([cards, "card", "list"], { profile: t.profiles.edge });
      expect(crud.code === 0, "CRUD through the reverse-proxy prefix failed");
    }
    return { forms: forms.map((form) => form.label).concat("--workspace flag") };
  });

  await record("M14.c.no-secrets", async () => {
    const haystack = `${outputs.join("\n")}\n${await t.scan()}`;
    const leaked = t.secrets.filter((secret) => haystack.includes(secret));
    expect(leaked.length === 0, `${leaked.length} secret(s) appeared in output or logs`);
    return { checkedBytes: haystack.length, secrets: t.secrets.length };
  });

  const pass = M14_CASES.every((id) => cases[id]?.pass);
  return { pass, cases };
}
