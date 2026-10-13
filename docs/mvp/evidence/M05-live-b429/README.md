# M05 provider acceptance — 2026-10-13

**Frozen code/provider candidate:** `b429a0a5ae05ce4239f4b0bee13f9f843d83e530`.
[Exact CI 38387594777](https://github.com/embodyapp/embody/actions/runs/38387594777): all nine checks passed on Node 22/24. Evidence-only documentation may be committed later; it does not replace this code/image candidate.

Approved dedicated fixture: `embody-cloud`, `us-central1`, `embody-test-m05`, invented data only, target $0 / authorized maximum $10. Approval is not a spending cap. Cloud SQL and NAT were intentionally short-lived. No credentials, private keys, passwords, tokens or DSNs are included here.

## Source / image provenance

Build input was `git archive b429a0a5ae05ce4239f4b0bee13f9f843d83e530`, extracted into `/tmp/embody-m05-build24`, not the working tree. `Dockerfile.m05` built linux/amd64 with that source argument; deploy checks the OCI revision label. The immutable root image is:

`us-central1-docker.pkg.dev/embody-cloud/embody-test-m05-images/fixture@sha256:09b29ab7b5c15adbf90ef7cc6377fdbd52c6965538d9936086a5af901f106f10`

Cloud Run serving revisions resolve to the linux/amd64 leaf:

`sha256:dc38bd42de9398b5ad2ccc230f7f8a9461c4887fd6bc2826f566691b4b6028f4`

[`image-index.oci`](./image-index.oci) is the raw registry JSON index mapping the two digests. Its exact file SHA256 is `09b29ab7b5c15adbf90ef7cc6377fdbd52c6965538d9936086a5af901f106f10`, independently matching the root digest; `.oci` preserves raw bytes rather than formatter rewriting. Job/root and serving/leaf differences are intentional, not mixed candidate code. Before/after provider revision inventories bind all traffic-serving/tagged revisions to these digests. **Provenance is operator-attested**, not a reproducible or cryptographically attested supply-chain qualification; base images remain tag-pinned. No restricted deployer/durable controller qualification is claimed.

## Accepted technical gates

| Evidence | Result |
| --- | --- |
| `runtime-a-b429.json`, `runtime-b-b429.json` | 16 checks each, attached distinct runtime metadata identities; own secret/SQL positive controls; foreign/platform/signing-secret access, mutation, deployment/build, impersonation/signing/actAs and non-gateway app invocation denied; own restricted SQL and foreign/platform CONNECT42501 |
| `gateway-b429-initial.json` | 19 checks; actual gateway workload invocation of both apps; missing/wrong provider identity denied; workspace/app/scalar audience/lifetime/signature/delegation/replay negatives; successful attributed HTTP, terminal SSE and parsed delegated MCP |
| `gateway-b429-publish.json` | Current principal and HTTP/SSE/MCP round trips with old signer and published overlap configuration |
| `gateway-b429-overlap.json` | HTTP/SSE/MCP through root and both 50/50 tagged revisions; old and new keys accepted; **one MCP client made eight successful tool calls across both actual gateway revisions** (`00037-rvs`, `00038-fgx`) |
| `gateway-b429-watch-reconciled.json` | Attached gateway job execution completed successfully; old key positively observed in authoritative JWKS before removal; fresh old-key tokens denied on both apps within **2509 ms**, conservatively timed from the LAST observed old-key publication (before removal); new-key200 on the same two app nonces/revisions |
| `gateway-b429-removed.json` | Current key accepted and freshly minted retired-key token rejected; root/both tagged revision HTTP/SSE/MCP round trips; deployed JWKS readback only key2 |
| `gateway-b429-external.json` | Dedicated job readback confirms **no VPC**; both exact ready app origins return404 externally, without provider identity and with real gateway metadata provider identity plus valid principal |
| `provider-b429.json` | Actual ingress/invoker/IAM/instance inventory; instance-conditioned SQL client IAM; six restricted role flags; actual maintenance/foreign diagnostics FATAL42501; **21 credentials revoked, zero not revoked** |
| `retired-signer-b429.json` | Old signing version destroyed after removed/external acceptance |

Reports require completed execution, exact stdout execution label, source SHA, candidate SHA, configuration digest, expected phase, every required check, metadata identity and inventoried origins. Workload jobs, not Owner impersonation, supply runtime/invocation acceptance. Operator SQL catalog and postgres/template1/platform-role CONNECT diagnostics are explicitly supplemental and use actual restricted SQL login roles.

### Transparent watcher reconciliation

The original watcher CLI validated its successful execution/report bindings, then hit `Serving fixture not ready/private` while the **second gateway removal revision was still reconciling**. It did not emit an accepted envelope. The reconciled record reads the **same successful execution and stdout report**, adds the execution template's attached gateway service account, and reads the ready/current-image inventory after the removed deployment completed. It is not a rerun, impersonation or a backdated snapshot. The independent technical reviewer accepted this interpretation; the later inventory is explicitly later than the watch.

## Independent review and qualifications

[`independent-technical-review.md`](./independent-technical-review.md) independently accepted the technical gates with no concrete security/false-green blocker, contingent on cleanup. Earlier reviews found and caused fixes to terminal-result parsing, real revision/image provenance, restricted schema startup, rotation sequencing and process-local MCP sessions.

Important limits:

- The publish-phase public JWKS was **not separately HTTP-read back at publish time**. Ordered source/configuration and observed later overlap, plus enforced60s publication /300s signer-drain waits, qualify this acceptance; this is an availability observation gap, not proof of a zero-downtime rolling controller. Tagged overlap/removal JWKS are read back.
- The watcher proves observed end-to-end revocation on stable recorded app instances, not every possible cache instance or a mechanistic proof that cache expiry caused denial. Removal observation uses root JWKS; the later removed probe and destroyed old secret provide follow-up, but the watch itself stops at first all401.
- `template0` and provider-managed `cloudsqladmin` catalog CONNECT entries are not claimed as demonstrated42501 denials. Actual runtime postgres/template1 and platform-role app database denials are demonstrated. Public SQL IP has no authorized networks; connector identity and encrypted transport are required.
- Gateway MCP is stateless per authenticated request to survive replica/revision routing. Adapter stateful default remains pinned to identity/endpoint. Stateless GET/DELETE return405 (no idle SSE stream), pre-dispatch disconnect does not execute/leak, and HTTP transport disconnect cancels request-owned execution. **Cross-request cancellation notifications cannot reliably target another replica**; clients must close the active HTTP transport for reliable cancellation. Broader M06 supported-client/idle behavior is still a separate task.
- Some native SQL startup attempts timed out and were retried, rather than accepted as SQL denials. Intermediate failed candidates/reviews are not acceptance evidence. Fixture authorities used temporary minimum instances during rotation; teardown removes them.
- M09 production database/region/backup/latency and M13 controller/provision/migrate/promote qualifications remain open.

## Cost and cleanup

[`cost-b429.json`](./cost-b429.json) measures provider allocation lifetimes and50 job executions, then conservatively assumes full active CPU+1GiB over each service lifetime, all job creation-to-completion time, a six-hour second-gateway allowance and $1 storage/network contingency. Estimated upper envelope at capture is **$7.33**, below the approved $10. This is **not a measured Cloud Billing invoice** or a cap: the final invoice can lag and must be checked separately. SQL existed about16.69h at capture; backups/HA/autogrowth/authorized networks were disabled. Target $0 was not met.

Cleanup/control and app adapter removal records are included. Final cleanup inventory and independent cleanup review must verify services/jobs, SQL, NAT/router/subnet/network/private DNS, app identities/secrets, enabled foundation secret versions, fixture images and the instance-conditioned IAM grants are gone. Shared empty Terraform foundation and private versioned GCS backend are retained. Direct VPC serverless internal address reservations delay subnet deletion after workloads disappear. [Google documents a **1–2 hour release wait** and that these reservations cannot be manually deleted](https://cloud.google.com/run/docs/configuring/vpc-direct-vpc#delete-subnet). Control-plane workloads were deleted by12:00 UTC; the bounded reconciliation retries only subnet/network teardown while those free internal leases expire. No paid SQL/NAT/workload is kept alive for that wait. M05 must remain IN_REVIEW until the final empty optional-resource inventory is actually verified.
