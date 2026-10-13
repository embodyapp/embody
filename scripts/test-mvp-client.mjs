import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer, request as forward } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { setTimeout } from "node:timers";
import {
  createWorkspaceGateway,
  MemoryGatewayStore,
  newCredential,
  hostedSigningIdentity,
} from "../packages/gateway/dist/index.js";
import { createHost } from "../packages/host/dist/index.js";
import { gatewayJwtVerifier } from "../packages/auth/dist/index.js";
import { evidence, main, root } from "./verification.mjs";

// Opt-in real product smoke. Never runs as an SDK substitute or in credential-free CI.
// Auth is supplied by the installed Claude Code client; all MCP data is synthetic.
const require = createRequire(new URL("../packages/gateway/package.json", import.meta.url));
const { generateKeyPair, exportPKCS8, exportJWK } = await import(require.resolve("jose"));

await main("mvp-client", async () => {
  const clientVersion = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  assert.equal(
    clientVersion,
    "2.1.296 (Claude Code)",
    "Only the explicitly qualified client version is admitted by this fixture",
  );
  const directory = await mkdtemp(join(tmpdir(), "embody-m06-client-"));
  const store = new MemoryGatewayStore();
  const workspace = "ws_m06client001";
  const admittedOrigin = "https://m06.fixture.example";
  const key = await generateKeyPair("ES256", { extractable: true });
  const token = await hostedSigningIdentity({
    issuer: "m06-client-fixture",
    kid: "fixture-key",
    privateKeyPem: await exportPKCS8(key.privateKey),
    publicKeys: [
      { ...(await exportJWK(key.publicKey)), kid: "fixture-key", alg: "ES256", use: "sig" },
    ],
  });
  await store.createWorkspace(workspace);
  const issued = newCredential({
    workspaceId: workspace,
    principal: {
      orgId: workspace,
      actorId: "client-smoke",
      actorType: "human",
      roles: [],
      scopes: ["kanban:*"],
    },
    grants: [{ workspaceId: workspace, appId: "app_m06client001", role: "app-caller" }],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  await store.putCredential(issued.credential, null);
  const manifest = {
    protocolVersion: 1,
    plugins: [{ id: "kanban", version: "1.0.0" }],
    entities: {},
    eventSubscriptions: [],
    actions: {
      "kanban.ping": {
        generated: false,
        description: "Return a synthetic M06 acceptance marker. Safe read-only smoke tool.",
        inputSchema: { type: "object", properties: {} },
      },
    },
  };
  await store.putApp(
    {
      workspaceId: workspace,
      appId: "app_m06client001",
      activeRelease: "rel_m06client001",
      state: "idle",
      registration: {
        protocolVersion: 1,
        appId: "kanban",
        version: "1.0.0",
        endpoint: admittedOrigin,
        healthCheckUrl: `${admittedOrigin}/health`,
        manifest,
      },
    },
    null,
  );
  let hostAddress;
  let appRequests = 0;
  let executions = 0;
  const makeGateway = () =>
    createWorkspaceGateway({
      store,
      token,
      fetch: (url, init) => {
        const target = new URL(String(url));
        assert.equal(target.origin, admittedOrigin);
        appRequests++;
        return globalThis.fetch(new URL(target.pathname, hostAddress), init);
      },
    });
  const gateways = [makeGateway(), makeGateway()];
  const addresses = await Promise.all(
    gateways.map((gateway) => gateway.listen({ port: 0, host: "127.0.0.1" })),
  );
  const host = createHost({
    appId: "kanban",
    version: "1",
    environment: "production",
    kernel: {
      state: "ready",
      manifest,
      execute: async (_target, _input, context) => {
        assert.equal(context.principal.orgId, workspace);
        executions++;
        return { ok: true, marker: "M06_CLIENT_OK" };
      },
    },
    verifier: gatewayJwtVerifier({
      issuer: token.issuer,
      audience: "kanban",
      workspaceId: workspace,
      algorithms: ["ES256"],
      jwksUrl: new URL("/.well-known/jwks.json", addresses[1]),
    }),
  });
  const requests = [];
  const sockets = new Set();
  let activeResponses = 0;
  let next = 0;
  const proxy = createServer((incoming, outgoing) => {
    const replica = next++ % 2;
    activeResponses++;
    outgoing.once("close", () => {
      activeResponses--;
    });
    let body = "";
    incoming.on("data", (chunk) => {
      body += chunk;
    });
    incoming.on("end", () => {
      let message;
      try {
        message = body ? JSON.parse(body) : undefined;
      } catch {
        /* recorded as invalid */
      }
      const entry = {
        at: new Date().toISOString(),
        replica,
        httpMethod: incoming.method,
        path: incoming.url,
        method: message?.method ?? null,
        authenticated: incoming.headers.authorization === `Bearer ${issued.token}`,
        sessionHeader: incoming.headers["mcp-session-id"] !== undefined,
        protocolVersion: incoming.headers["mcp-protocol-version"] ?? null,
        ...(message?.method === "initialize" ? { clientInfo: message.params?.clientInfo } : {}),
      };
      requests.push(entry);
      const upstream = forward(
        new URL(incoming.url, addresses[replica]),
        {
          method: incoming.method,
          headers: { ...incoming.headers, host: new URL(addresses[replica]).host },
        },
        (response) => {
          entry.status = response.statusCode;
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on("error", () => {
        outgoing.destroy();
      });
      outgoing.once("close", () => upstream.destroy());
      upstream.end(body);
    });
  });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let child;
  try {
    await host.start();
    hostAddress = await host.app.listen({ port: 0, host: "127.0.0.1" });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    const gatewayUrl = `http://127.0.0.1:${address.port}/w/${workspace}`;
    const config = join(directory, "mcp.json");
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          embody: {
            type: "http",
            url: `${gatewayUrl}/mcp`,
            headers: { Authorization: `Bearer ${issued.token}` },
          },
        },
      }),
      { mode: 0o600 },
    );
    const env = { ...process.env };
    delete env.CLAUDECODE;
    child = spawn(
      "claude",
      [
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--mcp-config",
        config,
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks":true}',
        "--tools",
        "",
        "--disable-slash-commands",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "mcp__embody__kanban__kanban_ping",
        "--model",
        "haiku",
        "--max-budget-usd",
        "1",
        "--system-prompt",
        "Use only the provided MCP smoke tool when asked. Do not access files or other services. Report the returned marker.",
      ],
      { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const exited = once(child, "exit");
    const results = [];
    const toolUses = [];
    const models = new Set();
    let buffer = "";
    let markResult;
    let pending;
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.model) models.add(message.model);
        if (message.message?.model) models.add(message.message.model);
        for (const block of message.message?.content ?? []) {
          if (block.type === "tool_use") toolUses.push({ name: block.name });
        }
        if (message.type === "result") {
          // Retain only selected synthetic summary fields, never raw provider logs/config.
          const result = {
            subtype: message.subtype,
            isError: message.is_error,
            markerObserved: String(message.result).includes("M06_CLIENT_OK"),
            costUsd: message.total_cost_usd,
          };
          results.push(result);
          markResult?.(result);
        }
      }
    });
    child.stderr.on("data", () => {}); // No raw client diagnostics in public evidence.
    const turn = async (prompt) => {
      pending = new Promise((resolve) => {
        markResult = resolve;
      });
      child.stdin.write(
        `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`,
      );
      const result = await Promise.race([
        pending,
        exited.then(() => {
          throw new Error("Client exited before completing smoke turn");
        }),
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Real client turn exceeded 120 seconds")),
            120_000,
          );
          timer.unref();
        }),
      ]);
      assert.equal(result.isError, false);
      assert.equal(result.markerObserved, true);
    };
    await turn(
      "Call the embody kanban ping MCP tool exactly once and report its marker. Do not simulate a tool call.",
    );
    assert.equal(executions, 1);
    assert(requests.some((request) => request.method === "initialize"));
    assert(requests.some((request) => request.method === "tools/list"));
    const discoveryRequests = requests.filter((request) =>
      ["initialize", "tools/list", "notifications/initialized"].includes(request.method),
    );
    assert(discoveryRequests.every((request) => request.authenticated));
    await gateways[0].close();
    gateways[0] = makeGateway();
    addresses[0] = await gateways[0].listen({ port: 0, host: "127.0.0.1" });
    await turn(
      "The gateway has been replaced. Call the same embody kanban ping MCP tool exactly once again, then report the marker.",
    );
    assert.equal(executions, 2);
    assert.equal(appRequests, 2); // MCP discovery never reached the host.
    const idleStart = new Date().toISOString();
    const beforeIdle = requests.length;
    // Real idle behavior must be observed, not inferred from a transport option.
    await new Promise((resolve) => setTimeout(resolve, 120_000));
    const idle = {
      from: idleStart,
      to: new Date().toISOString(),
      observedSeconds: 120,
      newRequests: requests.length - beforeIdle,
      activeResponses,
      openSockets: sockets.size,
      clientStillRunning: child.exitCode === null,
    };
    assert.equal(idle.clientStillRunning, true);
    assert.equal(idle.newRequests, 0);
    assert.equal(idle.activeResponses, 0);
    assert.equal(idle.openSockets, 0);
    assert.equal(requests.filter((request) => request.method === "initialize").length, 1);
    const gets = requests.filter(
      (request) => request.httpMethod === "GET" && request.path.endsWith("/mcp"),
    );
    assert(gets.length <= 1, "Repeated MCP GET probes/reconnects are unsupported");
    assert(gets.every((request) => request.status === 405));
    child.stdin.end();
    const [exitCode] = await Promise.race([
      exited,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Client shutdown exceeded 20 seconds")),
          20_000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(exitCode, 0);
    // Plain CLI uses real authenticated HTTP discovery and execution, not MCP.
    const cliEnv = {
      ...process.env,
      EMBODY_GATEWAY_URL: gatewayUrl,
      EMBODY_TOKEN: issued.token,
      EMBODY_CACHE_DIR: directory,
    };
    const cli = spawn(
      process.execPath,
      [join(root, "packages/cli/dist/bin.js"), "kanban", "ping", "--output", "json"],
      { cwd: directory, env: cliEnv, timeout: 30_000 },
    );
    let cliOutput = "";
    cli.stdout.on("data", (chunk) => {
      cliOutput += chunk;
    });
    cli.stderr.on("data", () => {});
    const [cliCode] = await once(cli, "exit");
    assert.equal(cliCode, 0);
    assert.deepEqual(JSON.parse(cliOutput), { ok: true, marker: "M06_CLIENT_OK" });
    assert.equal(executions, 3);
    assert.equal(appRequests, 3);
    const mcpRequests = requests.filter((request) => request.path.endsWith("/mcp"));
    assert(mcpRequests.every((request) => request.authenticated && !request.sessionHeader));
    assert(
      mcpRequests
        .filter((request) => ["GET", "DELETE"].includes(request.httpMethod))
        .every((request) => request.status === 405),
    );
    await evidence(
      "mvp-client",
      "passed",
      { clientToolCalls: 2, plainCliCalls: 1, failed: 0, skipped: 0 },
      [],
      {
        client: clientVersion,
        sdk: "1.32.1",
        models: [...models],
        environment: "local synthetic hosted gateway + authenticated host",
        gatewayReplacement: true,
        idle,
        results,
        toolUses,
        requests,
        appRequestsBeforeCli: 2,
        appRequestsAfterCli: appRequests,
        limitations: [
          "No cloud zero-instance proof",
          "120-second idle window is not a universal client guarantee",
          "Memory catalog here; mandatory PostgreSQL gate supplies durable-store proof",
        ],
      },
    );
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(() => resolve()));
    await Promise.all(gateways.map((gateway) => gateway.close()));
    await host.stop();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
