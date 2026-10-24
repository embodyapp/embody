// M14 local integration topology: everything the packed CLI talks to, on one machine.
//
//   packed CLI ──HTTP──► hosted workspace gateway (real routes: catalog, execute, MCP, M10
//                        sources, M12 deployments, M14 app list) on the platform PostgreSQL
//                        fixture, durable audit to a captured sink
//                        │ controller tasks (in-memory queue, delivered when due)
//                        ▼
//                        deployment controller (real M12 controller, M11 build admission,
//                        M13 release stages, candidate sweep)
//                          ├─ builds: the exact platform build plan on local Docker (M11
//                          │  Cloud Build emulator, real recipe image, local framework registry)
//                          ├─ per-app database and framework migrations on the fixture through
//                          │  the provisioner role (real PostgresAppDatabase)
//                          └─ candidates: the admitted image as a Docker container with exactly
//                             the stage-specified environment (local candidate provider)
//
// Provider stand-ins (no IAM, no Cloud Run ingress/scaling, Cloud Tasks recorded but not
// delivered, JWKS over HTTP) are why this is local evidence only. The operator steps (workspace,
// reserved apps, app identities, credentials) are explicit and happen before the journey.
import { generateKeyPairSync } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { DockerCandidateProvider, localHealthProbe, wait } from "./local-candidates.mjs";

const { AbortSignal, Buffer, URL } = globalThis;

// Every service binds loopback: candidates use host networking on Linux and Docker Desktop's
// host.docker.internal (which reaches the host's loopback) elsewhere.
const listen = (server, host) =>
  new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

/**
 * `deps`: { gateway, host, storage } (dist modules), `recipe`, `builds` (LocalBuildProvider),
 * `objects` (MemorySourceObjectStore served at its origin), `platformUrl`, `provisionerUrl`,
 * `runtimeHost` (where candidates reach PostgreSQL), `hostAlias` (where candidates reach this
 * machine), `network` ("host" on Linux), `run`, `preload` (emulator path).
 */
