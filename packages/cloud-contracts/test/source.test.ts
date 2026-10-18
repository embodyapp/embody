import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  SOURCE_ADMISSION,
  SourceArchiveError,
  SourcePackError,
  SourceStatusSchema,
  SourceUploadRequestSchema,
  classifySourcePath,
  createSourceArchive,
  extractSourceArchive,
  inspectSourceArchive,
  packSource,
  rawTarEntry,
  sourceError,
  unsafeSourcePath,
} from "../src/index.js";

const text = (value: string) => new TextEncoder().encode(value);
const base = [
  { path: "package.json", content: text('{"name":"fixture"}') },
  { path: "embody.config.ts", content: text("export default {};\n") },
];
const tar = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const baseEntries = () => base.map((file) => rawTarEntry(file.path, file.content));
// Built at runtime so repository secret scanners do not flag the test itself.
const PRIVATE_KEY_HEADER = "-----BEGIN " + "PRIVATE KEY-----";
const CANARY = "EMBODY_CANARY_SECRET_7f3a91c2";

async function rejects(archive: Uint8Array, code: SourceArchiveError["code"]): Promise<void> {
  const error = await inspectSourceArchive(archive).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SourceArchiveError);
  expect((error as SourceArchiveError).code).toBe(code);
  // Public message is fixed and never echoes paths or content.
  expect((error as SourceArchiveError).message).toBe(sourceError(code).message);
}

const temporary: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "embody-m10-"));
  temporary.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("source path policy", () => {
  it.each([
    ["package.json", true],
    ["pnpm-lock.yaml", true],
    ["tsconfig.build.json", true],
    ["embody.config.ts", true],
    ["src/index.ts", true],
    ["src/api-token.ts", true],
    ["migrations/0001_init.sql", true],
    ["public/logo.svg", true],
    [".env", "env-file"],
    [".env.production", "env-file"],
    ["src/.env.local", "env-file"],
    [".git/config", "vcs"],
    [".npmrc", "dotfile"],
    ["src/.aws/credentials", "dotfile"],
    ["node_modules/x/index.js", "dependencies"],
    ["src/node_modules/x.js", "dependencies"],
    ["dist/index.js", "build-output"],
    ["coverage/lcov.info", "build-output"],
    ["src/local.db", "local-database"],
    ["src/dev.sqlite3", "local-database"],
    ["src/data.sqlite-wal", "local-database"],
    ["credentials.json", "credential"],
    ["src/service-account.json", "credential"],
    ["src/secrets.yaml", "credential"],
    ["src/server.key", "credential"],
    ["src/id_rsa", "credential"],
    ["terraform.tfstate", "credential"],
    ["docs/guide.md", "unsupported"],
    ["src/binary.exe", "unsupported"],
    ["Makefile", "unsupported"],
  ])("%s → %s", (path, expected) => {
    const decision = classifySourcePath(path);
    expect(decision.include ? true : decision.reason).toBe(expected);
  });

  it.each([
    ["../escape.ts", "traversal"],
    ["src/../../escape.ts", "traversal"],
    ["/etc/passwd", "absolute path"],
    ["src\\win.ts", "backslash"],
    ["C:/x.ts", "colon"],
    ["src/a\u0000b.ts", "control character"],
    ["src/e\u0301.ts", "non-NFC unicode"],
    ["src//a.ts", "empty segment"],
    ["src/a.ts.", "ambiguous segment"],
    [`src/${"a".repeat(260)}.ts`, "path too long"],
  ])("rejects unsafe path %j (%s)", (path, reason) => {
    expect(unsafeSourcePath(path)).toBe(reason);
  });
});

