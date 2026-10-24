import { describe, expect, it } from "vitest";
import {
  AppManagementSchema,
  AppStatusSchema,
  AppListSchema,
  CapabilitiesSchema,
  DeploymentIdSchema,
  DeploymentStateSchema,
  DeploymentStatusSchema,
  DeploymentSubmissionSchema,
  DeploymentTransitionSchema,
  HOSTED_PROFILE,
  PublicErrorSchema,
  ReleaseManifestSchema,
  SecretReferenceSchema,
  ScopedGrantSchema,
  canPromote,
  canCancel,
  hasPermission,
  parseSubmissionJson,
  publicError,
  submissionFingerprint,
} from "../src/index.js";
import type { Permission, Role, SubmissionRepository } from "../src/index.js";

const binding = { workspaceId: "ws_aaaaaaaa", appId: "app_aaaaaaaa" };
const capabilities = {
  profile: "request-only-v1",
  crud: true,
  boundedActions: true,
  workflows: false,
  schedules: false,
  subscriptions: false,
  appToAppRpc: false,
  persistentLocalState: false,
  genui: false,
};
const source = { uploadId: "src_aaaaaaaa", digest: `sha256:${"a".repeat(64)}`, bytes: 1234 };
const input = {
  version: 1,
  ...binding,
  idempotencyKey: "submission_key_01",
  source,
  expectedGeneration: 0,
  capabilities,
  secretReferences: [],
};
const secret = {
  version: 1,
  ...binding,
  name: "API_KEY",
  secretId: "sec_aaaaaaaa",
  secretVersion: 1,
};
const status = {
  version: 1,
  ...binding,
  deploymentId: "dep_aaaaaaaa",
  sourceDigest: source.digest,
  state: "accepted",
  stageAttempt: 1,
  expectedGeneration: 0,
  cancellationFence: 0,
  lifecycleFence: 0,
};
const appStatus = {
  version: 1,
  ...binding,
  generation: 0,
  lifecycleFence: 0,
  status: "enabled",
  activeReleaseId: null,
};

// Reference contract fixture only: not a production store or proof of durable locking.
function referenceRepository(): SubmissionRepository {
  const records = new Map<
    string,
    { fingerprint: string; deploymentId: ReturnType<typeof DeploymentIdSchema.parse> }
  >();
  return {
    submit(request) {
      const parsed = DeploymentSubmissionSchema.parse(request);
      const key = `${parsed.workspaceId}/${parsed.appId}/${parsed.idempotencyKey}`;
      const fingerprint = submissionFingerprint(parsed);
      const existing = records.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          return Promise.reject(new Error("IDEMPOTENCY_CONFLICT"));
        return Promise.resolve({ deploymentId: existing.deploymentId, replay: true });
      }
      const deploymentId = DeploymentIdSchema.parse(
        `dep_${String(records.size + 1).padStart(8, "0")}`,
      );
      records.set(key, { fingerprint, deploymentId });
      return Promise.resolve({ deploymentId, replay: false });
    },
  };
}

