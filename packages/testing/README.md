# `@embody/testing`

`createTestHarness` boots the public `Kernel`, SQLite adapter, execution path, and deterministic outbox worker. Always call `await harness.close()` (normally in `afterEach`) to remove its isolated temporary database.

## Startup benchmark

Warm-start performance is measured outside assertions to avoid flaky tests: run a representative harness creation/close loop after one untimed warmup, collect at least 100 samples with `process.hrtime.bigint()`, and report median and p95 on the supported Node/SQLite versions. The target is p95 below 10 ms; record hardware, Node version, plugin fixture, sample count, median, and p95 with release evidence.

Latest local baseline (2026-09-03): 100 samples after one warmup on Node v24.12.0/x86_64; median **5.72 ms**, p95 **7.32 ms**. Run `pnpm --filter @embody/testing benchmark` to reproduce.
