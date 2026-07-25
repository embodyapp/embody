/**
 * Integration test proving the load-bearing M2 decisions against a REAL Postgres:
 *   - D1: Row-Level Security isolates tenants (org A cannot see org B's rows), and
 *         fails closed when no tenant is set.
 *   - D2: the thin registry powers global search and the cross-plugin relationship
 *         graph.
 *   - D3: a shared party is created + registered atomically.
 *
 * Requires the docker-compose Postgres. Skips cleanly if it isn't reachable.
 * Run: `pnpm --filter @embody/core exec vitest run`
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, withTenant, bootstrap, runMigrations, type DbHandle } from "@embody/db";
import { coreMigrationsDir } from "./plugin.ts";
import { partyService, registryService } from "./services.ts";

const OWNER_URL =
  process.env.DATABASE_URL ?? "postgres://embody:embody@localhost:5432/embody";
const APP_URL =
  process.env.APP_DATABASE_URL ??
  OWNER_URL.replace("embody:embody@", "embody_app:embody_app@");

async function reachable(url: string): Promise<boolean> {
  try {
    const h = createDb(url, { max: 1 });
    await h.sql`select 1`;
    await h.close();
    return true;
  } catch {
    return false;
  }
}

const canRun = await reachable(OWNER_URL);
const suite = canRun ? describe : describe.skip;

suite("RLS + registry (integration)", () => {
  let owner: DbHandle;
  let appDb: DbHandle;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    owner = createDb(OWNER_URL);
    await bootstrap(owner.sql);
    await runMigrations(owner.sql, "core", coreMigrationsDir, "core");

    // Control-plane: create two orgs as the owner (bypasses RLS). Unique slugs so
    // repeated runs don't collide.
    const suffix = Date.now();
    const [a] = await owner.sql<{ id: string }[]>`
      insert into core.orgs (name, slug) values ('Org A', ${"org-a-" + suffix}) returning id`;
    const [b] = await owner.sql<{ id: string }[]>`
      insert into core.orgs (name, slug) values ('Org B', ${"org-b-" + suffix}) returning id`;
    orgA = a!.id;
    orgB = b!.id;

    // App role (subject to RLS) opens the tenant transactions.
    appDb = createDb(APP_URL);
  });

  afterAll(async () => {
    // Clean up just these orgs (cascades to their rows). Owner bypasses RLS.
    if (owner) {
      await owner.sql`delete from core.orgs where id in (${orgA}, ${orgB})`;
      await owner.close();
    }
    if (appDb) await appDb.close();
  });

  it("D3: creates a shared party and registers it atomically", async () => {
    const alice = await withTenant(appDb.sql, orgA, null, (tx) =>
      partyService.create(tx, { orgId: orgA, kind: "person", displayName: "Alice" }),
    );
    expect(alice.id).toBeTruthy();
    // The registry pointer exists for the same tenant.
    const entityId = await withTenant(appDb.sql, orgA, null, (tx) =>
      registryService.entityIdForSource(tx, {
        sourceSchema: "core",
        sourceTable: "parties",
        sourceId: alice.id,
      }),
    );
    expect(entityId).toBeTruthy();
  });

  it("D1: a tenant sees only its own rows", async () => {
    await withTenant(appDb.sql, orgA, null, (tx) =>
      partyService.create(tx, { orgId: orgA, kind: "organization", displayName: "Acme Inc" }),
    );
    await withTenant(appDb.sql, orgB, null, (tx) =>
      partyService.create(tx, { orgId: orgB, kind: "person", displayName: "Bob" }),
    );

    const namesA = await withTenant(appDb.sql, orgA, null, (tx) =>
      tx<{ display_name: string }[]>`select display_name from core.parties order by display_name`,
    );
    const namesB = await withTenant(appDb.sql, orgB, null, (tx) =>
      tx<{ display_name: string }[]>`select display_name from core.parties order by display_name`,
    );

    const setA = namesA.map((r) => r.display_name);
    const setB = namesB.map((r) => r.display_name);
    expect(setA).toContain("Alice");
    expect(setA).toContain("Acme Inc");
    expect(setA).not.toContain("Bob");
    expect(setB).toEqual(["Bob"]);
  });

  it("D1: fails closed when no tenant is set", async () => {
    const rows = await appDb.sql<{ n: string }[]>`select count(*)::text as n from core.parties`;
    expect(rows[0]!.n).toBe("0");
  });

  it("D2: global search finds an entity by label, scoped to the tenant", async () => {
    const hits = await withTenant(appDb.sql, orgA, null, (tx) =>
      registryService.search(tx, "Alice"),
    );
    expect(hits.some((h) => h.displayLabel === "Alice")).toBe(true);

    // Org B cannot find Org A's party via search.
    const hitsB = await withTenant(appDb.sql, orgB, null, (tx) =>
      registryService.search(tx, "Alice"),
    );
    expect(hitsB.length).toBe(0);
  });

  it("D2/D3: cross-app relationship graph links entities across plugins", async () => {
    await withTenant(appDb.sql, orgA, null, async (tx) => {
      // Alice (a core.party) already exists; find her registry id.
      const [alice] = await tx<{ id: string }[]>`
        select id from core.parties where display_name = 'Alice' limit 1`;
      const partyEntityId = await registryService.entityIdForSource(tx, {
        sourceSchema: "core",
        sourceTable: "parties",
        sourceId: alice!.id,
      });

      // Simulate a CRM deal owned by another plugin's schema — registered the same way.
      const fakeDealId = (await tx<{ id: string }[]>`select gen_random_uuid() as id`)[0]!.id;
      const dealEntityId = await registryService.register(tx, {
        orgId: orgA,
        type: "crm.deal",
        sourceSchema: "crm",
        sourceTable: "deals",
        sourceId: fakeDealId,
        displayLabel: "Big Deal",
      });

      await registryService.relate(tx, {
        orgId: orgA,
        fromEntityId: partyEntityId!,
        toEntityId: dealEntityId,
        kind: "deal_for_contact",
      });

      // The cross-app query: everything linked from Alice, regardless of plugin.
      const linked = await registryService.linkedFrom(tx, partyEntityId!);
      expect(linked.some((l) => l.type === "crm.deal" && l.displayLabel === "Big Deal")).toBe(
        true,
      );
    });
  });
});
