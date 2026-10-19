import { describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@embody/core";
import {
  MAX_TASK_TOKEN_BYTES,
  MemoryTaskQueue,
  MemoryWakeQueue,
  authenticateTask,
  cloudTasksQueue,
  cloudTasksWakeQueue,
  deterministicTaskName,
} from "../src/index.js";

const options = {
  queue: "projects/embody-test/locations/us-central1/queues/embody-test-deploy",
  url: "https://deploy-worker.example.run.app/_embody/tasks/deployment",
  audience: "https://deploy-worker.example.run.app/_embody/tasks/deployment",
  invokerEmail: "embody-test-deploy-invoker@embody-test.iam.gserviceaccount.com",
  accessToken: () => Promise.resolve("token"),
};

describe("M12 step 6: shared queue adapter and task ingress", () => {
  it("creates one Cloud Tasks HTTP task with the platform's fixed target and invoker", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}", { status: 200 })));
    const queue = cloudTasksQueue<{ v: number }>({ ...options, fetch: fetcher });
    await expect(
      queue.enqueue({ name: "dep-abc", scheduleAt: "2030-01-01T00:00:00.000Z", body: { v: 1 } }),
    ).resolves.toBe("created");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://cloudtasks.googleapis.com/v2/${options.queue}/tasks`);
    const sent = JSON.parse(init!.body as string) as {
      task: {
        name: string;
        httpRequest: { url: string; body: string; oidcToken: Record<string, string> };
      };
    };
    expect(sent.task.name).toBe(`${options.queue}/tasks/dep-abc`);
    expect(sent.task.httpRequest.url).toBe(options.url);
    expect(sent.task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: options.invokerEmail,
      audience: options.audience,
    });
    expect(JSON.parse(Buffer.from(sent.task.httpRequest.body, "base64").toString())).toEqual({
      v: 1,
    });
    expect(init!.redirect).toBe("error");
    fetcher.mockResolvedValueOnce(new Response("", { status: 409 }));
    await expect(
      queue.enqueue({ name: "dep-abc", scheduleAt: "2030-01-01T00:00:00.000Z", body: { v: 1 } }),
    ).resolves.toBe("duplicate");
    fetcher.mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(
      queue.enqueue({ name: "dep-abd", scheduleAt: "2030-01-01T00:00:00.000Z", body: { v: 1 } }),
    ).rejects.toThrow(/503/);
    for (const bad of [
      { name: "dep/../x", scheduleAt: "2030-01-01T00:00:00.000Z", body: {} },
      { name: "dep-ok", scheduleAt: "not a time", body: {} },
    ])
      await expect(queue.enqueue(bad as never)).rejects.toThrow(/Invalid task/);
  });

  it("refuses non-HTTPS targets, foreign queue paths and malformed invokers", () => {
    for (const bad of [
      { url: "http://worker.example" },
      { audience: "http://worker.example" },
      { queue: "projects/x/queues/y" },
      { invokerEmail: "not an email" },
    ])
      expect(() => cloudTasksQueue({ ...options, ...bad })).toThrow(TypeError);
    // The M20 wake adapter is the same adapter.
    expect(() => cloudTasksWakeQueue({ ...options, url: "http://x" })).toThrow(TypeError);
  });

  it("names tasks deterministically and keeps queue name semantics in memory", async () => {
    expect(deterministicTaskName("dep", "a", 1)).toBe(deterministicTaskName("dep", "a", 1));
    expect(deterministicTaskName("dep", "a", 1)).not.toBe(deterministicTaskName("dep", "a", 2));
    expect(deterministicTaskName("dep", "a", 1)).toMatch(/^dep-[a-f0-9]{40}$/);
    expect(() => deterministicTaskName("Bad Kind")).toThrow(TypeError);
    const queue = new MemoryTaskQueue<number>();
    const task = { name: "a", scheduleAt: "2030-01-01T00:00:00.000Z", body: 1 };
    expect(await queue.enqueue(task)).toBe("created");
    expect(await queue.enqueue(task)).toBe("duplicate");
    expect(queue.due(new Date("2029-12-31T00:00:00.000Z"))).toEqual([]);
    expect(queue.due(new Date("2030-01-02T00:00:00.000Z"))).toEqual([task]);
    queue.lose("a");
    expect(queue.pending()).toEqual([]);
    queue.outage = true;
    await expect(queue.enqueue({ ...task, name: "b" })).rejects.toThrow(/unavailable/);
    expect(new MemoryWakeQueue()).toBeInstanceOf(MemoryTaskQueue);
  });

  it("authenticates only a single bounded Bearer token through the platform invoker verifier", async () => {
    const verify = vi.fn((token: string) =>
      token === "good.token.sig"
        ? Promise.resolve()
        : Promise.reject(new UnauthenticatedError("bad")),
    );
    const verifier = { id: "test", verify };
    await expect(
      authenticateTask({ authorization: "Bearer good.token.sig" }, verifier),
    ).resolves.toBeUndefined();
    for (const headers of [
      {},
      { authorization: ["Bearer good.token.sig", "Bearer good.token.sig"] },
      { authorization: "Basic good.token.sig" },
      { authorization: "Bearer good token" },
      { authorization: `Bearer ${"a".repeat(MAX_TASK_TOKEN_BYTES + 1)}` },
      { "x-gateway-auth": "Bearer good.token.sig" },
      { authorization: "Bearer other.token.sig" },
    ])
      await expect(authenticateTask(headers, verifier)).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
