import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { EXIT, hostedCapabilities, resolveTarget } from "../src/index.js";
import { APP, ARG_CANARY, CANARY, NAME, cleanups, project, topology } from "./topology.js";

describe("M14.a deploy, reconnect and status", () => {
  it("deploys by app name, prints the deployment ID at once and ends active with stable JSON", async () => {
    const t = await topology();
    const dir = await project();
    const result = await t.run(["deploy", dir, "--app", NAME, "--output", "json"]);
    expect(result.code).toBe(0);
    const status = JSON.parse(result.out) as { deploymentId: string; releaseId: string };
    expect(status).toMatchObject({
      version: 1,
      workspaceId: t.workspace,
      appId: APP,
      state: "active",
    });
    expect(status.releaseId).toMatch(/^rel_/);
    expect(result.err).toContain(`Submitted deployment ${status.deploymentId}`);
    expect(result.err).toContain(`embody deployments status ${status.deploymentId}`);
    // The source secret (.env) was never uploaded.
    const [key] = t.objects.keys();
    const info = await t.objects.stat(key!);
    const archive = gunzipSync(
      await t.objects.read(key!, { generation: info!.generation, maxBytes: 1 << 20 }),
    );
    expect(archive.includes(Buffer.from(CANARY))).toBe(false);
    expect(archive.includes(Buffer.from("embody.config.ts"))).toBe(true);
    // Every platform call went through the gateway's management API or the signed upload.
    expect(
      t.requests.every((r) => r.includes(`/v1/workspaces/${t.workspace}/`) || r.startsWith("PUT")),
    ).toBe(true);
  });

  it("--no-wait returns the ID; a new process polls it by ID; rerunning deploy resumes it", async () => {
    const t = await topology();
    const dir = await project();
    const submitted = await t.run(["deploy", dir, "--app", NAME, "--no-wait", "--output", "json"]);
    expect(submitted.code).toBe(0);
    const first = JSON.parse(submitted.out) as { deploymentId: string; state: string };
    expect(first.state).toBe("accepted");
    // Lost connection: the same command replays the same deployment instead of building again.
    const again = await t.run(["deploy", dir, "--app", NAME, "--no-wait", "--output", "json"]);
    expect(JSON.parse(again.out)).toMatchObject({ deploymentId: first.deploymentId });
    expect(again.err).toContain("Resuming existing deployment");
    const read = await t.run(["deployments", "status", first.deploymentId, "--app", APP]);
    expect(read.code).toBe(0);
    expect(read.out).toMatch(new RegExp(`^${first.deploymentId} (accepted|validating)`));
    const waited = await t.run([
      "deployments",
      "status",
      first.deploymentId,
      "--app",
      NAME,
      "--wait",
      "--output",
      "json",
    ]);
    expect(waited.code).toBe(0);
    expect(JSON.parse(waited.out)).toMatchObject({ state: "active" });
  });

  it("Ctrl-C stops local waiting only: exit 130, nothing cancelled, the deployment finishes", async () => {
    const t = await topology();
    const dir = await project();
    t.holdBuilds(true);
    const controller = new AbortController();
    const result = await t.run(["deploy", dir, "--app", NAME, "--output", "json"], {
      signal: controller.signal,
      sleep: async () => {
        await t.step();
        controller.abort();
      },
    });
    expect(result.code).toBe(EXIT.interrupted);
    expect(result.err).toContain("NOT cancelled and continues on the server");
    const last = JSON.parse(result.out) as {
      deploymentId: string;
      state: string;
      cancellationFence: number;
    };
    expect(["accepted", "validating", "building"]).toContain(last.state);
    const record = await t.store.deployment(t.workspace, APP, last.deploymentId);
    expect(record?.state).not.toBe("cancelled");
    expect(record?.cancellationFence).toBe(last.cancellationFence);
    t.holdBuilds(false);
    await t.drain();
    expect((await t.store.deployment(t.workspace, APP, last.deploymentId))?.state).toBe("active");
  });

  it("waits 30 minutes by default, then exits 10 with the deployment still running", async () => {
    const t = await topology();
    t.holdBuilds(true);
    let clock = 0;
    let polls = 0;
    const result = await t.run(["deploy", await project(), "--app", NAME, "--output", "json"], {
      now: () => clock,
      sleep: async (ms) => {
        polls += 1;
        clock += ms + 10 * 60_000;
        await t.step();
      },
    });
    expect(result.code).toBe(EXIT.waitTimeout);
    expect(polls).toBe(3);
    expect(clock).toBeGreaterThanOrEqual(30 * 60_000);
    expect(result.err).toContain("continues on the server");
    expect((JSON.parse(result.out) as { state: string }).state).not.toBe("active");
  });

  it("explicit cancel is server-side and fenced; repeating it is harmless; active cannot be cancelled", async () => {
    const t = await topology();
    const dir = await project();
    t.holdBuilds(true);
    const submitted = await t.run(["deploy", dir, "--app", NAME, "--no-wait", "--output", "json"]);
    const { deploymentId } = JSON.parse(submitted.out) as { deploymentId: string };
    await t.step();
    const cancelled = await t.run([
      "deployments",
      "cancel",
      deploymentId,
      "--app",
      NAME,
      "--output",
      "json",
    ]);
    expect(cancelled.code).toBe(0);
    const body = JSON.parse(cancelled.out) as { state: string; cancellationFence: number };
    expect(body.state).toBe("cancelled");
    const fence = (await t.store.deployment(t.workspace, APP, deploymentId))!.cancellationFence;
    const repeat = await t.run(["deployments", "cancel", deploymentId, "--app", NAME]);
    expect(repeat.code).toBe(0);
    expect(repeat.out).toContain("already cancelled");
    expect((await t.store.deployment(t.workspace, APP, deploymentId))!.cancellationFence).toBe(
      fence,
    );
    const waited = await t.run(["deployments", "status", deploymentId, "--app", NAME, "--wait"]);
    expect(waited.code).toBe(EXIT.deploymentCancelled);
    t.holdBuilds(false);
    await t.drain();
    // A later deploy of new source goes active; cancelling it now conflicts.
    const next = await project({ profile: "request-only-v1" }, "v2");
    const active = await t.run(["deploy", next, "--app", NAME, "--output", "json"]);
    expect(active.code).toBe(0);
    const activeId = (JSON.parse(active.out) as { deploymentId: string }).deploymentId;
    const late = await t.run(["deployments", "cancel", activeId, "--app", NAME]);
    expect(late.code).toBe(EXIT.remote);
    expect(late.err).toContain("already ended active");
  });
});

