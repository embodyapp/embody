# 02 — Accounts, sharing and trusted identity

**Entry:** CH1 foundation. Every route must pass V01–V03 through the service boundary, not only a pure policy function. Permission checks precede resource disclosure and mutations.

## CH2-01 — Hosted login, workspace membership and safe sessions

**Verification first:** only an authenticated verified identity can establish membership; forged login callback/state, session fixation and untrusted workspace claims fail without creating membership. Console cookies are not sent to customer-view sites. Invariants: V01, V02, V12. Boundaries: L2/L3 and provider sandbox smoke.

**Dependencies:** CH1-02/04 and login-provider decision. **Areas:** cloud API/console, identity integration, session storage.

**Implementation steps:**
1. Integrate selected OIDC login with exact issuer/client/redirect configuration, state/nonce/PKCE as appropriate, callback replay defenses and safe redirect allowlists.
2. Persist external subject-to-account binding; avoid account takeover by automatically merging arbitrary matching email claims. Define verified-email change/account recovery policy.
3. Create private workspace and owner membership transactionally. Resolve workspace from server-side membership, not client-supplied org claims.
4. Issue/rotate/revoke HTTP-only secure host-scoped sessions; implement CSRF controls, logout, idle/absolute expiry and session inventory.
5. Enforce MFA/recent authentication for sensitive grants, ownership, billing and recovery operations as defined in HD06.

**Acceptance cases:** `.a` real protocol callback fixture succeeds once and rejects replay/mismatched state/issuer; `.b` session fixation/CSRF/open redirects fail; `.c` W2 membership is inaccessible to W1 and claimed domain alone grants nothing; `.d` logout/expiry deny future requests; `.e` provider sandbox and real-browser cookie inspection confirm intended authentication and site boundaries.

**Evidence:** auth contract/browser reports, identity-provider configuration review and documented recovery limitations. Do not store provider client secrets in browser bundles.

## CH2-02 — Invitations, app grants and privileged membership changes

**Verification first:** an invitation can be redeemed once only by the intended verified identity before expiry; two concurrent redemptions create one membership. Billing admin cannot grant themselves data/deploy access. Invariants: V01, V03, V14, V16. Boundaries: L2/L3.

**Dependencies:** CH2-01. **Areas:** membership/grant repositories, API, transactional audit.

**Implementation steps:**
1. Define platform-role/app-role permission matrix and explicit create/share/deploy/approve/export rights. Treat deployers as app-data-privileged in documentation and UI.
2. Implement hashed invite tokens, expiry, resend/revoke, rate limiting and non-enumerating error responses; keep tokens out of logs/referrers.
3. Persist individual grants, scoped agent/service identities, sponsorship and expiry. Start with individual sharing; groups can be added later without broadening current grants.
4. Implement owner transfer using verified acceptance/recent auth; prevent removal of last owner, concurrent self-lockout and escalation via role edits.
5. Record actor/resource/previous/new permission revision in transactional audit intent; no secret/token payloads.

**Acceptance cases:** `.a` wrong-account/expired/replayed/revoked invites fail; `.b` concurrent acceptance/owner transfer yields one valid result; `.c` viewer cannot mutate or share, billing admin cannot deploy, developer cannot expand workspace policy; `.d` deleting membership revokes associated user grants with an explicit policy for sponsored agents; `.e` audit references exact committed revision.

**Evidence:** real DB role matrix, concurrency tests and API fixtures. UI follows in CH6-01, but API behavior must already be usable.

## CH2-03 — Unified authorization and bounded revocation

**Verification first:** effective permissions equal the intersection of all policy layers across discovery, calls, resources, streams and delayed work. With invalidation messages dropped, stale caches still stop authorizing within 30 seconds. Invariants: V01, V03, V13. Boundaries: L1/L2/L3; cloud recheck at G1/G3.

**Dependencies:** CH2-02. **Areas:** trusted policy evaluator/service, gateway, host/workflow authorization ports.

