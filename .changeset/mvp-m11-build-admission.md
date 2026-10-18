---
"@embody/cloud-contracts": minor
"@embody/gateway": minor
"@embody/host": minor
---

Add isolated build and immutable artifact admission (M11). `@embody/cloud-contracts` adds the pinned `embody-node24-pnpm-v1` build recipe, the trusted `package.json`/`pnpm-lock.yaml` policy (registry-only sha512 resolutions, platform-bundled framework packages), a lockfile CycloneDX SBOM, the vulnerability policy, build-log redaction, the untrusted build output and trusted artifact manifest schemas (profile, published events, subscriptions, versioned workflows) and the `durable-v1` deployment capabilities. `@embody/gateway` adds the Cloud Build plan (customer code only in a no-network, unprivileged, bounded sandbox), `decideAdmission` (provenance, trusted step outputs, digest-bound image, manifest and SBOM), `BuildAdmission` orchestration, artifact records in the memory and PostgreSQL stores, retention and orphan cleanup, the `CloudBuildProvider` and `MemoryBuildProvider` adapters, and builder read access (`createReadAccess`, separate read signer) on the source stores. `@embody/host` adds the optional `publishes` declaration on `defineApp`.
