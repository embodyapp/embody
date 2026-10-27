import { describe, expect, it } from "vitest";
import {
  MemorySecretVault,
  resolveReferences,
  type DeploymentStages,
  type MemoryGatewayStore,
  type StageResult,
} from "@embody/gateway";
import { EXIT } from "../src/index.js";
import { APP, CANARY, NAME, accessor, project, registration, topology } from "./topology.js";

// M15: logs, secrets and app lifecycle through the packed-equivalent CLI against the real
// workspace gateway routes, controller and build admission on a memory store. Every run asserts
// that no credential, source secret or secret value appears in any CLI output.

const SECRET_V1 = "m15-secret-value-one-7f3a9c";
const SECRET_V2 = "m15-secret-value-two-c41d2e";
const OTHER = "app_other0000001";

/**
 * Stages that resolve the deployment's secret references the way a candidate does at instance
 * start (the runtime identity reads each pinned version from the vault), record what that
 * candidate would see, and promote the fixture registration. `hold` runs inside the check stage.
 */
function secretStages(
  vault: MemorySecretVault,
  seen: Map<string, Record<string, string | null>>,
  hooks: { check?: () => Promise<StageResult | void>; retired: string[] },
) {
  return (store: MemoryGatewayStore): DeploymentStages => ({
    provision: async ({ deployment }) => {
      const resolved = resolveReferences(
        deployment.submission.secretReferences,
        await store.secrets(deployment.workspaceId, deployment.appId),
      );
      if (typeof resolved === "string")
        return {
          ok: false,
          retryable: false,
          reason: resolved,
          code: deployment.rollbackOf ? "ROLLBACK_INCOMPATIBLE" : "CHECK_FAILED",
        };
      seen.set(
        deployment.deploymentId,
        Object.fromEntries(
          resolved.env.map((entry) => [
            entry.name,
            vault.read(entry.secret, entry.version, accessor(deployment.appId)),
          ]),
        ),
      );
      return {
        ok: true,
        candidate: {
          service: `c-${deployment.deploymentId}`,
          endpoint: "https://cards.example.com",
        },
      };
    },
    check: async () => (await hooks.check?.()) ?? { ok: true },
    promote: () => Promise.resolve({ ok: true, registration: registration() }),
    retire: (deployment) => {
      hooks.retired.push(deployment.deploymentId);
      return Promise.resolve();
    },
  });
}