describe("M14 rollback", () => {
  // A successful rollback needs M13 release stages (the journey, `pnpm test:m14`); this harness
  // promotes M12-style releases, which the gateway refuses to roll back to, explicitly.
  it("submits through the rollback route and reports an explicit refusal and missing scope", async () => {
    const t = await topology();
    const deploy = async (title: string) => {
      const result = await t.run([
        "deploy",
        await project({ profile: "request-only-v1" }, title),
        "--app",
        NAME,
        "--output",
        "json",
      ]);
      expect(result.code).toBe(0);
      return JSON.parse(result.out) as { releaseId: string };
    };
    const v1 = await deploy("v1");
    await deploy("v2");
    const refused = await t.run(["rollback", NAME, v1.releaseId]);
    expect(refused.code).toBe(EXIT.remote);
    expect(refused.err).toContain(
      "ROLLBACK_INCOMPATIBLE: The rollback target is no longer retained",
    );
    expect(t.requests).toContain(`POST /v1/workspaces/${t.workspace}/apps/${APP}/rollback`);
    const scope = await t.run(["rollback", NAME, v1.releaseId], { token: t.caller.token });
    expect(scope.code).toBe(EXIT.forbidden);
    const usage = await t.run(["rollback", NAME, "v1"]);
    expect(usage.code).toBe(EXIT.usage);
  });
});

