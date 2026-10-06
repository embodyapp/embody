# 04 — Source ingestion, untrusted builds and immutable artifacts

## CH4-01 — Safe CLI source ingestion

**Verification first:** a source archive cannot escape its extraction root, substitute unauthorized app/environment IDs, overwrite another upload or consume unbounded disk; accepted source has a stable digest. Invariants: V01, V04, V08. Boundaries: L2/L3.

**Dependencies:** CH1-04, CH2-03. **Areas:** cloud source API/object storage, CLI packaging, isolated archive worker.

**Implementation steps:**
1. Define size/file-count/path limits, supported file types, lockfile/runtime requirements and source upload lifecycle; reject absolute paths, traversal, dangerous links and expansion bombs.
2. Add CLI preflight and deterministic source archive with explicit ignore rules for `.git`, environment files, credentials, node_modules and artifacts. Show included-file summary; secret scanning is advisory defense, not a guarantee.
3. Issue short-lived scoped upload permissions; bind upload record/digest to authenticated workspace/app and verify bytes before build admission.
4. Validate/extract in a restricted worker, not a privileged API process. Never import `embody.config.ts` in the control plane.
5. Expire abandoned uploads and preserve only authorized deploy-source retention.

**Acceptance cases:** `.a` traversal/symlink/hardlink/duplicate-path/oversized archive corpus fails with stable errors; `.b` W1 cannot finish/read W2 upload; `.c` modified bytes reject against digest; `.d` interrupted/retried upload yields one accepted source; `.e` packed CLI excludes canary `.env` files and reports explicit failure for unsupported source.

**Evidence:** hostile archive/property tests, upload authorization tests, CLI source fixture and byte-level digest checks.

## CH4-02 — Git repository integration and webhook ownership

**Verification first:** only the authorized installation/repository/commit can trigger a build for the bound app. Forged/replayed/reordered webhook or fork PR cannot deploy production or receive production credentials. Invariants: V01, V04, V09. Boundaries: L2/L3 plus vendor sandbox smoke.

**Dependencies:** CH2-03, CH4-01. **Areas:** Git integration callbacks, source fetcher and repository binding API.

**Implementation steps:**
1. Request minimum repository-scoped installation permissions and store encrypted integration references. Bind installation/repo IDs to workspace/app, not user-provided repository URLs alone.
2. Authenticate webhook raw body/signature, timestamps if supported, event IDs, event types and repository ownership before enqueueing work.
3. Resolve source to immutable commit SHA; deduplicate delivery and apply branch/promotion policy. Mutable branch head changes cannot swap source after approval.
4. Separate untrusted PR/fork preview contexts from trusted production actions; fork workflow content never controls privileged platform build credentials.
5. Handle installation removal, access loss and repository transfer by stopping new source access and surfacing a recoverable status; rotate fetch credentials.

**Acceptance cases:** `.a` forged signature/wrong installation/replayed event creates no extra build; `.b` reordered pushes do not silently promote an older commit; `.c` branch change after approval does not alter selected digest; `.d` fork PR cannot read protected secrets or auto-promote; `.e` revoked installation fails closed with sanitized status.

**Evidence:** protocol fixture tests, real test-repository installation/deploy trigger and audit trail linking event → commit → source digest.

## CH4-03 — Isolated build and manifest extraction

**Verification first:** hostile install scripts and executable Embody config can run only inside the build sandbox, cannot access other builds/production/platform credentials, and are forcibly stopped at quota/time limits. Invariants: V04, V05, V14. Boundary: L4 with L2 deterministic failure cases.

**Dependencies:** CH3-01/03, CH4-01; CH4-02 for Git path. **Areas:** build workers/provider adapter and pinned build recipes.

**Implementation steps:**
1. Start isolated Cloud Run build job with pinned supported Node/base image, frozen lockfile and bounded CPU/memory/scratch/time/network; no privileged Docker daemon/customer Dockerfile. Customer install/config code does not execute in a privileged shared Cloud Build pipeline.
2. Fetch validated source into build-only storage; allow registry destinations needed by the documented recipe. No production secrets or cloud provisioning identity inside builder.
3. Run install/build/tests as configured and extract manifest in the sandbox. Treat manifest/action metadata as untrusted data with strict schema/size limits at the control-plane boundary.
4. Produce a bounded app bundle plus manifest/build metadata/SBOM candidate. Trusted packaging validates paths and assembles the fixed runtime base + bundle into OCI without executing tenant output. Persist immutable digests in Artifact Registry via trusted admission. Prove this build recipe in CH1-03; cache only scoped or proven content-addressed nonsecret inputs, with no cross-tenant writable cache poisoning.
5. Stream bounded sanitized logs, handle cancellation/worker death and always record resource cleanup; cap cost before starting another attempt.

**Acceptance cases:** `.a` malicious install/config cannot use metadata identity to access neighbor artifacts/platform services; only explicitly scoped build staging is permitted, while legitimate install/build succeeds; `.b` arbitrary manifest fields, path tricks and resource floods fail safely; `.c` timeout/cancel/crash leaves no publishing capability or live worker; `.d` cache poisoning cannot alter another build's source/output; `.e` same pinned source yields recorded provenance even if byte reproducibility is not guaranteed by dependencies.

**Evidence:** cloud hostile-build corpus, logs/canary scans, quota termination and cleanup inventory. Do not call a mock container run VM-isolation proof.

## CH4-04 — Trusted artifact admission and provenance

**Verification first:** mutation of image/manifest/source/config digest invalidates admission; builder/app cannot sign, select a different app's artifact or promote an unapproved result. Invariants: V02, V08, V14. Boundaries: L2/L4.

**Dependencies:** CH4-03, CH2-04. **Areas:** trusted artifact service, registry, signature verification and scanner policy.

**Implementation steps:**
1. Trusted service independently resolves received artifact digest and binds source, build recipe, runtime, manifest, workspace/app and scanner results to provenance.
2. Generate/store SBOM including OS and application packages; block exploitable high/critical findings without an explicitly reviewed time-bounded exception permitted by release policy. Tenant-boundary defects are not waivable.
3. Sign admitted digests outside builder identity; enforce immutable references and scoped registry access. App image cannot change the deployed digest through a mutable tag.
4. Verify admission again at deployment, including current revoked/quarantined status and required capability approvals.
5. Implement retention references for active/rollback/workflow releases and garbage collection that cannot delete still-referenced artifacts.

**Acceptance cases:** `.a` tamper each provenance field/signature/blob and deployment rejects; `.b` tenant/build identity cannot call signing or overwrite another artifact; `.c` unknown/revoked signer and quarantined artifact block startup/promotion; `.d` concurrent retention/GC preserves live references; `.e` scanner outage yields explicit blocked state rather than silent approval.

**Evidence:** signature/admission negatives, actual registry/IAM tests, SBOM inspection and trusted-to-untrusted credential map. Signing certifies pipeline provenance, not that customer code is safe.
