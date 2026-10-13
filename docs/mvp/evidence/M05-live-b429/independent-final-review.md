I found no technical or cleanup blocker. M05 can be marked DONE with the residuals below, once two bookkeeping steps are finished. M06 contract, M09 production, the billing invoice and controller-qualified release stay OPEN as you described.

I ran nothing and read no private or cloud data. Everything below comes from the 11 public evidence files in `docs/mvp/evidence/M05-live-b429/` and `infra/mvp/m05/main.tf`. I had no plan-file write tool in this session, so this review is the deliverable.

## Bookkeeping to finish before DONE

1. **The final evidence isn't committed.** According to the session-start git status, `cleanup-inventory-b429.json` and `cost-b429.json` are modified and `terraform-final.json` is untracked. So ae8c200, whose CI run 38403278956 is still running, doesn't contain the final cleanup evidence. Commit these files, then wait for that commit's CI to pass. ae8c200's CI doesn't cover them.
2. **The README is out of date.** It still says "M05 must remain IN_REVIEW until the final empty optional-resource inventory is actually verified" (README.md:57), and it only gives the $7.33 figure.
   - It doesn't record any of these:
     - the final empty inventory at 13:15:45Z
     - the subnet deletion failing on serverless address reservations, then the retry succeeding at about 13:14
     - the Artifact Registry bulk package delete failing on child-manifest references, then deleting the indexes and leaves one by one
     - the $0.18 allowance and the $7.51 total
     - `terraform-final.json` itself
   - None of these events appear in any public JSON either. Right now they rest only on what you've told me, so the README needs to add them.
   - It should also say that billing tracking ends at the $10 approval limit, which is not a spending cap. The $0 target was not met.

## Checks of the new evidence

- **Raw OCI index.**
  - **Hash:** I couldn't run `shasum`, so I haven't checked that the file's bytes hash to `09b29…`. That still needs one command from anyone with a shell.
  - **Contents:** the file is consistent:
    - it ends with no trailing newline, as raw bytes should;
    - its linux/amd64 entry is `dc38bd…` with size 2008;
    - its second entry, `fb739b…`, is an unsigned buildx attestation manifest of type `attestation-manifest`, platform unknown/unknown.
  - **Wording:** the README's "not … cryptographically attested" is still accurate. Mentioning that the index includes an unsigned provenance manifest would be more precise.
- **Watch identity.** `gateway-b429-watch-reconciled.json:146` now has `serviceAccount: embody-test-m05-gateway@…`. That closes the gap from the earlier review. The execution `5vbzq` is consistent:
  - it appears in `cost-b429.json`;
  - it completed at 11:32:41, after the report timestamp of 11:32:38;
  - 38.338 − 35.829 = 2509 ms.
- **Remaining limits are stated explicitly.** These are all in README §Important limits:
  - publish-phase JWKS was never read back (an availability gap);
  - the watch is a single check;
  - removal is timed from the root URL only;
  - `template0` and `cloudsqladmin` denials weren't demonstrated;
  - stateless MCP cancellation can't reliably reach another replica;
  - provenance is operator-attested.
- **Cleanup inventory.**
  - **Empty lists:** all 13 optional lists are empty:
    - services and jobs
    - SQL
    - network, subnet and router (Cloud NAT is part of the router, so it's covered)
    - serverless address reservations
    - private DNS
    - app secrets and identities
    - image packages
    - the SQL condition bindings
    - active secret versions
  - **Secret versions:** all three foundation versions are DESTROYED. That matches `retired-signer` (v1 at 11:49) and `cleanup-control` (signer v2 and platform-db v1).
  - **Other records:** `privateFixtureStatePresent: false`. App0 and app1 both show `removed: true`.
  - **Gaps that could hide cost:**
    - NAT uses `AUTO_ONLY`, so no static IP could be left behind (main.tf:205).
    - SQL uses only a public IP with no private services access, so no peering or global address could be orphaned.
    - Firewall rules would block network deletion, so `networks: []` means they are gone too.
  - **The condition-bound `cloudsql.client` binding** matches by instance name. Removing it was correct, and it is gone.
- **Terraform and backend.** `enablePostgres` and `enableNetwork` are both false and the detailed exit code is 0. The backend details are identical in both files: same bucket, UBLA, PAP enforced, versioned, no public IAM, size 29888, and generation `1791897279700515`. The state was written at 13:14:39, before the plan at 13:15:45, and the plan didn't change the generation. All of that is consistent.
- **Cost arithmetic.**
  - **Capture total:** 5.067 + 0.196 + 0.804 + 0.255 + 1 = 7.322. The service rate works out to about $2.65e-5/s, which is roughly the tier-1 rate for 1 vCPU plus 1 GiB, applied over the measured seconds plus 6 h. All 50 executions are listed.
  - **The $0.18 allowance has no derivation and no SQL/NAT deletion timestamps.** It still holds up in the worst case. Even if all three services, SQL and NAT had stayed up until 13:15 (about 1.34 h after capture), the extra cost is about $0.47, giving about $7.79, still under $10.

## Non-blocking residuals to record

1. The cost estimate only covers resources that still existed at 11:55. Services, jobs or executions deleted earlier in the fixture's life aren't listed. The invoice check, which stays OPEN, is the backstop.
2. The retained-foundation list names only the secrets and service accounts. It leaves out:
   - the empty Artifact Registry repo and the Cloud Tasks queue;
   - the enabled APIs;
   - the secret-accessor and AR-writer IAM members;
   - any project-level roles the four retained service accounts might hold outside Terraform.

   The empty-plan result implies the Terraform-managed parts. Project-level roles outside Terraform aren't shown publicly.
3. As you stated, the cloud reads are operator-attested. The evidence is internally consistent and I found no false claims, but no independent cloud check was done.
4. Two nits:
   - "Deleted by 12:00 UTC" doesn't quite match `cleanup-control`'s 12:00:25Z.
   - `independent-technical-review.md:46` has a stray sentence about a plan file that can't be written, which doesn't belong in an evidence document.
