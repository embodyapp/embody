import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOURCE_ADMISSION } from "@embody/cloud-contracts";
import {
  SourceAdmissionError,
  type GatewayStore,
  type SourceAdmitInput,
  type SourceStore,
} from "../src/index.js";

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const DAY = 86_400_000;

/** Shared persistence contract for M10 source identity and retention metadata. */
export function sourceStoreConformance(
  name: string,
  factory: () => Promise<GatewayStore & SourceStore>,
): void {
  describe(name, () => {
    let store: GatewayStore & SourceStore;
    let workspace: string;
    const t0 = new Date("2030-01-01T00:00:00.000Z");
    const input = (overrides: Partial<SourceAdmitInput> = {}): SourceAdmitInput => ({
      workspaceId: workspace,
      appId: "app_kanban0001",
      idempotencyKey: "sha256_key_0000000001",
      digest: digest(1),
      bytes: 1000,
      actorId: "alice",
      now: t0,
      ...overrides,
    });
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => "resolved",
        (error: unknown) => (error instanceof SourceAdmissionError ? error.code : String(error)),
      );
    beforeEach(async () => {
      store = await factory();
      workspace = `ws_${randomUUID().replaceAll("-", "")}`;
      await store.createWorkspace(workspace);
    });
    afterEach(async () => {
      await store.close();
    });

    it("binds one workspace/app identity per key; replays never allocate another", async () => {
      const first = await store.admitSource(input());
      expect(first.replay).toBe(false);
      expect(first.record).toMatchObject({ state: "pending", attempt: 1, revision: 1 });
      expect(first.record.uploadId).toMatch(/^src_[a-z0-9]{24}$/);
      expect(first.record.objectKey).toBe(
        `sources/${workspace}/app_kanban0001/${first.record.uploadId}.tar.gz`,
      );
      expect(Date.parse(first.record.retainUntil) - t0.getTime()).toBe(
        SOURCE_ADMISSION.retentionDays * DAY,
      );
      const later = new Date(t0.getTime() + 5_000);
      const replay = await store.admitSource(input({ now: later }));
      expect(replay.replay).toBe(true);
      expect(replay.record.uploadId).toBe(first.record.uploadId);
      expect(replay.record.objectKey).toBe(first.record.objectKey);
      expect(Date.parse(replay.record.accessExpiresAt)).toBe(
        later.getTime() + SOURCE_ADMISSION.uploadAccessSeconds * 1000,
      );
      expect(await code(store.admitSource(input({ digest: digest(2) })))).toBe(
        "IDEMPOTENCY_CONFLICT",
      );
      expect(await code(store.admitSource(input({ bytes: 1001 })))).toBe("IDEMPOTENCY_CONFLICT");
      expect(await code(store.admitSource(input({ workspaceId: "ws_missing0001" })))).toMatch(
        /NotFound|Workspace not found/,
      );
    });

    it("serializes concurrent replays and enforces per-app pending and per-workspace byte quotas", async () => {
      const same = await Promise.all(Array.from({ length: 8 }, () => store.admitSource(input())));
      expect(new Set(same.map((r) => r.record.uploadId)).size).toBe(1);
      expect(same.filter((r) => !r.replay)).toHaveLength(1);
      const others = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          store.admitSource(
            input({ idempotencyKey: `sha256_key_concurrent_${i}`, digest: digest(10 + i) }),
          ),
        ),
      );
      expect(others.filter((r) => r.status === "fulfilled")).toHaveLength(
        SOURCE_ADMISSION.maxPendingUploadsPerApp - 1,
      );
      for (const rejected of others.filter((r) => r.status === "rejected"))
        expect((rejected.reason as SourceAdmissionError).code).toBe("LIMIT_EXCEEDED");
      // Pending uploads whose access expired stop counting.
      const afterAccess = new Date(t0.getTime() + SOURCE_ADMISSION.uploadAccessSeconds * 1000 + 1);
      await expect(
        store.admitSource(
          input({
            idempotencyKey: "sha256_key_after_access",
            digest: digest(99),
            now: afterAccess,
          }),
        ),
      ).resolves.toMatchObject({ replay: false });
      const big = SOURCE_ADMISSION.maxSourceBytes;
      const fresh = `ws_${randomUUID().replaceAll("-", "")}`;
      await store.createWorkspace(fresh);
      let accepted = 0;
      for (let i = 0; i < 20; i += 1) {
        const result = await code(
          store.admitSource(
            input({
              workspaceId: fresh,
              idempotencyKey: `sha256_key_bytes_${i}`,
              digest: digest(200 + i),
              bytes: big,
              // Advance past access expiry so the pending-per-app limit is not what stops us.
              now: new Date(t0.getTime() + i * (SOURCE_ADMISSION.uploadAccessSeconds * 1000 + 1)),
            }),
          ),
        );
        if (result === "resolved") accepted += 1;
        else expect(result).toBe("LIMIT_EXCEEDED");
      }
      expect(accepted).toBe(Math.floor(SOURCE_ADMISSION.maxRetainedSourceBytesPerWorkspace / big));
    });

    it("never resolves another workspace's or app's source", async () => {
      const { record } = await store.admitSource(input());
      const other = `ws_${randomUUID().replaceAll("-", "")}`;
      await store.createWorkspace(other);
      expect(await store.source(other, record.appId, record.uploadId)).toBeNull();
      expect(await store.source(workspace, "app_other00001", record.uploadId)).toBeNull();
      expect(await store.source(workspace, record.appId, record.uploadId)).toMatchObject({
        uploadId: record.uploadId,
      });
      const foreign = await store.admitSource(input({ workspaceId: other }));
      expect(foreign.replay).toBe(false);
      expect(foreign.record.uploadId).not.toBe(record.uploadId);
    });

    it("updates with CAS, keeps identity immutable and bounds retryable rejection attempts", async () => {
      const { record } = await store.admitSource(input());
      const rejected = await store.updateSource(
        { ...record, state: "rejected", error: "DIGEST_MISMATCH" },
        record.revision,
      );
      expect(rejected.revision).toBe(record.revision + 1);
      await expect(
        store.updateSource({ ...record, state: "verified" }, record.revision),
      ).rejects.toThrow(/conflict/i);
      await expect(
        store.updateSource({ ...rejected, digest: digest(7) }, rejected.revision),
      ).rejects.toThrow();
      let current = rejected;
      for (let attempt = 2; attempt <= SOURCE_ADMISSION.maxUploadAttempts; attempt += 1) {
        const retried = await store.admitSource(input());
        expect(retried.record).toMatchObject({
          uploadId: record.uploadId,
          state: "pending",
          attempt,
        });
        expect(retried.record.error).toBeUndefined();
        current = await store.updateSource(
          { ...retried.record, state: "rejected", error: "SIZE_MISMATCH" },
          retried.record.revision,
        );
      }
      const exhausted = await store.admitSource(input());
      expect(exhausted.record).toMatchObject({ state: "rejected", revision: current.revision });
      const terminal = await store.admitSource(
        input({ idempotencyKey: "sha256_key_terminal_01", digest: digest(3) }),
      );
      await store.updateSource(
        { ...terminal.record, state: "rejected", error: "UNSAFE_ENTRY" },
        terminal.record.revision,
      );
      expect(
        (
          await store.admitSource(
            input({ idempotencyKey: "sha256_key_terminal_01", digest: digest(3) }),
          )
        ).record,
      ).toMatchObject({ state: "rejected", error: "UNSAFE_ENTRY", attempt: 1 });
    });

    it("lists unpinned expired sources, deletes with CAS and renews an expired key in place", async () => {
      const { record } = await store.admitSource(input());
      const verified = await store.updateSource(
        { ...record, state: "verified", files: 2, expandedBytes: 10, treeDigest: digest(5) },
        record.revision,
      );
      const pinned = await store.admitSource(
        input({ idempotencyKey: "sha256_key_pinned_001", digest: digest(4) }),
      );
      await store.updateSource(
        { ...pinned.record, pinnedBy: "dep_aaaaaaaa" },
        pinned.record.revision,
      );
      const before = new Date(Date.parse(record.retainUntil) - 1);
      const after = new Date(Date.parse(record.retainUntil));
      // The sweep is global; other workspaces' rows may share the database.
      const mine = async (now: Date) =>
        (await store.expiredSources(now, 1000))
          .filter((r) => r.workspaceId === workspace)
          .map((r) => r.uploadId);
      expect(await mine(before)).toEqual([]);
      expect(await mine(after)).toEqual([record.uploadId]);
      const renewed = await store.admitSource(input({ now: after }));
      expect(renewed.record).toMatchObject({
        uploadId: record.uploadId,
        state: "pending",
        attempt: 1,
      });
      expect(renewed.record.treeDigest).toBeUndefined();
      expect(await store.deleteSource(verified)).toBe(false);
      expect(await store.deleteSource(renewed.record)).toBe(true);
      expect(await store.source(workspace, record.appId, record.uploadId)).toBeNull();
    });

    it("fences a purge with a tombstone: invisible, never updated, key gets a fresh identity", async () => {
      const { record } = await store.admitSource(input());
      const verified = await store.updateSource(
        { ...record, state: "verified", files: 2, expandedBytes: 10, treeDigest: digest(5) },
        record.revision,
      );
      const after = new Date(Date.parse(record.retainUntil));
      const tombstone = await store.updateSource({ ...verified, purging: true }, verified.revision);
      expect(await store.source(workspace, record.appId, record.uploadId)).toBeNull();
      // Neither a stale writer nor a pin can resurrect a tombstone.
      await expect(
        store.updateSource({ ...tombstone, purging: false }, tombstone.revision),
      ).rejects.toThrow();
      await expect(
        store.updateSource({ ...tombstone, pinnedBy: "dep_aaaaaaaa" }, tombstone.revision),
      ).rejects.toThrow();
      // The same key now admits a new identity with its own object key, not the tombstone.
      const fresh = await store.admitSource(input({ now: after }));
      expect(fresh.replay).toBe(false);
      expect(fresh.record.uploadId).not.toBe(record.uploadId);
      expect(fresh.record.objectKey).not.toBe(record.objectKey);
      expect(await store.admitSource(input({ now: after }))).toMatchObject({
        replay: true,
        record: { uploadId: fresh.record.uploadId },
      });
      // Tombstones stay listed until deleted (an interrupted sweep retries) and use no quota.
      const listed = (await store.expiredSources(after, 1000)).filter(
        (r) => r.workspaceId === workspace,
      );
      expect(listed.map((r) => [r.uploadId, r.purging])).toEqual([[record.uploadId, true]]);
      expect(
        await code(
          store.admitSource(
            input({
              now: after,
              idempotencyKey: "sha256_key_quota_0001",
              digest: digest(9),
              bytes: SOURCE_ADMISSION.maxRetainedSourceBytesPerWorkspace - 1000,
            }),
          ),
        ),
      ).toBe("resolved");
      expect(await store.deleteSource(tombstone)).toBe(true);
      expect(await store.source(workspace, record.appId, fresh.record.uploadId)).not.toBeNull();
    });
  });
}