async function m15(options: { appFetch?: typeof fetch } = {}) {
  const vault = new MemorySecretVault();
  const seen = new Map<string, Record<string, string | null>>();
  const hooks: { check?: () => Promise<StageResult | void>; retired: string[] } = { retired: [] };
  const t = await topology({
    vault,
    stages: secretStages(vault, seen, hooks),
    buildLog:
      "Step #1: npm ci\nStep #2: token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 password=hunter2hunter2\nStep #3: error TS2304 cannot find name\n",
    ...(options.appFetch ? { appFetch: options.appFetch } : {}),
  });
  t.forbid(SECRET_V1);
  t.forbid(SECRET_V2);
  t.forbid("hunter2hunter2");
  t.forbid("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  // A second app in the same workspace and a foreign workspace, each with their own operator.
  await t.store.putApp(
    {
      workspaceId: t.workspace,
      appId: OTHER,
      activeRelease: null,
      state: "unavailable",
      registration: null,
      name: "other",
    } as never,
    null,
  );
  const foreignWs = `ws_foreign${t.workspace.slice(3, 15)}`;
  await t.store.createWorkspace(foreignWs);
  await t.store.putApp(
    {
      workspaceId: foreignWs,
      appId: APP,
      activeRelease: null,
      state: "unavailable",
      registration: null,
      name: NAME,
    } as never,
    null,
  );
  const otherOperator = await t.credential("operator", { appId: OTHER });
  const foreignOperator = await t.credential("operator", { workspace: foreignWs });
  const status = async () => (await t.store.appStatus(t.workspace, APP))!;
  const api = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${t.base}/v1/workspaces/${t.workspace}/apps/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { t, vault, seen, hooks, otherOperator, foreignOperator, foreignWs, status, api };
}

const as = (token: string, stdin?: string) => ({
  token,
  ...(stdin === undefined ? {} : { stdin }),
});

describe("M15.a foreign workspace and app-caller credentials are refused", () => {
  it("app-caller and deployer cannot read logs, write secrets or manage lifecycle; foreign credentials see nothing", async () => {
    const { t, otherOperator, foreignOperator, foreignWs, api } = await m15();
    const caller = as(t.caller.token);
    // App-caller: management is forbidden (403 → exit 4), never executed.
    for (const args of [
      ["logs", NAME],
      ["secrets", "list", NAME],
      ["apps", "disable", NAME],
      ["apps", "enable", NAME],
      ["apps", "delete", NAME, "--confirm", APP],
      ["rollout", NAME],
    ])
      expect((await t.run(args, caller)).code, args.join(" ")).toBe(EXIT.forbidden);
    expect(
      (await t.run(["secrets", "set", NAME, "API_KEY"], as(t.caller.token, SECRET_V1))).code,
    ).toBe(EXIT.forbidden);
    // Deployer: may read logs and secret metadata, never write secrets or disable/delete.
    expect((await t.run(["logs", NAME])).code).toBe(0);
    expect((await t.run(["secrets", "list", NAME])).code).toBe(0);
    expect((await t.run(["secrets", "set", NAME, "API_KEY"], { stdin: SECRET_V1 })).code).toBe(
      EXIT.forbidden,
    );
    expect((await t.run(["apps", "disable", NAME])).code).toBe(EXIT.forbidden);
    expect((await t.run(["apps", "delete", NAME, "--confirm", APP])).code).toBe(EXIT.forbidden);
    // An operator of another app in the same workspace cannot see this one.
    expect((await t.run(["logs", APP], as(otherOperator.token))).code).toBe(EXIT.notFound);
    expect((await t.run(["apps", "disable", APP], as(otherOperator.token))).code).toBe(
      EXIT.notFound,
    );
    // A foreign workspace's credential is not a credential here (401 → exit 3) …
    for (const args of [
      ["logs", APP],
      ["apps", "disable", APP],
      ["secrets", "list", APP],
    ])
      expect((await t.run(args, as(foreignOperator.token))).code).toBe(EXIT.auth);
    // … and in its own workspace the same app ID is a different app.
    const own = await t.run(
      ["apps", "status", "--workspace", foreignWs],
      as(foreignOperator.token),
    );
    expect(own.code).toBe(0);
    // Raw HTTP: the same refusals with fixed public errors, and nothing changed.
    const write = await api("PUT", `${APP}/secrets/API_KEY`, t.caller.token, {
      version: 1,
      workspaceId: t.workspace,
      appId: APP,
      name: "API_KEY",
      value: SECRET_V1,
      expectedVersion: 0,
    });
    expect(write.status).toBe(403);
    expect(JSON.stringify(await write.json())).not.toContain(SECRET_V1);
    expect(await t.store.secrets(t.workspace, APP)).toEqual([]);
    expect((await t.store.appStatus(t.workspace, APP))!.status).toBe("enabled");
    const foreignDelete = await api("POST", `${APP}/delete`, foreignOperator.token, {
      version: 1,
      workspaceId: t.workspace,
      appId: APP,
      operation: "delete",
      expectedGeneration: 1,
      confirmAppId: APP,
    });
    expect(foreignDelete.status).toBe(401);
    expect((await t.store.appStatus(t.workspace, APP))!.status).toBe("enabled");
  });
});

describe("M15.b secret rotation and revocation", () => {
  it("values come only from stdin, reach new calls after a rollout, and old versions are revoked by the end of rotate", async () => {
    const { t, vault, seen, api } = await m15();
    const op = t.operator.token;
    // A value as an argument is refused and never echoed.
    const argument = await t.run(["secrets", "set", NAME, `API_KEY=${SECRET_V1}`], as(op));
    expect(argument.code).toBe(EXIT.usage);
    expect((await t.run(["secrets", "set", NAME, "DATABASE_URL"], as(op, SECRET_V1))).code).toBe(
      EXIT.usage,
    );
    expect((await t.run(["secrets", "set", NAME, "API_KEY"], as(op, ""))).code).toBe(EXIT.usage);
    const set = await t.run(
      ["secrets", "set", NAME, "API_KEY", "--output", "json"],
      as(op, `${SECRET_V1}\n`),
    );
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out)).toMatchObject({
      name: "API_KEY",
      versions: [{ secretVersion: 1, state: "enabled" }],
    });
    // The first deploy references the latest enabled version; the candidate reads it.
    const dir = await project();
    const first = await t.run(["deploy", dir, "--app", NAME, "--output", "json"]);
    expect(first.code).toBe(0);
    const firstStatus = JSON.parse(first.out) as { deploymentId: string; releaseId: string };
    expect(seen.get(firstStatus.deploymentId)).toEqual({ API_KEY: SECRET_V1 });
    // The active release's version cannot be revoked.
    const inUse = await t.run(["secrets", "revoke", NAME, "API_KEY", "--version", "1"], as(op));
    expect(inUse.code).toBe(EXIT.remote);
    expect(inUse.err).toContain("SECRET_IN_USE");
    // Rotate: store v2, roll out the active release with it, revoke v1.
    const rotate = await t.run(
      ["secrets", "rotate", NAME, "API_KEY", "--output", "json"],
      as(op, SECRET_V2),
    );
    expect(rotate.code).toBe(0);
    const rotated = JSON.parse(rotate.out) as {
      secret: { versions: Array<{ secretVersion: number; state: string }> };
      deployment: { deploymentId: string; releaseId: string; state: string };
    };
    expect(rotated.deployment.state).toBe("active");
    expect(rotated.secret.versions.map((v) => [v.secretVersion, v.state])).toEqual([
      [1, "revoked"],
      [2, "enabled"],
    ]);
    // New calls (the new active release) see v2; nothing can read v1 any more.
    expect(seen.get(rotated.deployment.deploymentId)).toEqual({ API_KEY: SECRET_V2 });
    expect((await t.store.appStatus(t.workspace, APP))!.activeReleaseId).toBe(
      rotated.deployment.releaseId,
    );
    const [record] = await t.store.secrets(t.workspace, APP);
    expect(vault.read(record!.providerSecret, "1", accessor(APP))).toBeNull();
    expect(vault.read(record!.providerSecret, "2", accessor(APP))).toBe(SECRET_V2);
    expect(vault.read(record!.providerSecret, "2", accessor(OTHER))).toBeNull();
    expect(record!.versions[0]).toMatchObject({ state: "revoked", disabled: true });
    // Rolling back to the first release uses the current version: v1 never comes back.
    const back = await t.run(
      ["rollback", NAME, firstStatus.releaseId, "--output", "json"],
      as(t.deployer.token),
    );
    expect(back.code).toBe(0);
    expect(seen.get((JSON.parse(back.out) as { deploymentId: string }).deploymentId)).toEqual({
      API_KEY: SECRET_V2,
    });
    // No value anywhere in platform records: deployments, secret metadata, logs, the API.
    const listed = await api("GET", `${APP}/secrets`, op);
    const platform = JSON.stringify([
      await t.store.secrets(t.workspace, APP),
      await t.store.deployment(t.workspace, APP, firstStatus.deploymentId),
      await t.store.appLogs({
        workspaceId: t.workspace,
        appId: APP,
        aliases: [NAME],
        limit: 200,
        since: "2000-01-01T00:00:00.000Z",
      }),
      await listed.json(),
    ]);
    for (const value of [SECRET_V1, SECRET_V2]) expect(platform).not.toContain(value);
  });

  it("a concurrent write conflicts and the losing vault version is disabled; a vault outage stores nothing", async () => {
    const { t, vault, api } = await m15();
    const op = t.operator.token;
    expect((await t.run(["secrets", "set", NAME, "API_KEY"], as(op, SECRET_V1))).code).toBe(0);
    const stale = await api("PUT", `${APP}/secrets/API_KEY`, op, {
      version: 1,
      workspaceId: t.workspace,
      appId: APP,
      name: "API_KEY",
      value: SECRET_V2,
      expectedVersion: 0,
    });
    expect(stale.status).toBe(409);
    const [record] = await t.store.secrets(t.workspace, APP);
    expect(record!.versions).toHaveLength(1);
    const versions = vault.secrets.get(record!.providerSecret)!.versions;
    expect(versions.map((v) => v.enabled)).toEqual([true, false]);
    vault.failNext = "addVersion";
    const down = await t.run(["secrets", "set", NAME, "API_KEY"], as(op, SECRET_V2));
    expect(down.code).toBe(EXIT.unavailable);
    expect((await t.store.secrets(t.workspace, APP))[0]!.versions).toHaveLength(1);
    // A revocation the vault did not confirm fails and completes on retry.
    expect((await t.run(["secrets", "set", NAME, "API_KEY"], as(op, SECRET_V2))).code).toBe(0);
    vault.failNext = "disableVersion";
    expect(
      (await t.run(["secrets", "revoke", NAME, "API_KEY", "--version", "1"], as(op))).code,
    ).toBe(EXIT.unavailable);
    expect(
      (await t.run(["secrets", "revoke", NAME, "API_KEY", "--version", "1"], as(op))).code,
    ).toBe(0);
    expect(vault.read(record!.providerSecret, "1", accessor(APP))).toBeNull();
  });
});

