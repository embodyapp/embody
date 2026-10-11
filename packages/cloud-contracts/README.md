# @embody/cloud-contracts

Strict version-1 schemas and policy for the request-only hosted MVP. Exports IDs,
capabilities, deployment submissions/status/transitions, release manifests, secret
references, scoped grants, app-management commands, canonical submission
fingerprints, permission checks and promotion-fence predicates.

```ts
import { parseSubmissionJson, submissionFingerprint } from "@embody/cloud-contracts";

const request = parseSubmissionJson(boundedJsonBody);
const fingerprint = submissionFingerprint(request);
```

`boundedJsonBody` must already be constrained at the HTTP streaming boundary.
Schema errors are internal diagnostics; public responses use `publicError(code)`.
Customer configuration is never evaluated here. References are not secret values.

This package does **not** implement hosted routes, CLI deployment, durable storage,
workers, provider isolation or runtime limit enforcement. `SubmissionRepository`
defines the M12 store contract; the test fixture is not a production adapter.
`canPromote` must be evaluated inside an atomic CAS/transaction, never as an
independent security check. Consumers authenticate route and workspace binding
before applying the app-scoped permission matrix.

Full [API/CLI contract and workload/limits](../../docs/mvp/CONTRACTS.md).

```sh
pnpm --filter @embody/cloud-contracts test
pnpm --filter @embody/cloud-contracts typecheck
pnpm --filter @embody/cloud-contracts build
```
