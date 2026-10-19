import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactStore, ArtifactWrite, GatewayStore } from "../src/index.js";

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const DAY = 86_400_000;

/** Shared persistence contract for M11 artifact records (memory and PostgreSQL). */
export function artifactStoreConformance(
  name: string,
  factory: () => Promise<GatewayStore & ArtifactStore>,
): void {
  describe(name, () => {
    let store: GatewayStore & ArtifactStore;
    let workspace: string;
    const t0 = new Date("2030-01-01T00:00:00.000Z");
    const record = (overrides: Partial<ArtifactWrite> = {}): ArtifactWrite => ({
      workspaceId: workspace,
      appId: "app_kanban0001",
      deploymentId: "dep_kanban0001",
      attempt: 1,
      artifactId: `art_${randomUUID().replaceAll("-", "")}`,
      sourceUploadId: "src_kanban0001",
      sourceDigest: digest(1),
      state: "building",
      recipe: "embody-node24-pnpm-v1",
      configDigest: digest(2),
      image: "us-central1-docker.pkg.dev/p0000/builds/ws/app:art",
      outputPrefix: "builds/x/",
      logsBucket: "gs://b/logs/x",
      createdAt: t0.toISOString(),
      retainUntil: new Date(t0.getTime() + 90 * DAY).toISOString(),
      ...overrides,
    });
    beforeEach(async () => {
      store = await factory();
      workspace = `ws_${randomUUID().replaceAll("-", "")}`;
      await store.createWorkspace(workspace);
    });
    afterEach(async () => store.close());

    it("M11 creates one artifact per deployment attempt and finds it again", async () => {
      const created = await store.createArtifact(record());
      expect(created.revision).toBe(1);
      expect(
        await store.artifactForAttempt(workspace, "app_kanban0001", "dep_kanban0001", 1),
      ).toEqual(created);
      expect(await store.artifact(workspace, "app_kanban0001", created.artifactId)).toEqual(
        created,
      );
      expect(await store.artifact(workspace, "app_other00001", created.artifactId)).toBeNull();
      await expect(store.createArtifact(record())).rejects.toThrow(/exists/);
      await expect(
        store.createArtifact(record({ artifactId: created.artifactId, attempt: 2 })),
      ).rejects.toThrow(/exists/);
      await expect(
        store.createArtifact(record({ workspaceId: "ws_missing00001" })),
      ).rejects.toThrow();
      await expect(store.createArtifact(record({ attempt: 0 }))).rejects.toThrow();
      expect((await store.createArtifact(record({ attempt: 2 }))).attempt).toBe(2);
    });
    it("M11 updates by revision CAS with immutable identity and build binding", async () => {
      const created = await store.createArtifact(record());
      const submitted = await store.updateArtifact({ ...created, buildId: "build-1" }, 1);
      await expect(store.updateArtifact({ ...created, buildId: "build-2" }, 1)).rejects.toThrow(
        /conflict/i,
      );
      await expect(store.updateArtifact({ ...submitted, buildId: "build-2" }, 2)).rejects.toThrow(
        /immutable/,
      );
      await expect(
        store.updateArtifact({ ...submitted, sourceDigest: digest(9) }, 2),
      ).rejects.toThrow(/immutable/);
      await expect(
        store.updateArtifact({ ...submitted, configDigest: digest(9) }, 2),
      ).rejects.toThrow(/immutable/);
      const admitted = await store.updateArtifact(
        { ...submitted, state: "admitted", imageDigest: digest(3) },
        2,
      );
      await expect(
        store.updateArtifact({ ...admitted, imageDigest: digest(4) }, 3),
      ).rejects.toThrow(/immutable/);
      const keys = await store.artifactKeys(workspace, "app_kanban0001");
      expect(keys.digests).toEqual(new Set([digest(3)]));
      expect(keys.artifactIds).toEqual(new Set([created.artifactId]));
      expect((await store.artifactKeys(workspace, "app_other00001")).artifactIds.size).toBe(0);
      // A settled decision is frozen; only retention fields may change (review finding 8).
      for (const change of [
        { state: "rejected" as const, error: "BUILD_FAILED" as const },
        { imageReference: "other@sha256:0" },
        { manifestDigest: digest(7) },
      ])
        await expect(store.updateArtifact({ ...admitted, ...change }, 3)).rejects.toThrow(
          /immutable/,
        );
      expect(
        (await store.updateArtifact({ ...admitted, pinnedBy: "rel_aaaaaaaa" }, 3)).pinnedBy,
      ).toBe("rel_aaaaaaaa");
    });
    it("M11 pins an admitted artifact using the record the store returned (review B3)", async () => {
      const created = await store.createArtifact(record());
      // Key orders the JSON column will not preserve.
      const admitted = await store.updateArtifact(
        {
          ...created,
          buildId: "build-1",
          state: "admitted",
          imageDigest: digest(3),
          imageReference: `us-central1-docker.pkg.dev/p0000/builds/ws/app@${digest(3)}`,
          manifestDigest: digest(4),
          sbomDigest: digest(5),
          manifest: {
            workflows: [
              {
                version: "0.1.0",
                target: "app.followUp",
                steps: [{ dependsOn: [], name: "remind" }],
              },
            ],
            version: 1,
            subscriptions: ["app.submitted"],
            recipe: "embody-node24-pnpm-v1",
            publishes: ["app.submitted"],
            profile: "durable-v1",
            nodeMajor: 24,
            entrypoint: "dist/src/index.js",
            catalogDigest: digest(6),
            appVersion: "0.1.0",
            appId: "my-app",
          },
          provenance: {
            startTime: t0.toISOString(),
            configDigest: digest(2),
            buildId: "build-1",
            builder: "b@p.iam.gserviceaccount.com",
          },
          finishedAt: t0.toISOString(),
        },
        1,
      );
      const pinned = await store.updateArtifact(
        { ...admitted, pinnedBy: "rel_aaaaaaaa" },
        admitted.revision,
      );
      expect(pinned.pinnedBy).toBe("rel_aaaaaaaa");
      const reread = await store.artifact(workspace, "app_kanban0001", created.artifactId);
      const { pinnedBy: _pin, ...withoutPin } = reread!;
      void _pin;
      const unpinned = await store.updateArtifact(withoutPin, reread!.revision);
      expect(unpinned.pinnedBy).toBeUndefined();
      // The decision itself stays frozen, whatever the key order.
      await expect(
        store.updateArtifact(
          { ...unpinned, manifest: { ...unpinned.manifest!, publishes: ["app.forged"] } },
          unpinned.revision,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        store.updateArtifact(
          { ...unpinned, finishedAt: new Date(0).toISOString() },
          unpinned.revision,
        ),
      ).rejects.toThrow(/immutable/);
    });
    it("M11 pages expired artifacts by cursor in a stable order (review B2)", async () => {
      const base = Date.parse("1990-01-01T00:00:00.000Z");
      const ids: string[] = [];
      for (let n = 0; n < 3; n++)
        ids.push(
          (
            await store.createArtifact(
              record({
                attempt: n + 1,
                // Two rows share a retainUntil: the tie breaks on artifact ID.
                retainUntil: new Date(base + Math.min(n, 1) * 1000).toISOString(),
              }),
            )
          ).artifactId,
        );
      const now = new Date(base + 10_000);
      const seen: string[] = [];
      let after;
      for (let page = 0; page < 1000; page++) {
        const rows = await store.expiredArtifacts(now, 2, after);
        if (rows.length === 0) break;
        for (const row of rows) if (row.workspaceId === workspace) seen.push(row.artifactId);
        const last = rows[rows.length - 1]!;
        after = {
          retainUntil: last.retainUntil,
          workspaceId: last.workspaceId,
          artifactId: last.artifactId,
        };
      }
      const tied = [ids[1]!, ids[2]!].sort();
      expect(seen).toEqual([ids[0]!, ...tied]);
    });
    it("M11 lists expired unpinned artifacts and fences purges", async () => {
      const a = await store.createArtifact(
        record({ retainUntil: new Date(t0.getTime() + DAY).toISOString() }),
      );
      const b = await store.createArtifact(
        record({
          attempt: 2,
          retainUntil: new Date(t0.getTime() + DAY).toISOString(),
          pinnedBy: "rel_aaaaaaaa",
        }),
      );
      const later = new Date(t0.getTime() + 2 * DAY);
      const expired = (await store.expiredArtifacts(later, 100)).filter(
        (r) => r.workspaceId === workspace,
      );
      expect(expired.map((r) => r.artifactId)).toEqual([a.artifactId]);
      const fenced = await store.updateArtifact({ ...a, purging: true }, a.revision);
      expect(await store.artifact(workspace, "app_kanban0001", a.artifactId)).toBeNull();
      await expect(
        store.updateArtifact({ ...fenced, purging: false }, fenced.revision),
      ).rejects.toThrow(/conflict/i);
      const tombstones = (await store.expiredArtifacts(later, 100)).filter(
        (r) => r.workspaceId === workspace,
      );
      expect(tombstones[0]?.purging).toBe(true);
      expect(await store.deleteArtifact(a as never)).toBe(false);
      expect(await store.deleteArtifact(fenced)).toBe(true);
      expect(await store.deleteArtifact(b)).toBe(false);
    });
  });
}