describe("M15.c disable/delete versus in-flight deploys, retries and queued tasks", () => {
  it("disable cancels an in-flight deploy, stale tasks cannot resurrect it, and nothing deploys until enable", async () => {
    const { t, status } = await m15();
    const dir = await project();
    t.holdBuilds(true);
    const submitted = await t.run(["deploy", dir, "--app", NAME, "--no-wait", "--output", "json"]);
    expect(submitted.code).toBe(0);
    const { deploymentId } = JSON.parse(submitted.out) as { deploymentId: string };
    for (let i = 0; i < 4; i += 1) await t.step();
    const before = await status();
    const disabled = await t.run(
      ["apps", "disable", NAME, "--output", "json"],
      as(t.operator.token),
    );
    expect(disabled.code).toBe(0);
    expect(JSON.parse(disabled.out)).toMatchObject({ status: "disabled" });
    const after = await status();
    expect(after.lifecycleFence).toBe(before.lifecycleFence + 1);
    expect(after.generation).toBe(before.generation + 1);
    const record = (await t.store.deployment(t.workspace, APP, deploymentId))!;
    expect(record).toMatchObject({ state: "cancelled", reason: "APP_DISABLED" });
    // Every queued task (the build poll, the lease wake, the cancel wake) is now stale.
    t.holdBuilds(false);
    await t.drain();
    expect((await t.store.deployment(t.workspace, APP, deploymentId))!.state).toBe("cancelled");
    expect((await status()).status).toBe("disabled");
    expect((await status()).activeReleaseId).toBeNull();
    // Deploy, retry, rollout and repeated disable while disabled.
    expect((await t.run(["deploy", dir, "--app", NAME])).code).toBe(EXIT.forbidden);
    expect((await t.run(["deploy", dir, "--app", NAME, "--retry"])).code).toBe(EXIT.forbidden);
    expect((await t.run(["rollout", NAME])).code).toBe(EXIT.notFound);
    const again = await t.run(["apps", "disable", NAME], as(t.operator.token));
    expect(again.code).toBe(0);
    expect((await status()).lifecycleFence).toBe(after.lifecycleFence);
    // Enable restores deployment; the new deploy activates.
    expect((await t.run(["apps", "enable", NAME], as(t.operator.token))).code).toBe(0);
    expect((await t.run(["deploy", dir, "--app", NAME, "--retry"])).code).toBe(0);
    expect((await status()).status).toBe("enabled");
  });

  it("a disable that lands while a deployment is checking makes its promotion fail; the release never activates", async () => {
    const { t, hooks, status } = await m15();
    const dir = await project();
    expect((await t.run(["deploy", dir, "--app", NAME])).code).toBe(0);
    const active = (await status()).activeReleaseId;
    let disabled = false;
    hooks.check = async () => {
      if (!disabled) {
        disabled = true;
        const app = (await t.store.appStatus(t.workspace, APP))!;
        await t.store.changeLifecycle(
          {
            workspaceId: t.workspace,
            appId: APP,
            operation: "disable",
            expectedGeneration: app.generation,
            actorId: "olivia",
            now: t.clock.now(),
          },
          async () => undefined,
        );
      }
    };
    const update = await project(undefined, "v2");
    const result = await t.run(["deploy", update, "--app", NAME, "--retry"]);
    expect([EXIT.deploymentCancelled, EXIT.deploymentFailed]).toContain(result.code);
    expect((await status()).activeReleaseId).toBe(active);
    expect((await status()).status).toBe("disabled");
  });

  it("delete needs explicit confirmation, ends every deployment and release, revokes secrets and returns a receipt", async () => {
    const { t, vault, hooks, status } = await m15();
    const op = as(t.operator.token);
    expect(
      (await t.run(["secrets", "set", NAME, "API_KEY"], as(t.operator.token, SECRET_V1))).code,
    ).toBe(0);
    const dir = await project();
    expect((await t.run(["deploy", dir, "--app", NAME])).code).toBe(0);
    const release = (await status()).activeReleaseId!;
    t.holdBuilds(true);
    const pending = await t.run([
      "deploy",
      await project(undefined, "v2"),
      "--app",
      NAME,
      "--no-wait",
      "--output",
      "json",
      "--retry",
    ]);
    const { deploymentId } = JSON.parse(pending.out) as { deploymentId: string };
    // Confirmation: missing, a name instead of the ID, or another ID are refused locally.
    expect((await t.run(["apps", "delete", NAME], op)).code).toBe(EXIT.usage);
    expect((await t.run(["apps", "delete", NAME, "--confirm", NAME], op)).code).toBe(EXIT.usage);
    expect((await t.run(["apps", "delete", NAME, "--confirm", OTHER], op)).code).toBe(EXIT.usage);
    expect((await status()).status).toBe("enabled");
    const deleted = await t.run(["apps", "delete", NAME, "--confirm", APP, "--output", "json"], op);
    expect(deleted.code).toBe(0);
    const receipt = JSON.parse(deleted.out) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      appId: APP,
      name: NAME,
      actorId: "olivia",
      cancelledDeployments: [deploymentId],
      retention: {
        sourcesAndImages: "released",
        backups: "instance-backup-retention",
        secrets: "revoked",
        audit: "retained",
      },
    });
    const databaseUntil = Date.parse(
      (receipt["retention"] as { databaseUntil: string }).databaseUntil,
    );
    expect(databaseUntil - t.clock.now().getTime()).toBe(30 * 86_400_000);
    // Retention applied: releases ended, pins released, secrets revoked in the vault.
    const ended = await t.store.release(t.workspace, APP, release);
    expect(ended).toMatchObject({ retainUntil: t.clock.now().toISOString() });
    const [secret] = await t.store.secrets(t.workspace, APP);
    expect(secret!.versions.every((v) => v.state === "revoked" && v.disabled)).toBe(true);
    expect(vault.read(secret!.providerSecret, "1", accessor(APP))).toBeNull();
    // Queued tasks and the in-flight build cannot bring it back; the served candidate is retired.
    t.holdBuilds(false);
    await t.drain();
    expect((await status()).status).toBe("deleted");
    expect((await t.store.deployment(t.workspace, APP, deploymentId))!.state).toBe("cancelled");
    expect(hooks.retired.length).toBeGreaterThan(0);
    // The app is gone from every surface; delete is final and repeatable; the receipt stays.
    expect((await t.run(["apps", "status", NAME])).code).toBe(EXIT.notFound);
    expect((await t.run(["deploy", dir, "--app", APP])).code).toBe(EXIT.notFound);
    expect((await t.run(["rollback", APP, release])).code).toBe(EXIT.notFound);
    expect((await t.run(["apps", "enable", APP], op)).code).toBe(EXIT.notFound);
    const replay = await t.run(["apps", "delete", APP, "--confirm", APP, "--output", "json"], op);
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.out)).toEqual(receipt);
    const kept = await t.run(["apps", "deletion", APP], op);
    expect(kept.code).toBe(0);
    expect(kept.out).toContain("Deletion is final");
  });

  it("disable refuses dispatch on the very next call without contacting the app", async () => {
    const contacts: string[] = [];
    const appFetch: typeof fetch = (input) => {
      contacts.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(Response.json({ ok: true }));
    };
    const { t } = await m15({ appFetch });
    expect((await t.run(["deploy", await project(), "--app", NAME])).code).toBe(0);
    await t.run([NAME, "ping"], as(t.caller.token));
    const before = contacts.length;
    expect(before).toBeGreaterThan(0);
    expect((await t.run(["apps", "disable", NAME], as(t.operator.token))).code).toBe(0);
    const refused = await t.run([NAME, "ping"], as(t.caller.token));
    expect(refused.code).not.toBe(0);
    expect(contacts.length).toBe(before);
  });
});

