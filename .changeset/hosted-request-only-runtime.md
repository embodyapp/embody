---
"@embody/core": minor
"@embody/host": minor
"create-embody-app": minor
---

Add an explicit request-only kernel and hosted runtime with read-only PostgreSQL boot, unsupported-feature preflight, no registration or background workers, bounded cooperative cancellation and database pools. Generated CRUD notifications have documented zero retention while entity writes and synchronous hooks remain transactional; custom event publishing fails. Add a guarded `--request-only` scaffold with a CRUD entity, real PostgreSQL/process-replacement tests and a mandatory packed-scaffold gate. Reference/self-hosted mode remains supported. This does not qualify provider scale-to-zero, arbitrary customer-code isolation or production release readiness.