describe("M14.b stable exits and actionable errors", () => {
  it("build failure ends failed with exit 8 and a fix-it hint, without leaking build logs", async () => {
    const t = await topology();
    t.setBuild("FAILURE");
    const result = await t.run(["deploy", await project(), "--app", NAME]);
    expect(result.code).toBe(EXIT.deploymentFailed);
    expect(result.out).toMatch(/failed: BUILD_FAILED/);
    expect(result.err).toContain("pnpm install --frozen-lockfile && pnpm build");
  });

  it("malformed source and a missing hosted declaration fail locally before any request", async () => {
    const t = await topology();
    const keyed = await project();
    await rm(join(keyed, "embody.config.ts"));
    const packed = await t.run(["deploy", keyed, "--app", NAME]);
    expect(packed.code).toBe(EXIT.usage);
    expect(packed.err).toContain("Packaging failed: embody.config.ts");
    const undeclared = await t.run(["deploy", await project(null), "--app", NAME]);
    expect(undeclared.code).toBe(EXIT.usage);
    expect(undeclared.err).toContain('"embody": { "hosted"');
    const missing = await t.run(["deploy", join(keyed, "nope"), "--app", NAME]);
    expect(missing.code).toBe(EXIT.usage);
    expect(t.requests).toEqual([]);
  });

  it("missing scope, stale key, unknown app and missing workspace have distinct exits", async () => {
    const t = await topology();
    const dir = await project();
    const scope = await t.run(["deploy", dir, "--app", NAME], { token: t.caller.token });
    expect(scope.code).toBe(EXIT.forbidden);
    expect(scope.err).toContain("deployer credential");
    await t.store.putCredential(
      { ...t.deployer.record, revoked: true },
      t.deployer.record.revision,
    );
    const stale = await t.run(["deploy", dir, "--app", NAME]);
    expect(stale.code).toBe(EXIT.auth);
    expect(stale.err).toContain("Ask your workspace operator for a new key");
    const unknown = await t.run(["apps", "status", "nothere"], { token: t.caller.token });
    expect(unknown.code).toBe(EXIT.notFound);
    const noWorkspace = await t.run(["deployments", "status", "dep_aaaaaaaa", "--app", NAME], {
      env: { EMBODY_GATEWAY_URL: t.base },
    });
    expect(noWorkspace.code).toBe(EXIT.usage);
    expect(noWorkspace.err).toContain("A workspace is required");
  });

  it("cold timeout: a gateway that does not answer gives exit 7 and an unknown-outcome note for writes", async () => {
    const t = await topology();
    t.hang((url) => url.includes("/v1/"));
    const slow = await t.run(["apps", "status", "--request-timeout", "0.2"]);
    expect(slow.code).toBe(EXIT.unavailable);
    expect(slow.err).toContain("did not answer within 0.2 s");
    t.hang(undefined);
    // A dispatchable release first; then the app call never answers.
    expect((await t.run(["deploy", await project(), "--app", NAME])).code).toBe(0);
    t.hang((url) => url.includes("/api/execute/"));
    const write = await t.run(
      ["cards", "card", "create", "--title", "x", "--request-timeout", "0.3"],
      {
        token: t.caller.token,
      },
    );
    expect(write.code).toBe(EXIT.unavailable);
    expect(write.err).toContain("may be starting from zero");
    expect(write.err).toContain("outcome is unknown");
  });
});