describe("M15.d logs are bounded, redacted and attributable", () => {
  it("pages newest first, only this app's entries, with bounded limits and a quota", async () => {
    const { t, otherOperator, api } = await m15();
    expect((await t.run(["deploy", await project(), "--app", NAME])).code).toBe(0);
    // Activity on another app must never show up in this app's logs.
    await t.run(["apps", "disable", "other"], as(otherOperator.token));
    const page = await t.run(["logs", NAME, "--limit", "3", "--output", "json"]);
    expect(page.err).toBe("");
    expect(page.code).toBe(0);
    const first = JSON.parse(page.out) as {
      entries: Array<{ time: string; kind: string; id: string; target: string }>;
      nextCursor?: string;
    };
    expect(first.entries).toHaveLength(3);
    expect(first.nextCursor).toBeDefined();
    const times = first.entries.map((e) => e.time);
    expect([...times].sort().reverse()).toEqual(times);
    const all = await t.run(["logs", NAME, "--limit", "200", "--output", "json"]);
    const entries = (
      JSON.parse(all.out) as {
        entries: Array<{ kind: string; id: string; target: string; actorId?: string }>;
      }
    ).entries;
    expect(entries.some((e) => e.kind === "deployment")).toBe(true);
    expect(entries.some((e) => e.kind === "request" && e.target === "deployment.submit")).toBe(
      true,
    );
    expect(entries.some((e) => e.target === "app.disable")).toBe(false);
    // Paging with the cursor continues strictly older, without overlap.
    const next = await t.run([
      "logs",
      NAME,
      "--limit",
      "3",
      "--cursor",
      first.nextCursor!,
      "--output",
      "json",
    ]);
    const second = (JSON.parse(next.out) as { entries: Array<{ id: string; time: string }> })
      .entries;
    expect(second.every((e) => e.time <= times.at(-1)!)).toBe(true);
    expect(second.map((e) => e.id)).not.toContain(first.entries.at(-1)!.id);
    // Bounds: local and server-side.
    expect((await t.run(["logs", NAME, "--limit", "1000"])).code).toBe(EXIT.usage);
    for (const query of ["limit=201", "limit=0", "cursor=%25%25", "since=yesterday", "raw=1"])
      expect((await api("GET", `${APP}/logs?${query}`, t.deployer.token)).status).toBe(400);
    // Log reads are admitted against the workspace quota (60 per minute) and audited.
    let limited = 0;
    for (let i = 0; i < 70; i += 1)
      if ((await api("GET", `${APP}/logs?limit=1`, t.deployer.token)).status === 429) limited += 1;
    expect(limited).toBeGreaterThan(0);
    const audited = await t.store.appLogs({
      workspaceId: t.workspace,
      appId: APP,
      limit: 200,
      since: "2000-01-01T00:00:00.000Z",
    });
    expect(audited.filter((e) => e.target === "app.logs").length).toBeGreaterThan(40);
  });

  it("build logs are bounded and redacted; a foreign app's deployment is not found", async () => {
    const { t, otherOperator } = await m15();
    const deployed = await t.run(["deploy", await project(), "--app", NAME, "--output", "json"]);
    const { deploymentId } = JSON.parse(deployed.out) as { deploymentId: string };
    const log = await t.run([
      "deployments",
      "logs",
      deploymentId,
      "--app",
      NAME,
      "--output",
      "json",
    ]);
    expect(log.code).toBe(0);
    const body = JSON.parse(log.out) as { text: string; attempt: number; truncated: boolean };
    expect(body.text).toContain("error TS2304");
    expect(body.text).toContain("[REDACTED]");
    expect(body.text).not.toContain(CANARY);
    expect(
      (await t.run(["deployments", "logs", deploymentId, "--app", OTHER], as(otherOperator.token)))
        .code,
    ).toBe(EXIT.notFound);
    expect(
      (await t.run(["deployments", "logs", deploymentId, "--app", NAME], as(t.caller.token))).code,
    ).toBe(EXIT.forbidden);
  });
});