// M12 must run these same cases against its real durable store, plus crash/concurrency tests.
function repositoryContract(factory: () => SubmissionRepository) {
  describe("M02.b submission repository contract", () => {
    it("replays identical submissions and key-order changes", async () => {
      const store = factory();
      const request = DeploymentSubmissionSchema.parse(input);
      const first = await store.submit(request);
      const second = await store.submit(
        DeploymentSubmissionSchema.parse({
          ...input,
          source: { bytes: 1234, digest: source.digest, uploadId: source.uploadId },
        }),
      );
      expect(first.replay).toBe(false);
      expect(second).toEqual({ deploymentId: first.deploymentId, replay: true });
    });
    it.each([
      { source: { ...source, digest: `sha256:${"b".repeat(64)}` } },
      { source: { ...source, uploadId: "src_bbbbbbbb" } },
      { source: { ...source, bytes: source.bytes + 1 } },
      { expectedGeneration: 1 },
      { capabilities: { ...capabilities, crud: false } },
      { secretReferences: [secret] },
    ])("conflicts when any accepted request field changes: %j", async (change) => {
      const store = factory();
      await store.submit(DeploymentSubmissionSchema.parse(input));
      await expect(
        store.submit(DeploymentSubmissionSchema.parse({ ...input, ...change })),
      ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    });
    it("binds existing secret IDs, versions and array ordering", async () => {
      const original = {
        ...input,
        secretReferences: [secret, { ...secret, name: "SECOND_KEY", secretId: "sec_bbbbbbbb" }],
      };
      for (const refs of [
        [{ ...secret, secretVersion: 2 }, original.secretReferences[1]],
        [{ ...secret, secretId: "sec_cccccccc" }, original.secretReferences[1]],
        [...original.secretReferences].reverse(),
      ]) {
        const store = factory();
        await store.submit(DeploymentSubmissionSchema.parse(original));
        await expect(
          store.submit(DeploymentSubmissionSchema.parse({ ...original, secretReferences: refs })),
        ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
      }
    });
    it("creates a new deployment for a new key even when other fields match", async () => {
      const store = factory();
      const first = await store.submit(DeploymentSubmissionSchema.parse(input));
      const second = await store.submit(
        DeploymentSubmissionSchema.parse({ ...input, idempotencyKey: "submission_key_02" }),
      );
      expect(second.replay).toBe(false);
      expect(second.deploymentId).not.toBe(first.deploymentId);
    });
    it("scopes keys by workspace and app; concurrent fixture replay has one identity", async () => {
      const store = factory();
      const request = DeploymentSubmissionSchema.parse(input);
      const results = await Promise.all(Array.from({ length: 10 }, () => store.submit(request)));
      expect(new Set(results.map((result) => result.deploymentId)).size).toBe(1);
      expect(results.filter((result) => !result.replay)).toHaveLength(1);
      const other = await store.submit(
        DeploymentSubmissionSchema.parse({ ...input, workspaceId: "ws_bbbbbbbb" }),
      );
      const otherApp = await store.submit(
        DeploymentSubmissionSchema.parse({ ...input, appId: "app_bbbbbbbb" }),
      );
      expect(other.deploymentId).not.toBe(results[0]?.deploymentId);
      expect(otherApp.deploymentId).not.toBe(other.deploymentId);
    });
  });
}
repositoryContract(referenceRepository);

describe("M02.a versioned schemas and request-only profile", () => {
  it("accepts submission, manifest, status, secret references and management", () => {
    expect(parseSubmissionJson(JSON.stringify(input))).toEqual(input);
    expect(SecretReferenceSchema.parse(secret)).toEqual(secret);
    expect(
      ReleaseManifestSchema.safeParse({
        version: 1,
        ...binding,
        releaseId: "rel_aaaaaaaa",
        deploymentId: status.deploymentId,
        sourceDigest: source.digest,
        imageDigest: source.digest,
        scaffold: HOSTED_PROFILE.scaffold,
        nodeMajor: 24,
        capabilities,
        secretReferences: [secret],
      }).success,
    ).toBe(true);
    expect(DeploymentStatusSchema.safeParse(status).success).toBe(true);
    for (const command of [
      { operation: "status" },
      { operation: "disable", expectedGeneration: 0 },
      { operation: "delete", expectedGeneration: 0, confirmAppId: binding.appId },
      { operation: "rollback", expectedGeneration: 0, releaseId: "rel_aaaaaaaa" },
      { operation: "cancel", deploymentId: status.deploymentId, cancellationFence: 0 },
    ])
      expect(AppManagementSchema.safeParse({ version: 1, ...binding, ...command }).success).toBe(
        true,
      );
  });
  it.each([
    { workspaceId: undefined },
    { appId: undefined },
    { workspaceId: "app_aaaaaaaa" },
    { version: 2 },
    { source: { ...source, bytes: HOSTED_PROFILE.maxSourceBytes + 1 } },
    { source: { ...source, digest: "latest" } },
    { expectedGeneration: -1 },
    { expectedGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { idempotencyKey: "tiny" },
    { config: "process.env.SECRET" },
    { capabilities: { ...capabilities, workflows: true } },
    { secretReferences: [{ ...secret, workspaceId: "ws_bbbbbbbb" }] },
    { secretReferences: [{ ...secret, appId: "app_bbbbbbbb" }] },
    { secretReferences: [secret, secret] },
    { secretReferences: Array.from({ length: 33 }, (_, i) => ({ ...secret, name: `KEY_${i}` })) },
  ])("rejects invalid submission: %j", (change) => {
    expect(DeploymentSubmissionSchema.safeParse({ ...input, ...change }).success).toBe(false);
  });
  it("requires version and workspace binding across all versioned contracts", () => {
    const manifest = {
      version: 1,
      ...binding,
      releaseId: "rel_aaaaaaaa",
      deploymentId: status.deploymentId,
      sourceDigest: source.digest,
      imageDigest: source.digest,
      scaffold: HOSTED_PROFILE.scaffold,
      nodeMajor: 22,
      capabilities,
      secretReferences: [secret],
    };
    for (const [schema, value] of [
      [DeploymentSubmissionSchema, input],
      [DeploymentStatusSchema, status],
      [AppStatusSchema, appStatus],
      [AppListSchema, { version: 1, workspaceId: binding.workspaceId, apps: [appStatus] }],
      [SecretReferenceSchema, secret],
      [ReleaseManifestSchema, manifest],
      [AppManagementSchema, { version: 1, ...binding, operation: "status" }],
      [ScopedGrantSchema, { version: 1, ...binding, role: "deployer" }],
    ] as const) {
      expect(schema.safeParse({ ...value, version: 99 }).success).toBe(false);
      expect(schema.safeParse({ ...value, workspaceId: undefined }).success).toBe(false);
      expect(schema.safeParse({ ...value, rawSecret: "not-public" }).success).toBe(false);
    }
    expect(ReleaseManifestSchema.safeParse({ ...manifest, nodeMajor: 26 }).success).toBe(false);
    expect(ReleaseManifestSchema.safeParse({ ...manifest, scaffold: "latest" }).success).toBe(
      false,
    );
    expect(
      ReleaseManifestSchema.safeParse({
        ...manifest,
        secretReferences: [{ ...secret, value: "not-public" }],
      }).success,
    ).toBe(false);
  });
  it("bounds encoded input before JSON parsing and rejects malformed JSON", () => {
    expect(() => parseSubmissionJson(" ".repeat(HOSTED_PROFILE.maxSubmissionBytes + 1))).toThrow(
      "LIMIT_EXCEEDED",
    );
    expect(() => parseSubmissionJson("é".repeat(HOSTED_PROFILE.maxSubmissionBytes))).toThrow(
      "LIMIT_EXCEEDED",
    );
    expect(() => parseSubmissionJson("{")).toThrow();
  });
  it("rejects all excluded capabilities, unknown metadata, secret values and mismatched confirmations", () => {
    for (const key of [
      "workflows",
      "schedules",
      "subscriptions",
      "appToAppRpc",
      "persistentLocalState",
      "genui",
    ]) {
      expect(CapabilitiesSchema.safeParse({ ...capabilities, [key]: true }).success).toBe(false);
    }
    expect(SecretReferenceSchema.safeParse({ ...secret, value: "not-public" }).success).toBe(false);
    expect(
      AppManagementSchema.safeParse({
        version: 1,
        ...binding,
        operation: "delete",
        expectedGeneration: 0,
        confirmAppId: "app_bbbbbbbb",
      }).success,
    ).toBe(false);
    expect(
      PublicErrorSchema.safeParse({ code: "BUILD_FAILED", message: "raw provider secret" }).success,
    ).toBe(false);
    expect(PublicErrorSchema.parse(publicError("BUILD_FAILED"))).toEqual(
      publicError("BUILD_FAILED"),
    );
    expect(DeploymentStatusSchema.safeParse({ ...status, state: "active" }).success).toBe(false);
    expect(DeploymentStatusSchema.safeParse({ ...status, state: "failed" }).success).toBe(false);
    expect(
      DeploymentStatusSchema.safeParse({
        ...status,
        state: "failed",
        error: publicError("BUILD_FAILED"),
      }).success,
    ).toBe(true);
  });
  it("tests every state pair, all retry attempts and immutable terminal states", () => {
    const states = DeploymentStateSchema.options;
    const sequence = [
      "accepted",
      "validating",
      "building",
      "provisioning",
      "checking",
      "promoting",
      "active",
    ];
    for (const from of states)
      for (const to of states) {
        const terminal = ["active", "failed", "cancelled"].includes(from);
        const allowed =
          !terminal &&
          (sequence[sequence.indexOf(from) + 1] === to || to === "failed" || to === "cancelled");
        expect(
          DeploymentTransitionSchema.safeParse({
            version: 1,
            ...binding,
            deploymentId: status.deploymentId,
            from,
            to,
            attempt: 1,
            nextAttempt: 1,
          }).success,
        ).toBe(allowed);
      }
    for (const from of states)
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(
          DeploymentTransitionSchema.safeParse({
            version: 1,
            ...binding,
            deploymentId: status.deploymentId,
            from,
            to: from,
            attempt,
            nextAttempt: attempt + 1,
          }).success,
        ).toBe(!["accepted", "active", "failed", "cancelled"].includes(from) && attempt < 3);
      }
  });
  it("exposes current app generation and rejects unbound/duplicate summaries", () => {
    expect(
      AppStatusSchema.parse({ ...appStatus, generation: 3, activeReleaseId: "rel_aaaaaaaa" })
        .generation,
    ).toBe(3);
    expect(
      AppListSchema.safeParse({ version: 1, workspaceId: binding.workspaceId, apps: [appStatus] })
        .success,
    ).toBe(true);
    expect(
      AppListSchema.safeParse({ version: 1, workspaceId: "ws_bbbbbbbb", apps: [appStatus] })
        .success,
    ).toBe(false);
    expect(
      AppListSchema.safeParse({
        version: 1,
        workspaceId: binding.workspaceId,
        apps: [appStatus, appStatus],
      }).success,
    ).toBe(false);
    // M14: an optional namespace lets the CLI resolve `--app <name>`; it is not an identity.
    expect(AppStatusSchema.safeParse({ ...appStatus, name: "kanban" }).success).toBe(true);
    expect(AppStatusSchema.safeParse({ ...appStatus, name: "Kanban!" }).success).toBe(false);
  });
  it("deep-freezes shared policy arrays", () => {
    expect(Object.isFrozen(HOSTED_PROFILE)).toBe(true);
    expect(Object.isFrozen(HOSTED_PROFILE.nodeMajors)).toBe(true);
    expect(Object.isFrozen(HOSTED_PROFILE.retryDelaySeconds)).toBe(true);
  });
  it("fences cancellation, stale promotion, disabled apps and non-promoting states", () => {
    const job = { expectedGeneration: 2, lifecycleFence: 1, cancellationFence: 1 };
    const app = { generation: 2, lifecycleFence: 1, enabled: true };
    const deployment = { cancellationFence: 1, state: "promoting" as const };
    expect(canPromote(job, app, deployment)).toBe(true);
    expect(canPromote(job, { ...app, generation: 3 }, deployment)).toBe(false);
    expect(canPromote(job, { ...app, lifecycleFence: 2 }, deployment)).toBe(false);
    expect(canPromote(job, app, { ...deployment, cancellationFence: 2 })).toBe(false);
    expect(canPromote(job, { ...app, enabled: false }, deployment)).toBe(false);
    for (const state of DeploymentStateSchema.options.filter((state) => state !== "promoting"))
      expect(canPromote(job, app, { ...deployment, state })).toBe(false);
  });
  it("cancels only one of two deployments and fences activation/cancellation races", () => {
    const app = { generation: 2, lifecycleFence: 1, enabled: true };
    const job = { expectedGeneration: 2, lifecycleFence: 1, cancellationFence: 0 };
    const a = { state: "promoting" as const, cancellationFence: 0 };
    const b = { state: "promoting" as const, cancellationFence: 0 };
    expect(canCancel(job, a)).toBe(true);
    const cancelledA = { state: "cancelled" as const, cancellationFence: 1 };
    expect(canPromote(job, app, cancelledA)).toBe(false);
    expect(canPromote(job, app, b)).toBe(true);
    expect(canCancel(job, cancelledA)).toBe(false);
    expect(canCancel(job, { ...b, state: "active" })).toBe(false);
    expect(canCancel(job, { ...b, cancellationFence: 1 })).toBe(false);
    expect(canPromote(job, { ...app, generation: 3 }, b)).toBe(false);
    expect(canPromote(job, { ...app, lifecycleFence: 2 }, b)).toBe(false);
  });
});

describe("M02.c independent scoped call/deploy/admin grants", () => {
  const permissions: Permission[] = [
    "app:call",
    "app:read",
    "deployment:submit",
    "deployment:read",
    "deployment:cancel",
    "app:rollback",
    "app:disable",
    "app:delete",
    "secret:write",
    "secret:read",
  ];
  const matrix: Record<Role, boolean[]> = {
    "app-caller": [true, true, false, false, false, false, false, false, false, false],
    deployer: [false, true, true, true, true, true, false, false, false, false],
    operator: [false, true, true, true, true, true, true, true, true, false],
  };
  for (const role of Object.keys(matrix) as Role[]) {
    it(`checks all positive/negative permissions for ${role}`, () => {
      permissions.forEach((permission, i) => {
        expect(hasPermission({ role, ...binding }, binding, permission)).toBe(matrix[role][i]);
        expect(
          hasPermission(
            { role, ...binding },
            { ...binding, workspaceId: "ws_bbbbbbbb" },
            permission,
          ),
        ).toBe(false);
        expect(
          hasPermission({ role, ...binding }, { ...binding, appId: "app_bbbbbbbb" }, permission),
        ).toBe(false);
      });
    });
  }
  it("denies unknown roles even for prototype names", () => {
    expect(hasPermission({ role: "toString" as Role, ...binding }, binding, "app:call")).toBe(
      false,
    );
  });
});
