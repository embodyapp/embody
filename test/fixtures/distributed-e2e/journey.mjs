import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import { TextEncoder } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT } from "jose";

const root = resolve(import.meta.dirname, "../../..");
const composeFile = join(root, "docker-compose.e2e.yml");
const temporary = await mkdtemp(join(tmpdir(), "embody-e2e-"));
const project = `embody-e2e-${process.pid}`;
const secret = (label) => `${label}-${randomUUID()}-${randomUUID()}`;

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

const [gatewayPort, kanbanPort, emailPort] = await Promise.all([port(), port(), port()]);
const apiKey = secret("api");
const secondApiKey = secret("other-api");
const jwtSecret = secret("jwt-signing-key-at-least-32-bytes");
const issuer = "embody-distributed-e2e";
const envFile = join(temporary, "stack.env");
await writeFile(
  envFile,
  [
    "POSTGRES_USER=embody",
    `POSTGRES_PASSWORD=${secret("postgres")}`,
    "POSTGRES_DB=embody",
    `GATEWAY_PORT=${gatewayPort}`,
    `KANBAN_PORT=${kanbanPort}`,
    `EMAIL_PORT=${emailPort}`,
    `GATEWAY_API_KEY=${apiKey}`,
    `E2E_SECOND_API_KEY=${secondApiKey}`,
    `GATEWAY_JWT_ISSUER=${issuer}`,
    `GATEWAY_JWT_SECRET=${jwtSecret}`,
    `KANBAN_REGISTRATION_SECRET=${secret("kanban-registration")}`,
    `EMAIL_REGISTRATION_SECRET=${secret("email-registration")}`,
    `EVENT_DELIVERY_SECRET=${secret("event-delivery")}`,
    "E2E_ORG_ID=e2e-primary",
  ].join("\n"),
  { mode: 0o600 },
);

function command(program, args, options = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, { cwd: root, env: process.env, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
    child.on("error", reject);
    child.on("close", (code) => resolveCommand({ code: code ?? 1, stdout, stderr }));
  });
}
const composeArguments = (...args) => [
  "compose",
  "--project-name",
  project,
  "--env-file",
  envFile,
  "--file",
  composeFile,
  ...args,
];
const compose = (...args) => command("docker", composeArguments(...args));

async function eventually(operation, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePoll) => globalThis.setTimeout(resolvePoll, 200));
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
}