describe("M15 operator emergency stop", () => {
  it("suspends deploys, secret writes, dispatch and controller work without deleting anything; reads stay", async () => {
    const { t, status } = await m15();
    const dir = await project();
    expect((await t.run(["deploy", dir, "--app", NAME])).code).toBe(0);
    t.holdBuilds(true);
    const pending = await t.run([
      "deploy",
      await project(undefined, "v2"),
      "--app",
      NAME,
      "--no-wait",
      "--output",
      "json",
      "--retry",
    ]);
    const { deploymentId } = JSON.parse(pending.out) as { deploymentId: string };
    await t.store.setStop(t.workspace as `ws_${string}`, true, "platform-operator", t.clock.now());
    expect((await t.run(["deploy", dir, "--app", NAME, "--retry"])).code).toBe(EXIT.forbidden);
    const refused = await t.run(["rollout", NAME]);
    expect(refused.code).toBe(EXIT.forbidden);
    expect(refused.err).toContain("suspended");
    expect(
      (await t.run(["secrets", "set", NAME, "API_KEY"], as(t.operator.token, SECRET_V1))).code,
    ).toBe(EXIT.forbidden);
    expect(
      (await t.run(["apps", "delete", NAME, "--confirm", APP], as(t.operator.token))).code,
    ).toBe(EXIT.forbidden);
    expect((await t.run(["logs", NAME])).code).toBe(0);
    expect((await t.run(["apps", "status", NAME])).code).toBe(0);
    expect((await t.run(["deployments", "status", deploymentId, "--app", NAME])).code).toBe(0);
    // Controller work is held, not lost.
    t.holdBuilds(false);
    for (let i = 0; i < 20; i += 1) await t.step();
    const held = (await t.store.deployment(t.workspace, APP, deploymentId))!;
    expect(["accepted", "validating", "building"]).toContain(held.state);
    expect((await status()).status).toBe("enabled");
    // Lifting the stop resumes the same deployment.
    await t.store.setStop(t.workspace as `ws_${string}`, false, "platform-operator", t.clock.now());
    await t.drain();
    expect((await t.store.deployment(t.workspace, APP, deploymentId))!.state).toBe("active");
  });
});
