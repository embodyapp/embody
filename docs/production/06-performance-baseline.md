# Performance baseline and release budgets

Performance claims are valid only with the raw result artifact, commit, hardware, Node/database versions, fixture seed, concurrency, warm-up, and command recorded. The representative fixture is 100 app manifests × 50 tools, 10,000 tenant entities, and 100,000 queued events. Tests measure kernel/harness warm boot median/p95, catalog build and payload, SQLite and PostgreSQL CRUD/dispatch latency and throughput, outbox/workflow drain and retry overhead, MCP tool-list latency, and RSS after concurrent SSE clients disconnect.

The current measured evidence is limited to the Phase 9 warm harness sample on Node 24 x86_64: median 5.72 ms, p95 7.32 ms over 100 warm samples. This is not an enterprise-scale claim. Run `node packages/testing/benchmark.mjs` to reproduce that sample.

Performance automation and release budgets are intentionally deferred. No performance checks run in CI. Before a public release, collect representative results manually, review them, and decide whether any thresholds should become release gates. Until then, no performance or enterprise-scale claim should be made.