const gateway = `http://127.0.0.1:${gatewayPort}`;
async function catalog(token = apiKey) {
  const response = await globalThis.fetch(`${gateway}/api/catalog`, {
    headers: { authorization: `Bearer ${token}`, "cache-control": "no-cache" },
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function execute(app, target, input, token = apiKey) {
  return globalThis.fetch(`${gateway}/api/execute/${app}/${encodeURIComponent(target)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
async function executeOk(app, target, input, token = apiKey) {
  const response = await execute(app, target, input, token);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
async function cli(args, input) {
  return command(
    process.execPath,
    [join(root, "packages/cli/dist/bin.js"), ...args, "--base-url", gateway, "--token", apiKey],
    {
      input,
      env: { ...process.env, EMBODY_CACHE_DIR: join(temporary, "cli-cache") },
    },
  );
}
async function mailMessages() {
  const result = await compose("exec", "-T", "email", "cat", "/var/lib/embody/mail/messages.json");
  if (result.code !== 0) return undefined;
  return JSON.parse(result.stdout);
}

let mcp;
try {
  const started = await compose("up", "--detach", "--build", "--wait", "--wait-timeout", "180");
  assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);

  await eventually(async () => {
    const apps = await catalog();
    return apps.length === 2 && apps;
  }, "both app registrations");

  const listedCli = await cli(["apps", "list", "--output", "json"]);
  assert.equal(listedCli.code, 0, listedCli.stderr);
  assert.deepEqual(JSON.parse(listedCli.stdout).sort(), ["email", "kanban"]);

  mcp = new Client({ name: "distributed-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  });
  await mcp.connect(transport);
  const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
  assert(tools.includes("kanban__kanban_card_create"));
  assert(tools.includes("email__email_send_batch"));

  const createdCli = await cli(
    ["kanban", "card", "create", "--json", "--output", "json"],
    JSON.stringify({
      data: { title: "Distributed proof", status: "todo", priority: "medium" },
    }),
  );
  assert.equal(createdCli.code, 0, createdCli.stderr);
  const card = JSON.parse(createdCli.stdout);
  assert.equal(card.data.status, "todo");

  const mcpList = await mcp.callTool({ name: "kanban__kanban_card_list", arguments: {} });
  assert.notEqual(mcpList.isError, true);
  const listed = JSON.parse(mcpList.content[0].text);
  assert.equal(listed[0].id, card.id);

  const veto = await execute("kanban", "kanban.card.update", {
    id: card.id,
    data: { status: "done" },
  });
  assert.equal(veto.status, 422);
  assert.equal((await veto.json()).error.code, "HOOK_VETO");
  const unchanged = await executeOk("kanban", "kanban.card.get", { id: card.id });
  assert.equal(unchanged.data.status, "todo");
  const phantom = await compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "embody",
    "-d",
    "kanban",
    "-Atc",
    "select count(*) from embody_outbox where event_name='kanban.card.ready_for_review'",
  );
  assert.equal(phantom.stdout.trim(), "0");

  // Hold the entity table, begin a valid mutation, and terminate Kanban while its transaction is
  // blocked before commit. PostgreSQL must roll back the mutation and its outbox writes.
  const lock = spawn(
    "docker",
    composeArguments(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "embody",
      "-d",
      "kanban",
      "-c",
      "begin; lock table embody_entities in share mode; select pg_sleep(60);",
    ),
    { cwd: root, stdio: "ignore" },
  );
  await eventually(async () => {
    const query = await compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "embody",
      "-d",
      "kanban",
      "-Atc",
      "select count(*) from pg_locks l join pg_class c on c.oid=l.relation where c.relname='embody_entities' and l.mode='ShareLock' and l.granted",
    );
    return query.stdout.trim() === "1";
  }, "pre-commit database lock");
  const interrupted = execute("kanban", "kanban.card.update", {
    id: card.id,
    data: { status: "in_progress" },
  }).catch(() => undefined);
  await eventually(async () => {
    const query = await compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "embody",
      "-d",
      "kanban",
      "-Atc",
      "select count(*) from pg_locks l join pg_class c on c.oid=l.relation where c.relname='embody_entities' and l.mode='RowExclusiveLock' and not l.granted",
    );
    return Number(query.stdout.trim()) > 0;
  }, "blocked pre-commit mutation");
  assert.equal((await compose("kill", "kanban")).code, 0);
  const unlocked = await compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "embody",
    "-d",
    "kanban",
    "-Atc",
    "select pg_terminate_backend(pid) from pg_stat_activity where pid<>pg_backend_pid() and query like '%lock table embody_entities in share mode%'",
  );
  assert.equal(unlocked.code, 0, unlocked.stderr);
  lock.kill("SIGTERM");
  if (lock.exitCode === null) await once(lock, "close");
  await interrupted;
  assert.equal((await compose("start", "kanban")).code, 0);
  await eventually(
    () => globalThis.fetch(`http://127.0.0.1:${kanbanPort}/health`).then((response) => response.ok),
    "Kanban restart after pre-commit termination",
  );
  const rolledBack = await executeOk("kanban", "kanban.card.get", { id: card.id });
  assert.equal(rolledBack.data.status, "todo");

  // Route while the subscriber is unavailable: the durable destination row must survive recovery.
  assert.equal((await compose("stop", "email")).code, 0);
  const reviewed = await executeOk("kanban", "kanban.card.update", {
    id: card.id,
    data: { status: "in_review", prUrl: "https://example.com/pull/42" },
  });
  assert.equal(reviewed.data.status, "in_review");
  await eventually(async () => {
    const query = await compose(
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "embody",
      "-d",
      "kanban",
      "-Atc",
      "select count(*) from embody_event_deliveries where destination_app_id='email'",
    );
    return query.code === 0 && Number(query.stdout.trim()) === 1;
  }, "durable fan-out persistence");
  assert.equal((await compose("kill", "kanban")).code, 0);
  assert.equal((await compose("start", "email")).code, 0);
  assert.equal((await compose("start", "kanban")).code, 0);

  // The Email test adapter exits after its first durable side effect. Compose restarts it and the
  // retried envelope is suppressed by the event-derived idempotency key.
  const notifications = await eventually(
    async () => {
      const messages = await mailMessages();
      return messages?.filter((message) => message.subject.startsWith("Review Required")).length ===
        1
        ? messages
        : undefined;
    },
    "idempotent notification after injected crash",
    45_000,
  );
  assert.equal(
    notifications.filter((message) => message.subject.startsWith("Review Required")).length,
    1,
  );
  await eventually(
    async () => {
      const query = await compose(
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "embody",
        "-d",
        "kanban",
        "-Atc",
        "select status from embody_event_deliveries limit 1",
      );
      return query.stdout.trim() === "completed";
    },
    "delivery acknowledgement",
    45_000,
  );

  const recipients = Array.from({ length: 12 }, (_, index) => `cli-${index}@example.com`);
  const batchCli = await cli(
    ["email", "sendBatch", "--json", "--output", "json"],
    JSON.stringify({ campaignId: "cli-batch", recipients, subject: "Hello", template: "Body" }),
  );
  assert.equal(batchCli.code, 0, batchCli.stderr);
  assert.match(batchCli.stderr, /83% Sent 10 of 12 emails\n100% Sent 12 of 12 emails/);
  assert.equal(JSON.parse(batchCli.stdout).totalSent, 12);

  const progress = [];
  const batchMcp = await mcp.callTool(
    {
      name: "email__email_send_batch",
      arguments: {
        campaignId: "mcp-batch",
        recipients: Array.from({ length: 12 }, (_, index) => `mcp-${index}@example.com`),
        subject: "MCP",
        template: "Body",
      },
    },
    undefined,
    { onprogress: (update) => progress.push(update.progress) },
  );
  assert.deepEqual(progress, [83, 100]);
  assert.equal(JSON.parse(batchMcp.content[0].text).totalSent, 12);

  assert.equal((await compose("stop", "kanban")).code, 0);
  await eventually(
    async () => (await catalog()).map((app) => app.appId).join() === "email",
    "TTL removal",
  );
  assert(!(await mcp.listTools()).tools.some((tool) => tool.name.startsWith("kanban__")));
  const unavailable = await execute("kanban", "kanban.card.get", { id: card.id });
  assert.equal(unavailable.status, 503);
  assert.equal((await compose("start", "kanban")).code, 0);
  await eventually(
    async () => (await catalog()).some((app) => app.appId === "kanban"),
    "re-registration",
  );
  assert((await mcp.listTools()).tools.some((tool) => tool.name.startsWith("kanban__")));
  await mcp.close();
  mcp = undefined;

  const otherCatalog = await catalog(secondApiKey);
  assert.deepEqual(
    otherCatalog.map((app) => app.appId),
    ["kanban"],
  );
  const forbiddenEmail = await execute("email", "email.sendBatch", {}, secondApiKey);
  assert.equal(forbiddenEmail.status, 403);
  const isolated = await executeOk("kanban", "kanban.card.list", {}, secondApiKey);
  assert.deepEqual(isolated, []);
  await executeOk("kanban", "kanban.card.create", { data: { title: "Other org" } }, secondApiKey);
  const primary = await executeOk("kanban", "kanban.card.list", {});
  assert.deepEqual(
    primary.map((item) => item.id),
    [card.id],
  );

  const wrongAudience = await new SignJWT({
    orgId: "e2e-primary",
    actorId: "e2e-agent",
    actorType: "agent",
    roles: [],
    scopes: ["kanban:*"],
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(issuer)
    .setAudience("email")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(jwtSecret));
  const rejectedAudience = await globalThis.fetch(`http://127.0.0.1:${kanbanPort}/execute`, {
    method: "POST",
    headers: { "x-gateway-auth": `Bearer ${wrongAudience}`, "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, target: "kanban.card.list", input: {} }),
  });
  assert.equal(rejectedAudience.status, 401);

  console.log(
    "Distributed P10 journey passed (CLI, MCP, HTTP, events, restart, TTL, and isolation).",
  );
} finally {
  await mcp?.close().catch(() => undefined);
  const stopped = await compose("down", "--volumes", "--remove-orphans", "--timeout", "10");
  if (stopped.code !== 0) console.error(stopped.stderr);
  await rm(temporary, { recursive: true, force: true });
}
