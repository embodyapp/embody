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
      expect(await store.artifact(workspace, "app_kanban0001", created.artifactId)).toEqual(created);
      expect(await store.artifact(workspace, "app_other00001", created.artifactId)).toBeNull();
      await expect(store.createArtifact(record())).rejects.toThrow(/exists/);
      await expect(store.createArtifact(record({ artifactId: created.artifactId, attempt: 2 }))).rejects.toThrow(/exists/);
      await expect(
        store.createArtifact(record({ workspaceId: "ws_missing00001" })),
      ).rejects.toThrow();
      await expect(store.createArtifact(record({ attempt: 0 }))).rejects.toThrow();
      expect((await store.createArtifact(record({ attempt: 2 }))).attempt).toBe(2);
    });
    it("M11 updates by revision CAS with immutable identity and build binding", async () => {
      const created = await store.createArtifact(record());
      const submitted = await store.updateArtifact({ ...created, buildId: "build-1" }, 1);
      await expect(store.updateArtifact({ ...created, buildId: "build-2" }, 1)).rejects.toThrow(/conflict/i);
      await expect(store.updateArtifact({ ...submitted, buildId: "build-2" }, 2)).rejects.toThrow(/immutable/);
      await expect(store.updateArtifact({ ...submitted, sourceDigest: digest(9) }, 2)).rejects.toThrow(/immutable/);
      await expect(store.updateArtifact({ ...submitted, configDigest: digest(9) }, 2)).rejects.toThrow(/immutable/);
      const admitted = await store.updateArtifact(
        { ...submitted, state: "admitted", imageDigest: digest(3) },
        2,
      );
      await expect(
        store.updateArtifact({ ...admitted, imageDigest: digest(4) }, 3),
      ).rejects.toThrow(/immutable/);
      expect(await store.artifactDigests(workspace, "app_kanban0001")).toEqual(new Set([digest(3)]));
      expect((await store.artifactDigests(workspace, "app_other00001")).size).toBe(0);
    });
    it("M11 lists expired unpinned artifacts and fences purges", async () => {
      const a = await store.createArtifact(record({ retainUntil: new Date(t0.getTime() + DAY).toISOString() }));
      const b = await store.createArtifact(
        record({ attempt: 2, retainUntil: new Date(t0.getTime() + DAY).toISOString(), pinnedBy: "rel_aaaaaaaa" }),
      );
      const later = new Date(t0.getTime() + 2 * DAY);
      const expired = (await store.expiredArtifacts(later, 100)).filter((r) => r.workspaceId === workspace);
      expect(expired.map((r) => r.artifactId)).toEqual([a.artifactId]);
      const fenced = await store.updateArtifact({ ...a, purging: true }, a.revision);
      expect(await store.artifact(workspace, "app_kanban0001", a.artifactId)).toBeNull();
      await expect(store.updateArtifact({ ...fenced, purging: false }, fenced.revision)).rejects.toThrow(/conflict/i);
      const tombstones = (await store.expiredArtifacts(later, 100)).filter((r) => r.workspaceId === workspace);
      expect(tombstones[0]?.purging).toBe(true);
      expect(await store.deleteArtifact(a as never)).toBe(false);
      expect(await store.deleteArtifact(fenced)).toBe(true);
      expect(await store.deleteArtifact(b)).toBe(false);
    });
  });
}