describe("M14 review fixes (B1, B2, N2, N7)", () => {
  it("B1: --name=value never echoes the value; global --token=… works as a token", async () => {
    const t = await topology();
    const dir = await project();
    for (const args of [
      ["deploy", dir, "--app", NAME, `--trace=${ARG_CANARY}`],
      ["deployments", "status", "dep_aaaaaaaa", "--app", NAME, `--bogus=${ARG_CANARY}`],
      ["apps", "status", `--x=${ARG_CANARY}`],
      ["mcp", "setup", `--nope=${ARG_CANARY}`],
      ["cards", "card", "list", `--title=${ARG_CANARY}`],
      ["cards", "card", "list", ARG_CANARY],
    ]) {
      const result = await t.run(args, { token: t.caller.token });
      expect(result.code, args.join(" ")).toBe(EXIT.usage);
    }
    // The documented global options accept the `=` form; a wrong token is an auth failure,
    // and its value is never printed (run() checks every stream for the canary).
    const wrong = await t.run(["apps", "status", `--token=${ARG_CANARY}`]);
    expect(wrong.code).toBe(EXIT.auth);
    const right = await t.run(["apps", "status", `--token=${t.deployer.token}`, "--output=json"], {
      env: { EMBODY_TOKEN: "" },
    });
    expect(right.code).toBe(0);
    expect(JSON.parse(right.out)).toMatchObject({ workspaceId: t.workspace });
    expect((await t.run(["apps", "status", "--request-timeout"])).code).toBe(EXIT.usage);
    expect((await t.run(["apps", "status", "--token="])).code).toBe(EXIT.usage);
  });

  it("B2: plain http to a non-loopback gateway is refused before any request", async () => {
    const t = await topology();
    const remote = { EMBODY_GATEWAY_URL: "http://gateway.invalid/w/ws_abcdefgh12" };
    const dir = await mkdtemp(join(tmpdir(), "embody-cli-b2-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "mcp.json");
    for (const args of [
      ["apps", "status"],
      ["apps", "list"],
      ["deploy", await project(), "--app", NAME],
      ["mcp", "setup", "--write", file],
      ["cards", "card", "list"],
    ]) {
      const result = await t.run(args, { env: remote });
      expect(result.code, args.join(" ")).toBe(EXIT.usage);
      expect(result.err).toContain("must use https");
    }
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(t.requests).toEqual([]);
    for (const base of ["http://localhost:1", "http://127.0.0.9:1", "http://[::1]:1"])
      expect(resolveTarget(base).root).toBe(base);
    expect(() => resolveTarget("http://10.0.0.1/w/ws_aaaaaaaa")).toThrow(/https/);
  });

  it("N2: a reply that breaks the status contract stops waiting at once with exit 6", async () => {
    const t = await topology();
    t.holdBuilds(true);
    const dir = await project();
    const submitted = await t.run(["deploy", dir, "--app", NAME, "--no-wait", "--output", "json"]);
    const { deploymentId } = JSON.parse(submitted.out) as { deploymentId: string };
    // A newer gateway adds a field the strict v1 contract does not know.
    t.after(async (request, response) => {
      if (request.method !== "GET" || !request.url.endsWith(deploymentId)) return response;
      const body = (await response.json()) as Record<string, unknown>;
      return Response.json({ ...body, extra: 1 }, { status: response.status });
    });
    let polls = 0;
    const drift = await t.run(["deployments", "status", deploymentId, "--app", NAME, "--wait"], {
      sleep: () => {
        polls += 1;
        return Promise.resolve();
      },
    });
    expect(drift.code).toBe(EXIT.remote);
    expect(drift.err).toContain("contract mismatch");
    expect(drift.err).toContain(`Deployment ${deploymentId}.`);
    expect(polls).toBe(0);
  });

  it("N7: cancel that loses to promotion, cancel that races another cancel, Ctrl-C during submit", async () => {
    const t = await topology();
    t.holdBuilds(true);
    const first = await t.run([
      "deploy",
      await project(),
      "--app",
      NAME,
      "--no-wait",
      "--output",
      "json",
    ]);
    const a = (JSON.parse(first.out) as { deploymentId: string }).deploymentId;
    // Promotion wins between the CLI's read and its cancel.
    t.before(async (request) => {
      if (request.method === "POST" && request.url.endsWith(`${a}/cancel`)) {
        t.holdBuilds(false);
        await t.drain();
      }
    });
    const lost = await t.run(["deployments", "cancel", a, "--app", NAME]);
    expect(lost.code).toBe(EXIT.remote);
    expect(lost.err).toContain(`Cancellation lost the race: deployment ${a} is active`);
    // Another cancel wins between the read and this cancel: reported as already cancelled.
    t.holdBuilds(true);
    const second = await t.run([
      "deploy",
      await project({ profile: "request-only-v1" }, "v2"),
      "--app",
      NAME,
      "--no-wait",
      "--output",
      "json",
    ]);
    const b = (JSON.parse(second.out) as { deploymentId: string; cancellationFence: number })
      .deploymentId;
    t.before(async (request) => {
      if (request.method === "POST" && request.url.endsWith(`${b}/cancel`)) {
        t.before(undefined);
        const record = (await t.store.deployment(t.workspace, APP, b))!;
        await t.store.cancelDeployment(
          { workspaceId: t.workspace, appId: APP, deploymentId: b },
          record.cancellationFence,
          t.clock.now(),
          () => Promise.resolve(),
        );
        // The CLI's own request now carries a stale fence.
      }
    });
    // The gateway answers a repeated cancel idempotently: cancelled, fence advanced once.
    const raced = await t.run(["deployments", "cancel", b, "--app", NAME, "--output", "json"]);
    expect(raced.code).toBe(0);
    expect(JSON.parse(raced.out)).toMatchObject({ deploymentId: b, state: "cancelled" });
    expect((await t.store.deployment(t.workspace, APP, b))!.cancellationFence).toBe(1);
    // Ctrl-C while the submission is in flight: acceptance unknown, rerun resolves it.
    const controller = new AbortController();
    t.before((request) => {
      if (request.method === "POST" && request.url.endsWith("/deployments")) {
        t.before(undefined);
        controller.abort();
      }
      return Promise.resolve();
    });
    const third = await project({ profile: "request-only-v1" }, "v3");
    const interrupted = await t.run(["deploy", third, "--app", NAME, "--no-wait"], {
      signal: controller.signal,
    });
    expect(interrupted.code).toBe(EXIT.interrupted);
    expect(interrupted.err).toContain("may or may not have been accepted");
    expect(interrupted.err).toContain("Run the same command again");
    const rerun = await t.run(["deploy", third, "--app", NAME, "--no-wait", "--output", "json"]);
    expect(rerun.code).toBe(0);
    expect(rerun.err).toMatch(/Submitted deployment|Resuming existing deployment/);
  });
});

describe("M14.c workspace prefixes, MCP setup and redaction", () => {
  it("accepts /w/<ws>, root plus --workspace or EMBODY_WORKSPACE, and a reverse-proxy path", async () => {
    const t = await topology();
    const forms: Array<{ args: string[]; env: Record<string, string> }> = [
      { args: [], env: {} },
      { args: ["--workspace", t.workspace], env: { EMBODY_GATEWAY_URL: t.base } },
      { args: [], env: { EMBODY_GATEWAY_URL: `${t.base}/`, EMBODY_WORKSPACE: t.workspace } },
      { args: [], env: { EMBODY_GATEWAY_URL: `${t.base}/edge/w/${t.workspace}/` } },
    ];
    for (const form of forms) {
      const listed = await t.run(["apps", "status", ...form.args, "--output", "json"], {
        env: form.env,
      });
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.out)).toMatchObject({
        workspaceId: t.workspace,
        apps: [{ appId: APP, name: NAME }],
      });
    }
    expect(resolveTarget("https://gw.example/edge/w/ws_aaaaaaaa")).toEqual({
      root: "https://gw.example/edge",
      workspaceBase: "https://gw.example/edge/w/ws_aaaaaaaa",
      workspaceId: "ws_aaaaaaaa",
    });
    expect(() => resolveTarget("https://gw.example/w/ws_aaaaaaaa", "ws_bbbbbbbb")).toThrow(
      /does not match/,
    );
    expect(() => resolveTarget("https://user:pw@gw.example/w/ws_aaaaaaaa")).toThrow(/credentials/);
  });

  it("mcp setup prints the workspace MCP URL and never the credential; --write keeps it private", async () => {
    const t = await topology();
    const shown = await t.run(["mcp", "setup", "--app", NAME, "--output", "json"]);
    expect(shown.code).toBe(0);
    const body = JSON.parse(shown.out) as { url: string; config: unknown };
    expect(body.url).toBe(`${t.base}/w/${t.workspace}/mcp/${NAME}`);
    expect(JSON.stringify(body.config)).toContain("Bearer <workspace credential>");
    const dir = await mkdtemp(join(tmpdir(), "embody-cli-mcp-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "mcp.json");
    const written = await t.run(["mcp", "setup", "--write", file]);
    expect(written.code).toBe(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain(`Bearer ${t.deployer.token}`);
    // Never overwrites: the file holds a credential.
    expect((await t.run(["mcp", "setup", "--write", file])).code).toBe(EXIT.usage);
  });

  it("reads only static declarations: capabilities come from package.json, never project code", async () => {
    const dir = await project({ profile: "durable-v1", workflows: true, subscriptions: true });
    expect(await hostedCapabilities(dir)).toMatchObject({
      profile: "durable-v1",
      workflows: true,
      events: false,
      subscriptions: true,
      schedules: false,
    });
    await expect(
      hostedCapabilities(await project({ profile: "request-only-v1", workflows: true })),
    ).rejects.toThrow(/request-only profile takes no/);
    await expect(hostedCapabilities(await project({ profile: "gpu" }))).rejects.toThrow(
      /Invalid hosted declaration/,
    );
  });
});
