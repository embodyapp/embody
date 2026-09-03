import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/index.js";

const cleanup: string[] = [];
afterEach(async () =>
  Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

it("generates the documented safe starter layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "embody-scaffold-"));
  cleanup.push(root);
  const app = await createApp({
    name: "my-agent",
    destination: join(root, "my-agent"),
    noInstall: true,
  });
  expect(app.files).toContain("embody.config.ts");
  expect(await readFile(join(app.directory, "Dockerfile"), "utf8")).toContain("HEALTHCHECK");
  expect(await readFile(join(app.directory, "package.json"), "utf8")).not.toContain("secret");
});

it("rejects traversal and preserves nonempty destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "embody-scaffold-"));
  cleanup.push(root);
  await expect(createApp({ name: "../bad", destination: root })).rejects.toThrow(/Project name/);
  const destination = join(root, "existing");
  await mkdir(destination);
  await writeFile(join(destination, "keep"), "keep");
  await expect(createApp({ name: "good", destination })).rejects.toThrow(/Destination/);
  expect(await readFile(join(destination, "keep"), "utf8")).toBe("keep");
});
