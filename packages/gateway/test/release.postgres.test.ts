import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Kernel, definePlugin, defineWorkflow, z, type Principal } from "@embody/core";
import {
  BUILD_RECIPE,
  HOSTED_PROFILE,
  submissionFingerprint,
  type DeploymentSubmission,
} from "@embody/cloud-contracts";
import { WorkflowWorker } from "@embody/host";
import { PostgresStorage, STORAGE_RUNTIME_FUNCTIONS } from "@embody/storage";
import {
  BuildAdmission,
  DeploymentController,
  MemorySourceObjectStore,
  MigrationRefusedError,
  PostgresAppDatabase,
  PostgresGatewayStore,
  appResourceNames,
  candidateName,
  provisionAppIdentity,
  deploymentWakeHook,
  purgeExpiredSources,
  workflowRefusal,
  type DeploymentRecord,
  type DeploymentTaskBody,
  type ReleaseRecord,
  type TaskResult,
} from "../src/index.js";
import { APP, pin, requestOnly } from "./deployment-fixture.js";
import { NAME, plainPlugin, releaseHarness } from "./release-fixture.js";
import {
  createFixtureTables,
  createTableBuildProvider,
  createTableQueue,
  recipe,
} from "./fixtures/m12-fixtures.mjs";
import {
  appDatabase,
  candidateSweep,
  createM13Tables,
  createTableCandidates,
  createTableIdentities,
  migrations,
  platform,
  releaseStages,
} from "./fixtures/m13-fixtures.mjs";

const url = process.env["EMBODY_PLATFORM_URL"];
const migrationUrl = process.env["EMBODY_PLATFORM_MIGRATION_URL"];
const provisionerUrl = process.env["EMBODY_PROVISIONER_URL"];
if (
  process.env["EMBODY_PLATFORM_REQUIRED"] === "true" &&
  (!url || !migrationUrl || !provisionerUrl)
)
  throw new Error("Required platform PostgreSQL and provisioner configuration missing");
const enabled = !!url && !!migrationUrl && !!provisionerUrl;
const DAY = 86_400_000;
const workspace = () => `ws_${randomBytes(8).toString("hex")}`;
const principal = (orgId: string): Principal => ({
  orgId,
  actorId: "alice",
  actorType: "human",
  roles: [],
  scopes: ["app:*"],
});
async function query<T extends object>(
  connectionString: string,
  sql: string,
  values: unknown[] = [],
) {
  const client = new Client({ connectionString });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return (await client.query<T>(sql, values)).rows;
  } finally {
    await client.end();
  }
}

