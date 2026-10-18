---
"@embody/cloud-contracts": minor
"@embody/gateway": minor
"@embody/cli": minor
---

Add authenticated source admission (M10). `@embody/cloud-contracts` defines the deterministic `embody-source-v1` archive (gzip + POSIX ustar, files and directories only), the explicit packaging policy, streaming inspection with file/size/path/link/compression-ratio limits, safe extraction, and the source upload/status schemas with fixed public errors. `@embody/gateway` serves `/v1/workspaces/:workspace/apps/:app/sources` on workspace gateways (deployment grant and durable quota/audit before any upload capacity, bounded create-only upload access, digest/size verification, persisted source identity and retention), with `MemorySourceObjectStore` and `GcsSourceObjectStore`. `@embody/cli` adds `embody source pack` and `embody source upload`; neither deploys nor builds.