**Implementation steps:**
1. Implement explicit action grants plus workspace/app/environment/credential restrictions; deny unknown custom actions and capability escalation. Generated CRUD metadata does not automatically approve arbitrary custom effects.
2. Define policy revisions and atomic updates, bounded cache TTL (initial maximum 15 seconds), invalidation, failure behavior and monotonic-clock handling.
3. Expose trusted authorization/revalidation interfaces for catalog, invocation, view/resource reads, output streams, exports, retries and workflow steps. App code cannot forge a permission approval consumed by trusted services.
4. Check ongoing stream entitlement and close on revocation/deadline; delayed steps reauthorize at claim/dispatch boundaries. Do not promise termination of already completed external effects.
5. Fail closed after freshness expires if the policy store is unreachable; keep already-valid routing available independently of the console.

**Acceptance cases:** `.a` property tests prove adding a restriction never increases permission; `.b` stale tokens/catalogs do not bypass denied action access; `.c` revoke under normal delivery, lost invalidation and policy-store partition and meet maximum deadline across all gateway replicas; `.d` paused workflow does not claim its next step after revocation; `.e` denied logs/errors do not expose inaccessible app metadata.

**Evidence:** cross-surface access matrix and timed revocation report. Placeholder adapters that always allow are forbidden outside explicitly named test fixtures.

## CH2-04 — Asymmetric downstream tokens and owned registration

**Verification first:** valid platform-issued token works only for its intended app/environment; hostile app holding every runtime credential cannot mint a token accepted by a neighbor or the platform. Invariants: V02, V05, V08. Boundaries: L2/L3/L4 key custody.

**Dependencies:** CH1-03/04, CH2-03. **Areas:** `packages/auth`, `packages/gateway`, host registration and trusted signer.

**Implementation steps:**
1. Close algorithm/key-service decision with supported library/provider evidence. Keep private keys in trusted signer/KMS and expose public JWKS with bounded caching.
2. Define canonical audience and identity/delegation claims using immutable workspace/app/environment IDs, expiry ceiling and key version. Add strict hosted verifier mode.
3. Provision registration credentials bound to workload/release/owned endpoint. Endpoint ownership comes from deployment state; never accept arbitrary customer URL registration.
4. Add signing/JWKS rotation, overlap, emergency revocation and refresh-rate limits. Preserve explicit self-hosted HS256 behavior outside hosted mode.
5. Prevent cross-audience bearer forwarding and customer-controlled issuer/algorithm selection.

**Acceptance cases:** `.a` wrong issuer/audience/env/alg, expired/oversized/unknown-key tokens reject; `.b` attempted HS/RS confusion and tenant-generated signatures reject; `.c` overlap rotation succeeds and removed key stops working within documented bound; `.d` stolen registration cannot claim another release or arbitrary destination; `.e` deployed IAM denies runtime/build principals signing and private-key reads.

**Evidence:** cryptographic protocol fixtures, rotation test, cloud IAM negative tests and compatibility suite. This must precede unrelated-customer hosting.

## CH2-05 — CLI and agent authentication

**Verification first:** a restricted agent can discover/invoke exactly its allowed targets; it cannot refresh/escalate using a human session or another client's credential. Device/login authorization cannot be completed under a substituted account without user confirmation. Invariants: V02, V03, V17. Boundaries: L2/L3.

**Dependencies:** CH2-01–CH2-04. **Areas:** CLI profiles/login, MCP auth adapter, cloud credential API.

**Implementation steps:**
1. Add browser/device CLI login with bounded polling, one-time authorization, expiry and least-privilege local profile storage. Separate cloud management login from app agent access.
2. Implement remote MCP authorization for the pinned supported protocol/client matrix; validate resource/audience binding, redirect and PKCE requirements.
3. Provide explicitly labeled expiring scoped credentials for supported beta clients without compatible OAuth; hash verification values, display once, allow rotation/revoke/last-use inspection.
4. Use separate agent IDs with owner sponsorship and grants; prevent actor-type impersonation through caller headers.
5. Document noninteractive CI credentials, secure storage and safe stdout/stderr output; tokens never appear in URLs/help/logs.

**Acceptance cases:** `.a` packed CLI login/logout/expiry and wrong-device-code flows; `.b` official MCP client authorized and denied discovery/calls; `.c` credential revocation blocks active client and stream within V03 deadline; `.d` malicious token exchange cannot broaden scope/audience; `.e` dated supported-vendor smoke records actual behavior without substituting for automated tests.

**Evidence:** spawned packed CLI tests, official protocol conformance and token-redaction snapshots. Never describe manual token setup as universal one-click OAuth.