export async function startLocalTopology(deps) {
  const { gateway: gw, host, storage } = deps;
  const issuer = "https://gateway.m14.test";
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signing = await gw.hostedSigningIdentity({
    issuer,
    kid: "m14-local",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeys: [
      { ...publicKey.export({ format: "jwk" }), kid: "m14-local", alg: "ES256", use: "sig" },
    ],
  });
  // Candidates are loopback containers here; the hosted policy otherwise refuses private routes.
  const policy = { credentials: {}, allowPrivateEndpoints: true };
  const store = new gw.PostgresGatewayStore(deps.platformUrl, policy);
  const auditLines = [];
  const workerLines = [];
  const servers = [];

  // Provider errors are swallowed into `poll-error` by design (never surfaced to users); record
  // their messages for the operator's view of this local run.
  for (const method of ["submit", "get", "readOutput", "cancel"]) {
    const original = deps.builds[method].bind(deps.builds);
    deps.builds[method] = async (...args) => {
      try {
        return await original(...args);
      } catch (error) {
        workerLines.push(JSON.stringify({ provider: method, error: String(error?.message) }));
        throw error;
      }
    };
  }

  // The candidates' Cloud Tasks stand-in: records each task (queue path and decoded body).
  const tasks = [];
  const recorder = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      try {
        const task = JSON.parse(body).task;
        tasks.push({
          queue: decodeURIComponent(request.url ?? "").replace(/^\/tasks\/v2\//, ""),
          scheduleTime: task.scheduleTime,
          url: task.httpRequest?.url,
          body: JSON.parse(Buffer.from(task.httpRequest?.body ?? "", "base64").toString()),
        });
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      } catch {
        response.writeHead(400).end();
      }
    });
  });
  const recorderPort = await listen(recorder, "127.0.0.1");
  servers.push(recorder);

  const queue = new host.MemoryTaskQueue();
  const identities = new gw.MemoryAppIdentityProvider();
  const migrations = storage.STORAGE_MIGRATIONS.map((m) => ({
    version: m.version,
    compatibility: m.compatibility,
    postgres: m.postgres,
    ...(m.readerFloor !== undefined ? { readerFloor: m.readerFloor } : {}),
  }));
  const database = new gw.PostgresAppDatabase({
    provisionerUrl: deps.provisionerUrl,
    runtimeHost: deps.runtimeHost,
    migrations,
    runtimeFunctions: storage.STORAGE_RUNTIME_FUNCTIONS,
  });
  const gateway = gw.createWorkspaceGateway({
    store,
    token: signing,
    // Candidates are on loopback in this topology (the hosted default refuses private hosts).
    fetch: globalThis.fetch,
    audit: gw.jsonLineAuditSink((line) => void auditLines.push(line)),
    sources: { objects: deps.objects },
    deployments: { queue },
  });
  const gatewayPort = Number(new URL(await gateway.listen({ host: "127.0.0.1", port: 0 })).port);
  const root = `http://127.0.0.1:${gatewayPort}`;

  // A reverse proxy serving the gateway under /edge (M14.c prefix case), streaming both ways.
  const proxy = createServer((request, response) => {
    if (!request.url?.startsWith("/edge/")) return void response.writeHead(404).end();
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: gatewayPort,
        method: request.method,
        path: request.url.slice("/edge".length),
        headers: request.headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  const proxyPort = await listen(proxy, "127.0.0.1");
  servers.push(proxy);

  const prefix = "m14l";
  const candidates = new DockerCandidateProvider({
    run: deps.run,
    prefix,
    secrets: identities,
    network: deps.network,
    preload: deps.preload,
    emulator: {
      jwksOrigin: issuer,
      gateway: `http://${deps.hostAlias}:${gatewayPort}`,
      tasks: `http://${deps.hostAlias}:${recorderPort}`,
    },
  });
  const platform = {
    prefix,
    gatewayServiceAccount: "embody-gateway@embody-m14-local.iam.gserviceaccount.com",
    controllerServiceAccount: "embody-controller@embody-m14-local.iam.gserviceaccount.com",
    jwtIssuer: issuer,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    wakeBaseUrl: "https://worker.m14.test",
  };
  const stages = new gw.ReleaseStages({
    platform,
    candidates,
    identities,
    database,
    health: localHealthProbe(),
    outputs: deps.builds,
    store,
    migrations,
    validate: (registration) => gw.validateRegistration(registration, policy),
  });
  const controller = new gw.DeploymentController({
    store,
    queue,
    builds: new gw.BuildAdmission({
      store,
      provider: deps.builds,
      recipe: deps.recipe,
      sources: deps.objects,
    }),
    stages,
    sweeper: new gw.CandidateSweep({ prefix, candidates, store }),
    log: (record) => void workerLines.push(JSON.stringify(record)),
  });

  // The controller queue: tasks are delivered when due, one at a time, retried on 503 as Cloud
  // Tasks would. Nothing else wakes the controller.
  let stopped = false;
  let delivered = 0;
  const pump = (async () => {
    while (!stopped) {
      const due = queue.due(new Date());
      if (due.length === 0) {
        await wait(200);
        continue;
      }
      const task = due[0];
      try {
        const result = await controller.handle(task.body);
        delivered += 1;
        if (result.status !== 503) queue.acknowledge(task.name);
        else await wait(1000);
      } catch (error) {
        workerLines.push(JSON.stringify({ pumpError: String(error?.message ?? error) }));
        await wait(1000);
      }
    }
  })();

  /** Operator provisioning (before the journey): workspace, reserved apps, identities, keys. */
  const operator = {
    async workspace(workspaceId) {
      await store.createWorkspace(workspaceId);
    },
    async reserveApp(workspaceId, appId, name, durable) {
      await store.putApp(
        {
          workspaceId,
          appId,
          name,
          registration: null,
          activeRelease: null,
          state: "unavailable",
        },
        null,
      );
      const names = gw.appResourceNames(prefix, workspaceId, appId);
      for (let i = 0; i < 5; i += 1)
        if (
          (await gw.provisionAppIdentity(identities, names, {
            workspaceId,
            appId,
            durable,
            controllerEmail: platform.controllerServiceAccount,
            signal: AbortSignal.timeout(10_000),
          })) === "ready"
        )
          return names;
      throw new Error("App provisioning did not converge");
    },
    async credential(workspaceId, actorId, grants, scopes = []) {
      const issued = gw.newCredential({
        workspaceId,
        principal: { orgId: workspaceId, actorId, actorType: "human", roles: [], scopes },
        grants: grants.map((grant) => ({ workspaceId, ...grant })),
        expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
      });
      const record = await store.putCredential(issued.credential, null);
      return {
        token: issued.token,
        revoke: () => store.putCredential({ ...record, revoked: true }, record.revision),
      };
    },
  };

  return {
    root,
    edge: `http://127.0.0.1:${proxyPort}/edge`,
    store,
    candidates,
    tasks,
    auditLines,
    workerLines,
    operator,
    delivered: () => delivered,
    /** The candidate currently serving `appId` (from the catalog route). */
    async activeCandidate(workspaceId, appId) {
      const snapshot = await store.snapshot(workspaceId);
      const endpoint = snapshot?.apps.find((app) => app.appId === appId)?.registration?.endpoint;
      const list = await candidates.list();
      return list.find((candidate) => candidate.endpoint === endpoint)?.name;
    },
    async dropAppDatabases(workspaceId, appIds) {
      const { default: pg } = await import(deps.pgModule);
      const client = new pg.Client({ connectionString: deps.provisionerUrl });
      await client.connect();
      const dropped = [];
      try {
        for (const appId of appIds) {
          const names = gw.appResourceNames(prefix, workspaceId, appId);
          await client
            .query(
              "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
              [names.database],
            )
            .catch(() => undefined);
          await client.query(`GRANT "${names.ownerRole}" TO CURRENT_USER`).catch(() => undefined);
          await client.query(`DROP DATABASE IF EXISTS "${names.database}"`);
          for (const role of [names.runtimeRole, names.ownerRole])
            await client.query(`DROP ROLE IF EXISTS "${role}"`);
          dropped.push(names.database);
        }
      } finally {
        await client.end();
      }
      return dropped;
    },
    async close() {
      stopped = true;
      await pump;
      await gateway.close();
      for (const server of servers) await close(server);
      await store.close();
    },
  };
}