describe("embody-source-v1 archive inspection (M10.a)", () => {
  it("accepts a valid archive and binds a stable tree digest", async () => {
    const archive = createSourceArchive([
      ...base,
      { path: "src/index.ts", content: text("export {};\n") },
    ]);
    const summary = await inspectSourceArchive(archive);
    expect(summary).toMatchObject({ files: 3, bytes: archive.byteLength });
    expect(summary.treeDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const again = createSourceArchive([
      { path: "src/index.ts", content: text("export {};\n") },
      ...base,
    ]);
    expect(again.equals(archive)).toBe(true);
  });

  it.each([
    ["../escape.ts"],
    ["src/../../escape.ts"],
    ["/etc/passwd"],
    ["src\\..\\escape.ts"],
    ["src/ok/../../../x.ts"],
  ])("rejects traversal entry %j before any write", async (path) => {
    await rejects(tar(...baseEntries(), rawTarEntry(path, text("x"))), "UNSAFE_ENTRY");
  });

  it("rejects symbolic links, hard links and special files", async () => {
    await rejects(
      tar(...baseEntries(), rawTarEntry("src/link.ts", text(""), { type: "2", linkname: "/etc" })),
      "UNSAFE_ENTRY",
    );
    await rejects(
      tar(
        ...baseEntries(),
        rawTarEntry("src/hard.ts", text(""), { type: "1", linkname: "package.json" }),
      ),
      "UNSAFE_ENTRY",
    );
    for (const type of ["3", "4", "6"])
      await rejects(
        tar(...baseEntries(), rawTarEntry("src/dev", text(""), { type })),
        "UNSAFE_ENTRY",
      );
    await rejects(
      tar(...baseEntries(), rawTarEntry("src/x.ts", text("x"), { linkname: "../../etc" })),
      "UNSAFE_ENTRY",
    );
  });

  it("rejects a symlink-escape followed by a write through it", async () => {
    const dest = join(await tempDir(), "out");
    const archive = tar(
      ...baseEntries(),
      rawTarEntry("src/escape", text(""), { type: "2", linkname: "../../.." }),
      rawTarEntry("src/escape/pwned.ts", text("owned")),
    );
    await expect(extractSourceArchive(archive, dest)).rejects.toMatchObject({
      code: "UNSAFE_ENTRY",
    });
    await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate, case-colliding and file/directory conflicting paths", async () => {
    const one = text("1");
    await rejects(
      tar(...baseEntries(), rawTarEntry("src/a.ts", one), rawTarEntry("src/a.ts", one)),
      "UNSAFE_ENTRY",
    );
    await rejects(
      tar(...baseEntries(), rawTarEntry("src/A.ts", one), rawTarEntry("src/a.ts", one)),
      "UNSAFE_ENTRY",
    );
    await rejects(
      tar(...baseEntries(), rawTarEntry("src/a.ts", one), rawTarEntry("src/a.ts/b.ts", one)),
      "UNSAFE_ENTRY",
    );
  });

  it("rejects archive bombs by compression ratio before expanding them", async () => {
    // 40 MiB of zeros is within the 50 MiB expanded limit but compresses ~1000:1.
    const bomb = createSourceArchive([
      ...base,
      { path: "src/zeros.txt", content: new Uint8Array(40 * 1024 * 1024) },
    ]);
    expect(bomb.byteLength).toBeLessThan(SOURCE_ADMISSION.maxSourceBytes);
    await rejects(bomb, "ARCHIVE_LIMIT");
  });

  it("rejects declared expanded size, file count and compressed size over limits", async () => {
    const header = Buffer.from(rawTarEntry("src/huge.txt", text("")).subarray(0, 512));
    header.write(`${(60 * 1024 * 1024).toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("        ", 148, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    await rejects(tar(...baseEntries(), header), "ARCHIVE_LIMIT");

    const many = Array.from({ length: SOURCE_ADMISSION.maxSourceFiles + 1 }, (_, index) => ({
      path: `src/f${index}.ts`,
      content: text(`export const v${index} = ${index};\n`),
    }));
    await rejects(createSourceArchive([...base, ...many]), "ARCHIVE_LIMIT");
    await rejects(new Uint8Array(SOURCE_ADMISSION.maxSourceBytes + 1), "ARCHIVE_LIMIT");
  });

  it("rejects malformed, truncated, trailing-data, non-ustar and extended-header archives", async () => {
    const good = createSourceArchive(base);
    await rejects(text("not gzip at all, just text bytes"), "ARCHIVE_INVALID");
    await rejects(good.subarray(0, good.length - 12), "ARCHIVE_INVALID");
    await rejects(gzipSync(gunzipSync(good).subarray(0, 700)), "ARCHIVE_INVALID");
    await rejects(
      gzipSync(Buffer.concat([gunzipSync(good), text("trailing!")])),
      "ARCHIVE_INVALID",
    );
    const corrupt = Buffer.from(gunzipSync(good));
    corrupt[10] = corrupt[10]! ^ 0xff;
    await rejects(gzipSync(corrupt), "ARCHIVE_INVALID");
    await rejects(
      tar(rawTarEntry("package.json", text("{}"), { magic: "ustar " })),
      "ARCHIVE_INVALID",
    );
    await rejects(
      tar(...baseEntries(), rawTarEntry("pax", text("30 path=../../escape\n"), { type: "x" })),
      "ARCHIVE_INVALID",
    );
    await rejects(
      tar(...baseEntries(), rawTarEntry("src/s.ts", text("x"), { mode: 0o4755 })),
      "UNSAFE_ENTRY",
    );
    await rejects(tar(rawTarEntry("src/index.ts", text("x"))), "ARCHIVE_INVALID");
    await rejects(gzipSync(Buffer.alloc(1024)), "ARCHIVE_INVALID");
  });

  it("rejects excluded, unsupported and secret-bearing files in hand-built archives", async () => {
    for (const path of [
      ".env",
      "src/.env.local",
      ".git/config",
      "node_modules/a/index.js",
      "credentials.json",
      "src/local.db",
      "dist/index.js",
    ])
      await rejects(tar(...baseEntries(), rawTarEntry(path, text(CANARY))), "FORBIDDEN_FILE");
    await rejects(
      tar(...baseEntries(), rawTarEntry("docs/readme.md", text("x"))),
      "ARCHIVE_INVALID",
    );
    await rejects(
      tar(
        ...baseEntries(),
        rawTarEntry("src/config.ts", text(`const k = \`${PRIVATE_KEY_HEADER}\nabc\`;`)),
      ),
      "FORBIDDEN_FILE",
    );
    const error = await inspectSourceArchive(
      tar(...baseEntries(), rawTarEntry(".env", text(CANARY))),
    ).catch((caught: SourceArchiveError) => caught);
    expect(JSON.stringify({ message: (error as Error).message })).not.toContain(CANARY);
  });

  it("extracts only after full validation, with exclusive no-follow creates", async () => {
    const root = await tempDir();
    const archive = createSourceArchive([
      ...base,
      { path: "src/bin/run.js", content: text("#!/usr/bin/env node\n"), executable: true },
    ]);
    const summary = await extractSourceArchive(archive, join(root, "out"));
    expect(summary.files).toBe(3);
    expect(await readFile(join(root, "out", "package.json"), "utf8")).toBe('{"name":"fixture"}');
    expect((await stat(join(root, "out", "src/bin/run.js"))).mode & 0o777).toBe(0o755);
    await expect(extractSourceArchive(archive, join(root, "out"))).rejects.toMatchObject({
      code: "EEXIST",
    });
    const bad = tar(
      ...baseEntries(),
      rawTarEntry("src/ok.ts", text("x")),
      rawTarEntry("../x", text("x")),
    );
    await expect(extractSourceArchive(bad, join(root, "bad"))).rejects.toBeInstanceOf(
      SourceArchiveError,
    );
    await expect(stat(join(root, "bad"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("source packaging (M10.b)", () => {
  async function fixture(): Promise<string> {
    const root = await tempDir();
    const files: Record<string, string> = {
      "package.json": '{"name":"fixture","type":"module"}',
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "tsconfig.json": "{}",
      "embody.config.ts": "export default {};\n",
      "README.md": "# fixture\n",
      "src/index.ts": "export const ok = true;\n",
      "src/api-token.ts": "export const header = 'authorization';\n",
      "migrations/0001.sql": "select 1;\n",
      ".env": `SECRET=${CANARY}`,
      ".env.local": `SECRET=${CANARY}`,
      "src/.env.test": `SECRET=${CANARY}`,
      ".npmrc": `//registry.npmjs.org/:_authToken=${CANARY}`,
      "credentials.json": `{"key":"${CANARY}"}`,
      "src/service-account.json": `{"private":"${CANARY}"}`,
      id_rsa: CANARY,
      "src/server.key": CANARY,
      "local.db": CANARY,
      "src/dev.sqlite": CANARY,
      "src/dev.sqlite-wal": CANARY,
      ".git/config": CANARY,
      "node_modules/pkg/index.js": CANARY,
      "dist/index.js": CANARY,
      "build/out.js": CANARY,
      "coverage/lcov.info": CANARY,
      "docs/notes.md": CANARY,
      ".DS_Store": CANARY,
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await symlink(join(root, ".env"), join(root, "src", "linked-env.ts"));
    await symlink("..", join(root, "src", "parent"));
    return root;
  }

  it("excludes secrets, local DBs, VCS, dependencies and build outputs; output is deterministic", async () => {
    const root = await fixture();
    const packed = await packSource(root);
    expect(packed.files).toEqual([
      "README.md",
      "embody.config.ts",
      "migrations/0001.sql",
      "package.json",
      "pnpm-lock.yaml",
      "src/api-token.ts",
      "src/index.ts",
      "tsconfig.json",
    ]);
    expect(gunzipSync(packed.archive).includes(Buffer.from(CANARY))).toBe(false);
    const reasons = Object.fromEntries(packed.excluded.map((e) => [e.path, e.reason]));
    expect(reasons).toMatchObject({
      ".env": "env-file",
      ".env.local": "env-file",
      "src/.env.test": "env-file",
      ".npmrc": "dotfile",
      "credentials.json": "credential",
      "src/service-account.json": "credential",
      id_rsa: "credential",
      "src/server.key": "credential",
      "local.db": "local-database",
      "src/dev.sqlite": "local-database",
      "src/dev.sqlite-wal": "local-database",
      ".git/": "vcs",
      "node_modules/": "dependencies",
      "dist/": "build-output",
      "build/": "build-output",
      "coverage/": "build-output",
      "docs/": "unsupported",
      "src/linked-env.ts": "symlink",
      "src/parent": "symlink",
    });
    // Exclusion reports carry paths only, never file contents.
    expect(JSON.stringify(packed.excluded)).not.toContain(CANARY);
    expect((await packSource(root)).digest).toBe(packed.digest);
    const summary = await inspectSourceArchive(packed.archive);
    expect(summary.digest).toBe(packed.digest);
  });

  it("fails locally on private keys, missing required files and unsafe names without echoing content", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "src", "key.ts"),
      `export const k = \`${PRIVATE_KEY_HEADER}\n${CANARY}\`;`,
    );
    const error = await packSource(root).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourcePackError);
    expect((error as Error).message).toContain("src/key.ts");
    expect((error as Error).message).not.toContain(CANARY);
    await rm(join(root, "src", "key.ts"));
    await writeFile(join(root, "src", "bad:name.ts"), "x");
    await expect(packSource(root)).rejects.toThrow(/colon/);
    await rm(join(root, "src", "bad:name.ts"));
    await rm(join(root, "embody.config.ts"));
    await expect(packSource(root)).rejects.toThrow(/embody.config/);
  });
});

describe("source admission schemas", () => {
  it("binds upload requests and statuses strictly", () => {
    const request = {
      version: 1,
      workspaceId: "ws_aaaaaaaa",
      appId: "app_aaaaaaaa",
      idempotencyKey: "sha256_0123456789abcdef",
      format: "embody-source-v1",
      digest: `sha256:${"a".repeat(64)}`,
      bytes: 10,
    };
    expect(SourceUploadRequestSchema.parse(request)).toEqual(request);
    expect(
      SourceUploadRequestSchema.safeParse({
        ...request,
        bytes: SOURCE_ADMISSION.maxSourceBytes + 1,
      }).success,
    ).toBe(false);
    expect(SourceUploadRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false);
    const status = {
      version: 1,
      workspaceId: request.workspaceId,
      appId: request.appId,
      uploadId: "src_aaaaaaaa",
      state: "rejected",
      digest: request.digest,
      bytes: 10,
      attempt: 1,
      createdAt: new Date(0).toISOString(),
      retainUntil: new Date(0).toISOString(),
      error: sourceError("DIGEST_MISMATCH"),
    };
    expect(SourceStatusSchema.safeParse(status).success).toBe(true);
    expect(
      SourceStatusSchema.safeParse({ ...status, error: { code: "DIGEST_MISMATCH", message: "x" } })
        .success,
    ).toBe(false);
    expect(SourceStatusSchema.safeParse({ ...status, state: "verified" }).success).toBe(false);
  });
});