// `pnpm test:m13` runs this file with zero skips; ordinary workspace runs may skip it.
// Crash cases spawn and kill worker processes and run several stages against real PostgreSQL:
// they need more than vitest's 5 s default on a loaded CI runner.
describe.skipIf(!enabled)("M13 on real PostgreSQL (test:m13)", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const maintenance = new PostgresGatewayStore(migrationUrl!);
    await maintenance.migrate();
    await maintenance.close();
    const role = decodeURIComponent(new URL(url!).username);
    await createFixtureTables(migrationUrl!, role);
    await createM13Tables(migrationUrl!, role);
  });

  describe("per-app database: least privilege, bounded migrations, refusal before execution", () => {
    const database = new PostgresAppDatabase({
      provisionerUrl: provisionerUrl ?? "postgresql://unset@127.0.0.1/postgres",
      runtimeHost: new URL(provisionerUrl ?? "postgresql://127.0.0.1").host,
      migrations,
      runtimeFunctions: STORAGE_RUNTIME_FUNCTIONS,
    });
    const provision = async () => {
      const names = appResourceNames("emt", workspace(), "app_kanban0001");
      await database.ensure(names);
      await database.ensure(names); // idempotent
      const password = randomBytes(24).toString("base64url");
      await database.setCredential(names, password, "1");
      while (
        (await database.applyNextMigration(names, BUILD_RECIPE.storageSchemaVersion)) === "applied"
      );
      return { names, runtimeUrl: database.runtimeUrl(names, password) };
    };
    const boot = async (runtimeUrl: string, plugins = [plainPlugin()]) => {
      const storage = new PostgresStorage(
        { connectionString: runtimeUrl, max: 2 },
        { schemaMode: "verify" },
      );
      const kernel = new Kernel({ plugins, storage, profile: "request-only" });
      await kernel.boot();
      return kernel;
    };

    it("provisions owner and runtime roles with least privilege; the runtime boots the hosted schema", async () => {
      const { names, runtimeUrl } = await provision();
      expect(await database.appliedMigrations(names)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(await database.credentialMarker(names)).toBe("1");
      const roles = await query<{
        rolname: string;
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolbypassrls: boolean;
        rolconnlimit: number;
      }>(
        provisionerUrl!,
        "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolconnlimit FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname",
        [[names.ownerRole, names.runtimeRole]],
      );
      expect(roles).toEqual([
        {
          rolname: names.ownerRole,
          rolcanlogin: false,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
          rolconnlimit: -1,
        },
        {
          rolname: names.runtimeRole,
          rolcanlogin: true,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
          rolconnlimit: 15,
        },
      ]);
      const kernel = await boot(runtimeUrl);
      const created = (await kernel.execute(
        "app.card.create",
        { data: { title: "hello" } },
        { principal: principal("org-a") },
      )) as { id: string };
      expect(created.id).toBeDefined();
      await kernel.stop();
      // The runtime has no DDL, no other app's database; the provisioner cannot read app data.
      await expect(query(runtimeUrl, "CREATE TABLE public.m13_forbidden (id int)")).rejects.toThrow(
        /permission denied/,
      );
      const other = await provision();
      const foreign = new URL(runtimeUrl);
      foreign.pathname = `/${other.names.database}`;
      await expect(query(foreign.toString(), "SELECT 1")).rejects.toThrow(
        /permission denied|not permitted/,
      );
      const asProvisioner = new URL(provisionerUrl!);
      asProvisioner.pathname = `/${names.database}`;
      await expect(
        query(asProvisioner.toString(), "SELECT * FROM public.embody_entities"),
      ).rejects.toThrow(/permission denied/);
    });

    it("M13.b a destructive migration is refused before execution and a failing one rolls back: data unchanged", async () => {
      const { names, runtimeUrl } = await provision();
      const kernel = await boot(runtimeUrl);
      for (let i = 0; i < 5; i++)
        await kernel.execute(
          "app.card.create",
          { data: { title: `row ${i}` } },
          { principal: principal("org-a") },
        );
      await kernel.stop();
      const checksum = await database.checksum(names);
      expect(checksum).not.toBe("empty");
      const destructive = new PostgresAppDatabase({
        provisionerUrl: provisionerUrl!,
        runtimeHost: "127.0.0.1",
        migrations: [
          ...migrations,
          { version: 7, compatibility: "contract", postgres: "DELETE FROM embody_entities" },
        ],
        runtimeFunctions: STORAGE_RUNTIME_FUNCTIONS,
      });
      await expect(destructive.applyNextMigration(names, 7)).rejects.toMatchObject({
        name: "MigrationRefusedError",
        reason: "MIGRATION_REJECTED",
      });
      const failing = new PostgresAppDatabase({
        provisionerUrl: provisionerUrl!,
        runtimeHost: "127.0.0.1",
        migrations: [
          ...migrations,
          {
            version: 7,
            compatibility: "expand",
            postgres:
              "ALTER TABLE embody_entities ADD COLUMN m13_note text; UPDATE embody_entities SET m13_note = 'x'; SELECT 1/0;",
          },
        ],
        runtimeFunctions: STORAGE_RUNTIME_FUNCTIONS,
      });
      await expect(failing.applyNextMigration(names, 7)).rejects.toThrow(/division by zero/);
      expect(await database.appliedMigrations(names)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(await database.checksum(names)).toBe(checksum);
      const columns = await query<{ n: number }>(
        Object.assign(new URL(provisionerUrl!), { pathname: `/${names.database}` }).toString(),
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='embody_entities' AND column_name='m13_note'",
      );
      expect(columns[0]!.n).toBe(0);
      expect(new MigrationRefusedError("X").reason).toBe("X");
    });

    it("M13.b an applied expand migration leaves the previous release bootable with its data", async () => {
      const { names, runtimeUrl } = await provision();
      const kernel = await boot(runtimeUrl);
      await kernel.execute(
        "app.card.create",
        { data: { title: "before" } },
        { principal: principal("org-a") },
      );
      await kernel.stop();
      const checksum = await database.checksum(names);
      const newer = new PostgresAppDatabase({
        provisionerUrl: provisionerUrl!,
        runtimeHost: "127.0.0.1",
        migrations: [
          ...migrations,
          {
            version: 7,
            compatibility: "expand",
            postgres: "CREATE INDEX m13_entities_created ON embody_entities (created_at)",
          },
        ],
        runtimeFunctions: STORAGE_RUNTIME_FUNCTIONS,
      });
      expect(await newer.applyNextMigration(names, 7)).toBe("applied");
      expect(await newer.applyNextMigration(names, 7)).toBe("current");
      // Code built for schema 6 still boots (hosted check accepts the newer superset) and reads.
      const old = await boot(runtimeUrl);
      const listed = await old.execute("app.card.list", {}, { principal: principal("org-a") });
      expect(JSON.stringify(listed)).toContain('"title":"before"');
      await old.stop();
      expect(await database.checksum(names)).toBe(checksum);
    });

    it("M13.e an instance started on v1 finishes on the next release's code; dropping v1 is refused", async () => {
      const { names, runtimeUrl } = await provision();
      const done: string[] = [];
      const plugin = (extra: boolean) =>
        definePlugin({
          id: "app",
          version: "0.1.0",
          workflows: {
            fulfil: defineWorkflow(z.object({}))({
              version: "1.0.0",
              resultStep: "ship",
              steps: {
                ship: { handler: () => (done.push(extra ? "v2-code" : "v1-code"), { ok: true }) },
              },
            }),
            ...(extra
              ? {
                  fulfilNext: defineWorkflow(z.object({}))({
                    version: "2.0.0",
                    resultStep: "ship",
                    steps: { ship: { handler: () => ({ ok: true }) } },
                  }),
                }
              : {}),
          },
        });
      const start = async (plugins: ReturnType<typeof plugin>[]) => {
        const storage = new PostgresStorage(
          { connectionString: runtimeUrl, max: 2 },
          { schemaMode: "verify" },
        );
        const kernel = new Kernel({ plugins, storage });
        await kernel.boot();
        return { kernel, storage };
      };
      const v1 = await start([plugin(false)]);
      const started = (await v1.kernel.execute(
        "app.fulfil.start",
        { input: {}, idempotencyKey: "order-42" },
        { principal: principal("org-a") },
      )) as { id: string };
      await v1.kernel.stop();
      const inUse = await database.activeWorkflowVersions(names);
      expect(inUse).toEqual([{ definition: "app.fulfil", version: "1.0.0", instances: 1 }]);
      const manifest = (
        workflows: {
          target: string;
          version: string;
          steps: { name: string; dependsOn: string[] }[];
        }[],
      ) => ({ workflows }) as never;
      const ship = [{ name: "ship", dependsOn: [] as string[] }];
      expect(
        workflowRefusal(
          inUse,
          manifest([{ target: "app.fulfil", version: "2.0.0", steps: ship }]),
          undefined,
        ),
      ).toBe("WORKFLOW_VERSION_IN_USE");
      expect(
        workflowRefusal(
          inUse,
          manifest([
            { target: "app.fulfil", version: "1.0.0", steps: ship },
            { target: "app.fulfilNext", version: "2.0.0", steps: ship },
          ]),
          manifest([{ target: "app.fulfil", version: "1.0.0", steps: ship }]),
        ),
      ).toBeNull();
      // The next release keeps fulfil@1.0.0: the instance finishes on it.
      const v2 = await start([plugin(true)]);
      const worker = new WorkflowWorker({
        storage: v2.storage,
        kernel: v2.kernel,
        cancelPollMs: 0,
      });
      for (let tick = 0; tick < 4; tick++) await worker.tick();
      const status = (await v2.kernel.execute(
        "app.fulfil.status",
        { id: started.id },
        { principal: principal("org-a") },
      )) as { status: string; definitionVersion?: string };
      expect(status.status).toBe("completed");
      expect(done).toEqual(["v2-code"]);
      await v2.kernel.stop();
      expect(await database.activeWorkflowVersions(names)).toEqual([]);
    });
  });

  describe("promotion, rollback and retention on the PostgreSQL store", () => {
    let store: PostgresGatewayStore;
    let reader: PostgresGatewayStore;
    beforeAll(() => {
      store = new PostgresGatewayStore(url!);
      reader = new PostgresGatewayStore(url!);
    });
    afterAll(async () => {
      await Promise.all([store.close(), reader.close()]);
    });
    const harness = () => releaseHarness({ store, workspaceId: workspace() });
    const pinColumns = async (table: "artifacts" | "sources", ws: string) =>
      query<{ pinned: boolean; by: string | null }>(
        url!,
        `SELECT pinned, document->>'pinnedBy' AS by FROM embody_platform_${table} WHERE workspace_id=$1`,
        [ws],
      );

    it("M13.a first deploy registers, an update switches route and manifest, replaced pins are released", async () => {
      const h = await harness();
      const first = await h.deploy([plainPlugin(["ping"])]);
      expect(first.state).toBe("active");
      expect((await h.catalog()).registration).toMatchObject({
        appId: NAME,
        endpoint: first.candidate!.endpoint,
      });
      const second = await h.deploy([plainPlugin(["ping", "pong"])]);
      const app = await h.catalog();
      expect(app).toMatchObject({ activeRelease: second.releaseId, state: "idle", generation: 3 });
      expect(app.registration!.endpoint).toBe(second.candidate!.endpoint);
      expect(app.registration!.manifest.actions).toHaveProperty(["app.pong"]);
      const old = (await store.release(h.workspaceId, APP, first.releaseId!))!;
      expect(old.inactiveSince).toBeDefined();
      expect(
        (await store.artifact(h.workspaceId, APP, first.artifactId!))!.pinnedBy,
      ).toBeUndefined();
      expect(
        (await store.source(h.workspaceId, APP, first.submission.source.uploadId))!.pinnedBy,
      ).toBeUndefined();
      // M12 re-review N4: the PostgreSQL pinned column always agrees with the document.
      for (const table of ["artifacts", "sources"] as const)
        for (const row of await pinColumns(table, h.workspaceId))
          expect(row.pinned).toBe(row.by !== null);
      expect((await pinColumns("sources", h.workspaceId)).filter((row) => row.pinned)).toEqual([
        { pinned: true, by: second.releaseId },
      ]);
    });

    it("M13.a no mixed catalogs: another pool sees the old pair or the new pair, never a mix", async () => {
      const h = await harness();
      const releases = new Map<string, ReleaseRecord>();
      const first = await h.deploy([plainPlugin(["ping"])]);
      releases.set(first.releaseId!, (await store.release(h.workspaceId, APP, first.releaseId!))!);
      let done = false;
      const seen: string[] = [];
      const observe = (async () => {
        while (!done) {
          const app = (await reader.snapshot(h.workspaceId))!.apps[0]!;
          seen.push(
            `${app.activeRelease}|${app.registration!.endpoint}|${"app.pong" in app.registration!.manifest.actions}|${app.generation}`,
          );
        }
      })();
      const updates: DeploymentRecord[] = [];
      for (let i = 0; i < 3; i++)
        updates.push(await h.deploy([plainPlugin(i % 2 ? ["ping"] : ["ping", "pong"])]));
      done = true;
      await observe;
      for (const update of updates)
        releases.set(
          update.releaseId!,
          (await store.release(h.workspaceId, APP, update.releaseId!))!,
        );
      const expected = new Set(
        [...releases.values()].map(
          (r) =>
            `${r.releaseId}|${r.registration!.endpoint}|${"app.pong" in r.registration!.manifest.actions}|${r.generation}`,
        ),
      );
      expect(seen.length).toBeGreaterThan(3);
      for (const pair of seen) expect(expected.has(pair)).toBe(true);
    });

    it("M13.c two deployments promoting concurrently on separate pools: one wins, one generation step", async () => {
      const h = await harness();
      await h.deploy([plainPlugin(["ping"])]);
      const generation = (await h.catalog()).generation;
      h.state.plugins = [plainPlugin(["ping", "pong"])];
      const a = await h.submit(await h.submission());
      const b = await h.submit(await h.submission());
      // Bring both to promoting, then complete both promotions concurrently on two pools.
      for (let round = 0; round < 400; round++) {
        const states = await Promise.all([h.reload(a), h.reload(b)]);
        if (states.every((r) => r!.state === "promoting")) break;
        const due = h.queue.due(h.clock.now());
        const task = due.find((t) => {
          const id = t.body.deploymentId;
          return !states.some((r) => r!.deploymentId === id && r!.state === "promoting");
        });
        if (!task) {
          h.clock.advance(5000);
          continue;
        }
        h.completeBuilds();
        await h.controller.handle(task.body);
        h.queue.acknowledge(task.name);
      }
      const claims = await Promise.all([
        store.claimDeployment(a, h.clock.now(), h.wake),
        reader.claimDeployment(b, h.clock.now(), h.wake),
      ]);
      const manifest = (await h.catalog()).registration!.manifest;
      const outcome = (
        target: PostgresGatewayStore,
        record: DeploymentRecord,
        claim: (typeof claims)[number],
      ) => {
        const next = (claim.decision as { next: DeploymentRecord }).next;
        return target.completeDeployment(
          {
            workspaceId: h.workspaceId,
            appId: APP,
            deploymentId: record.deploymentId,
            epoch: next.epoch,
            leaseToken: next.leaseToken!,
          },
          {
            kind: "promote",
            releaseId: `rel_${randomBytes(8).toString("hex")}`,
            registration: {
              protocolVersion: 1,
              appId: NAME,
              version: "0.1.0",
              endpoint: next.candidate!.endpoint,
              healthCheckUrl: `${next.candidate!.endpoint}/health`,
              manifest,
            },
          },
          h.clock.now(),
          h.wake,
        );
      };
      const [ra, rb] = await Promise.all([
        outcome(store, a, claims[0]),
        outcome(reader, b, claims[1]),
      ]);
      expect([ra.state, rb.state].sort()).toEqual(["active", "failed"]);
      expect([ra, rb].find((r) => r.state === "failed")!.error).toBe("STALE_GENERATION");
      const app = await h.catalog();
      expect(app.generation).toBe(generation + 1);
      expect(app.activeRelease).toBe([ra, rb].find((r) => r.state === "active")!.releaseId);
    });

    it("M13.d rollback on PostgreSQL: replay, refusal when expired, previous code promoted again", async () => {
      const h = await harness();
      const v1 = await h.deploy([plainPlugin(["ping"])]);
      const v1Manifest = (await h.catalog()).registration!.manifest;
      await h.deploy([plainPlugin(["ping", "pong"])]);
      const generation = (await h.catalog()).generation;
      const input = {
        workspaceId: h.workspaceId,
        appId: APP,
        releaseId: v1.releaseId!,
        expectedGeneration: generation,
        actorId: "alice",
        now: h.clock.now(),
      };
      const first = await store.submitRollback(input, h.wake);
      const replay = await store.submitRollback(input, h.wake);
      expect(replay).toEqual({ record: first.record, replay: true });
      await h.run();
      const done = (await h.reload(first.record))!;
      expect(done).toMatchObject({ state: "active", rollbackOf: v1.releaseId });
      expect((await h.catalog()).registration!.manifest).toEqual(v1Manifest);
      expect((await store.artifact(h.workspaceId, APP, v1.artifactId!))!.pinnedBy).toBe(
        done.releaseId,
      );
      h.clock.advance((HOSTED_PROFILE.inactiveReleaseRetentionDays + 1) * DAY);
      const latest = (await h.catalog()).generation;
      await expect(
        store.submitRollback({ ...input, expectedGeneration: latest, now: h.clock.now() }, h.wake),
      ).rejects.toMatchObject({ code: "ROLLBACK_INCOMPATIBLE" });
    });

    it("retention: >100 MiB promoted over time stays uploadable once replaced releases expire", async () => {
      const h = await harness();
      const bytes = HOSTED_PROFILE.maxSourceBytes;
      const records: DeploymentRecord[] = [];
      for (let i = 0; i < 9; i++) records.push(await h.deploy([plainPlugin()], {}, bytes));
      h.clock.advance((HOSTED_PROFILE.deploymentRetentionDays + 1) * DAY);
      const purged = await purgeExpiredSources({
        store,
        objects: h.objects,
        now: h.clock.now(),
        limit: 100,
      });
      expect(purged.deleted).toBeGreaterThanOrEqual(8);
      expect(
        await store.source(h.workspaceId, APP, records.at(-1)!.submission.source.uploadId),
      ).not.toBeNull();
      for (let i = 0; i < 8; i++) await h.submission({}, bytes);
    });

    it("migrate() releases pins held by releases replaced before M13 (M12 re-review N1/N3)", async () => {
      const h = await harness();
      const first = await h.deploy([plainPlugin(["ping"])]);
      await h.deploy([plainPlugin(["ping", "pong"])]);
      // Reconstruct an M12-era row: no lifecycle, still pinning its artifact and source.
      await query(
        migrationUrl!,
        "UPDATE embody_platform_releases SET document = document - 'inactiveSince' - 'drainUntil' - 'retainUntil' WHERE workspace_id=$1 AND release_id=$2",
        [h.workspaceId, first.releaseId],
      );
      for (const [table, key, value] of [
        ["artifacts", "artifact_id", first.artifactId],
        ["sources", "upload_id", first.submission.source.uploadId],
      ] as const)
        await query(
          migrationUrl!,
          `UPDATE embody_platform_${table} SET pinned=true, document = document || jsonb_build_object('pinnedBy', $3::text) WHERE workspace_id=$1 AND ${key}=$2`,
          [h.workspaceId, value, first.releaseId],
        );
      const maintenance = new PostgresGatewayStore(migrationUrl!);
      await maintenance.migrate();
      await maintenance.close();
      const release = (await store.release(h.workspaceId, APP, first.releaseId!))!;
      expect(release.inactiveSince).toBeDefined();
      expect(Date.parse(release.retainUntil!) - Date.parse(release.inactiveSince!)).toBe(
        HOSTED_PROFILE.inactiveReleaseRetentionDays * DAY,
      );
      expect(
        (await store.artifact(h.workspaceId, APP, first.artifactId!))!.pinnedBy,
      ).toBeUndefined();
      expect(
        (await store.source(h.workspaceId, APP, first.submission.source.uploadId))!.pinnedBy,
      ).toBeUndefined();
      for (const table of ["artifacts", "sources"] as const)
        for (const row of await pinColumns(table, h.workspaceId))
          expect(row.pinned).toBe(row.by !== null);
    });
  });

  describe("crash matrix with SIGKILLed workers (real release stages and app database)", () => {
    let store: PostgresGatewayStore;
    let queue: ReturnType<typeof createTableQueue>;
    let provider: ReturnType<typeof createTableBuildProvider>;
    let candidates: ReturnType<typeof createTableCandidates>;
    let identities: ReturnType<typeof createTableIdentities>;
    let offset = 0;
    const clock = { now: () => new Date(Date.now() + offset) };
    beforeAll(() => {
      store = new PostgresGatewayStore(url!);
      queue = createTableQueue(url!);
      provider = createTableBuildProvider(url!);
      candidates = createTableCandidates(url!);
      identities = createTableIdentities(url!);
    });
    afterAll(async () => {
      await Promise.all([
        store.close(),
        queue.close(),
        provider.close(),
        candidates.close(),
        identities.close(),
      ]);
    });
    const controller = () =>
      new DeploymentController({
        store,
        queue,
        builds: new BuildAdmission({
          store,
          provider,
          recipe,
          sources: new MemorySourceObjectStore({ clock }),
          clock,
        }),
        stages: releaseStages({
          store,
          candidates,
          identities,
          database: appDatabase(provisionerUrl!),
          outputs: provider,
        }),
        sweeper: candidateSweep(store, candidates),
        clock,
      });
    type Task = { name: string; scheduleAt: string; body: DeploymentTaskBody };
    const drive = async (ws: string) => {
      const results: TaskResult[] = [];
      const worker = controller();
      for (let round = 0; round < 400; round++) {
        const due = (await queue.due(ws, clock.now())) as Task[];
        if (!due.length) {
          const pending = (await queue.pending(ws)) as Task[];
          if (!pending.length) return results;
          offset += Math.max(
            1000,
            Math.min(...pending.map((t) => Date.parse(t.scheduleAt))) - clock.now().getTime(),
          );
          continue;
        }
        const result = await worker.handle(due[0]!.body);
        results.push(result);
        if (result.status === 503) offset += 5000;
        else await queue.acknowledge(due[0]!.name);
      }
      throw new Error("Deployment did not settle");
    };
    const seed = async (ws: string) => {
      await store.createWorkspace(ws);
      await store.putApp(
        {
          workspaceId: ws,
          appId: APP,
          // The table build provider names the built app "my-app"; the platform name must match it.
          name: "my-app",
          registration: null,
          activeRelease: null,
          state: "unavailable",
        },
        null,
      );
      // App provisioning at reservation (trusted admin step), not the worker.
      await provisionAppIdentity(identities, appResourceNames(platform.prefix, ws, APP), {
        workspaceId: ws,
        appId: APP,
        durable: false,
        controllerEmail: platform.controllerServiceAccount,
        signal: new AbortController().signal,
      });
      let n = 0;
      return async (): Promise<DeploymentSubmission> => {
        n += 1;
        const key = `source_key_${String(n).padStart(8, "0")}`;
        const digest = pin(`source-${ws}-${key}`);
        const { record } = await store.admitSource({
          workspaceId: ws,
          appId: APP,
          idempotencyKey: key,
          digest,
          bytes: 100,
          actorId: "alice",
          now: clock.now(),
        });
        const verified = await store.updateSource(
          { ...record, state: "verified", verifiedAt: clock.now().toISOString() },
          record.revision,
        );
        const app = await store.appStatus(ws, APP);
        return {
          version: 1,
          workspaceId: ws,
          appId: APP,
          idempotencyKey: `deploy_key_${String(n).padStart(8, "0")}`,
          source: { uploadId: verified.uploadId, digest, bytes: 100 },
          expectedGeneration: app!.generation,
          capabilities: requestOnly,
          secretReferences: [],
        } as unknown as DeploymentSubmission;
      };
    };
    const submit = async (submission: DeploymentSubmission) =>
      (
        await store.submitDeployment(
          {
            submission,
            fingerprint: submissionFingerprint(submission),
            actorId: "alice",
            now: clock.now(),
          },
          deploymentWakeHook(queue),
        )
      ).record;
    const child = fileURLToPath(new URL("./fixtures/m13-crash-child.mjs", import.meta.url));
    const run = async (task: DeploymentTaskBody, point: string) => {
      const proc = spawn(process.execPath, [child], {
        env: {
          ...process.env,
          M13_TASK: JSON.stringify(task),
          M13_CRASH_AT: point,
          M13_CLOCK_OFFSET: String(offset),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      try {
        return await new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`${point} not reached: ${stderr}`)),
            30_000,
          );
          proc.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
            if (stdout.includes(`PAUSED ${point}`)) {
              clearTimeout(timer);
              resolve(true);
            } else if (stdout.includes("DONE")) {
              clearTimeout(timer);
              resolve(false);
            }
          });
          proc.once("exit", (code) => {
            if (!stdout.includes("DONE") && !stdout.includes("PAUSED")) {
              clearTimeout(timer);
              reject(new Error(`child exited ${code}: ${stderr}`));
            }
          });
        });
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) {
          const exited = once(proc, "exit");
          proc.kill("SIGKILL");
          await exited;
        }
      }
    };
    /** Deliver due tasks in a child until it is killed at `point` (earlier tasks run to completion). */
    const crashAt = async (ws: string, point: string) => {
      for (let i = 0; i < 200; i++) {
        const due = (await queue.due(ws, clock.now())) as Task[];
        if (!due.length) {
          const pending = (await queue.pending(ws)) as Task[];
          if (!pending.length) throw new Error(`${point} never reached`);
          offset += Math.max(
            1000,
            Math.min(...pending.map((t) => Date.parse(t.scheduleAt))) - clock.now().getTime(),
          );
          continue;
        }
        if (await run(due[0]!.body, point)) return due[0]!;
        await queue.acknowledge(due[0]!.name);
      }
      throw new Error(`${point} never reached`);
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
    const expectOneActive = async (ws: string, record: DeploymentRecord, generation: number) => {
      const final = (await store.deployment(ws, APP, record.deploymentId))!;
      expect(final.state).toBe("active");
      expect(await store.appStatus(ws, APP)).toMatchObject({
        generation: generation + 1,
        activeReleaseId: final.releaseId,
      });
      const app = (await store.snapshot(ws))!.apps[0]!;
      expect(app.registration!.endpoint).toBe(final.candidate!.endpoint);
      const own = (await candidates.forWorkspace(ws)).filter(
        (c: { name: string }) => c.name === candidateName(platform.prefix, final),
      );
      expect(own).toHaveLength(1);
      expect(await queue.pending(ws)).toEqual([]);
      return final;
    };

    it("killed after a migration committed, before its receipt: the next step continues, each version once", async () => {
      const ws = workspace();
      const next = await seed(ws);
      const record = await submit(await next());
      await crashAt(ws, "after-migration");
      await settle();
      const names = appResourceNames(platform.prefix, ws, APP);
      const applied = await appDatabase(provisionerUrl!).appliedMigrations(names);
      expect(applied.length).toBeGreaterThanOrEqual(1);
      await drive(ws);
      await expectOneActive(ws, record, 1);
      expect(await appDatabase(provisionerUrl!).appliedMigrations(names)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
    });

    it("killed after a credential version was written, before the role: the credential converges", async () => {
      const ws = workspace();
      const next = await seed(ws);
      const record = await submit(await next());
      await crashAt(ws, "after-secret-version");
      await settle();
      await drive(ws);
      await expectOneActive(ws, record, 1);
      const names = appResourceNames(platform.prefix, ws, APP);
      // The orphaned version was superseded; the role matches the newest version, whose URL works.
      expect(await identities.versions(names.databaseSecret)).toBe(2);
      expect(await appDatabase(provisionerUrl!).credentialMarker(names)).toBe(
        await identities.latestSecretVersion(names.databaseSecret, new AbortController().signal),
      );
      expect(
        await query<{ ok: number }>(
          await identities.payload(names.databaseSecret),
          "SELECT 1 AS ok",
        ),
      ).toEqual([{ ok: 1 }]);
    });

    it("killed after the candidate was created, before its receipt: it is adopted, never duplicated", async () => {
      const ws = workspace();
      const next = await seed(ws);
      const record = await submit(await next());
      await crashAt(ws, "after-candidate-create");
      await settle();
      expect(await candidates.forWorkspace(ws)).toHaveLength(1);
      await drive(ws);
      await expectOneActive(ws, record, 1);
    });

    it("killed after an update's promotion committed, before the ACK: one switch, prior pins released once", async () => {
      const ws = workspace();
      const next = await seed(ws);
      const first = await submit(await next());
      await drive(ws);
      const firstDone = await expectOneActive(ws, first, 1);
      const second = await submit(await next());
      const task = await crashAt(ws, "after-promote");
      await settle();
      for (let i = 0; i < 3; i++)
        expect((await controller().handle(task.body)).outcome).toBe("terminal");
      await drive(ws);
      const final = await expectOneActive(ws, second, 2);
      expect((await store.release(ws, APP, firstDone.releaseId!))!.inactiveSince).toBeDefined();
      expect((await store.artifact(ws, APP, firstDone.artifactId!))!.pinnedBy).toBeUndefined();
      expect((await store.artifact(ws, APP, final.artifactId!))!.pinnedBy).toBe(final.releaseId);
      // After the drain, the sweep removes the replaced candidate and keeps the active one.
      offset += 11 * 60_000;
      await controller().sweep(true);
      const left = (await candidates.forWorkspace(ws)).map((c: { name: string }) => c.name);
      expect(left).toEqual([candidateName(platform.prefix, final)]);
    });
  });
});
