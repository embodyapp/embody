import { afterEach, expect, it, vi } from "vitest";
import { drain } from "../src/drain.js";
afterEach(() => vi.useRealTimers());
it("releases the stop deadline after an already drained worker", async () => {
  vi.useFakeTimers();
  await drain([], 30_000);
  expect(vi.getTimerCount()).toBe(0);
  await drain([Promise.resolve(), Promise.reject(new Error("completed failure"))], 30_000);
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds an unfinished worker drain and releases its timer", async () => {
  vi.useFakeTimers();
  const stopped = drain([new Promise(() => {})], 100);
  await vi.advanceTimersByTimeAsync(100);
  await stopped;
  expect(vi.getTimerCount()).toBe(0);
});
