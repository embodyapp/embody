# Phase 13 — Commercial and source-available licensing

**Specs:** release and distribution requirements across 01–08. **Status:** P13-01 through P13-05.

## Objective

Publish Embody under terms that preserve self-hosting and application development while funding the project through managed hosting, enterprise capabilities, support, and commercial-use exceptions. Establish the legal, technical, operational, and go-to-market foundations required to sell those offerings. This is the final public-release gate after Phase 12.

Licensing can protect the business model, but it does not by itself prove demand or make the product commercially viable. Phase 13 therefore includes ownership, product packaging, pricing validation, contracting, billing, support, and compliance—not only a license file.

## License decision

Use a **source-available dual-license model inspired by n8n**:

1. The public repository is offered under an **Embody Sustainable Use License** (community license).
2. Customers who need rights outside the community license receive a separate paid **Embody Commercial License**.
3. Names, logos, and product identity are governed separately by an **Embody trademark policy**.

This is deliberately **not an OSI-approved open-source model** and must be described as “source-available” or, if counsel confirms the terminology, “fair-code.” Documentation, package metadata, website copy, and sales material must not call the project “open source.” Apache-2.0, MIT, and AGPL do not meet the stated business requirement because they permit competing hosted services.

The exact legal text must be prepared or approved by qualified counsel. Do not copy n8n's terms or publish an agent-authored license without confirming reuse rights, enforceability, governing law, and consistency with the commercial agreement.

## Product-use policy to encode

The community license must make the following boundary understandable without requiring users to infer business intent.

### Allowed without payment

- Individuals and organizations may inspect, run, and modify Embody.
- Users may self-host Embody for personal use and for their organization's internal business operations.
- Users may build private internal plugins and modifications.
- Users may build, sell, and host applications whose primary value is distinct domain functionality built with Embody, provided those applications do not expose Embody as a general-purpose automation/agent platform or substitute for an Embody commercial offering.
- Consultants may charge for development, deployment, training, and maintenance when Embody runs for a specific customer and is not offered as the consultant's shared managed service.
- Community plugins may be distributed under the community license or another explicitly approved compatible source-available license.

### Requires a commercial agreement

- Offering Embody, or substantially equivalent Embody functionality, as a hosted or managed service to third parties.
- White-labeling, reselling, OEM distribution, or embedding Embody where Embody supplies a substantial portion of the product's value.
- Selling modified Embody distributions.
- Selling closed-source/proprietary Embody plugins or marketplace extensions. Customer-private internal plugins remain allowed.
- Removing or replacing required product notices, bypassing commercial feature/license controls, or using protected branding beyond the trademark policy.
- Any use for which the community terms are unclear and the customer needs negotiated rights, warranties, indemnity, or support commitments.

The policy must define “internal use,” “application,” “plugin,” “managed service,” “competing offering,” “substantial portion of value,” “customer environment,” “consultant,” “distribution,” and corporate affiliates. Include concrete allowed/prohibited examples. Avoid language broad enough to capture ordinary SaaS products merely because they use Embody internally.

## P13-01: ownership and legal foundation

- Establish the legal entity that owns or has exclusive authority to license Embody; confirm copyright holder, publication year, governing law, and authorized signatory.
- Audit the complete Git history and all first-party assets for chain of title, prior-employer claims, copied code, AI-generated material policy, and third-party contributions.
- Obtain contributor rights sufficient for dual licensing. Adopt a counsel-approved contributor license agreement granting the project relicensing rights; a DCO alone is insufficient when contributions may later be sold under different commercial terms.
- Obtain agreements or replacement code for existing contributions whose rights are insufficient. Do not assume a new CLA applies retroactively.
- Add contributor guidance, a CLA workflow/bot, contribution provenance records, and a documented process for corporate contributors.
- Perform trademark clearance for “Embody,” relevant package names, logos, and domains before investing in branding. File registrations in commercially relevant jurisdictions when justified.
- Approve a trademark policy covering nominative use, community projects, forks, modified distributions, domains, logos, and revocation for misleading use.
- Have counsel assess export controls, sanctions, encryption notices, patent exposure, and whether any planned usage restrictions create local consumer or competition-law issues.

## P13-02: community and commercial terms

- Produce the counsel-approved community license, commercial-license template, evaluation/trial terms, and trademark policy from the product-use policy above.
- Ensure the community and commercial grants are mutually consistent and identify which agreement controls when a customer purchases commercial rights.
- Define commercial rights by product/SKU: managed hosting, enterprise self-hosting, OEM/embedding, proprietary plugins, marketplace distribution, support, and professional services.
- Define affiliate, contractor, user/seat, environment, usage, and revenue boundaries so pricing cannot be avoided accidentally and normal customer operations are not unexpectedly prohibited.
- Specify term, renewal, audit/verification rights, cure periods, termination, post-termination operation/data export, warranty disclaimers, liability caps, indemnities, confidentiality, and dispute terms.
- Publish a plain-language licensing FAQ with examples for internal use, customer-specific consulting, domain SaaS applications, agencies, cloud marketplaces, proprietary plugins, forks, and managed-service competitors.
- Establish a documented intake and escalation process for licensing questions; only authorized people may issue binding exceptions.
- Version the community license and commercial terms. Record which software release was distributed under which terms, and never retroactively change rights already granted.

## P13-03: repository and distribution implementation

- Add the approved community-license text as root `LICENSE`, applicable copyright notices, and an accurate `NOTICE` containing only required notices.
- Mark publishable npm packages with `"license": "SEE LICENSE IN LICENSE"` or another counsel-approved machine-readable expression for the nonstandard license. Include the exact applicable license and notice files in every tarball.
- Keep private examples consistent with repository terms while clearly identifying sample status. Separate any independently licensed SDK or interoperability component into an explicit package rather than implying a different license.
- Ensure applications generated by `create-embody-app` belong to their users. Generated private packages remain `UNLICENSED` by default and receive no Embody copyright claim; offer explicit license selection separately if added later.
- Add file-level notices only where legally or operationally useful; avoid noisy headers that conflict with generated or third-party files.
- Include license and notice material in source archives, npm packages, binaries, container images, documentation sites, SBOMs, and marketplace listings.
- Build technical entitlement checks for paid features only after defining the commercial boundary. Support offline enterprise environments, signed entitlements, clock-skew/grace behavior, renewal, revocation, and recovery without putting secrets or private signing keys in clients.
- Keep customer data export and uninstall paths functional after entitlement expiry. Never hold customer data hostage to enforce payment.
- Make telemetry opt-in unless contracts and privacy disclosures explicitly support another model. License enforcement must minimize collected data and document every transmitted field.

## P13-04: third-party and distribution compliance

- Inventory production, development, bundled, vendored, generated, model, asset, and container dependencies, including transitives.
- Generate machine-readable SBOMs and third-party attribution reports from the frozen lockfile and exact packed/container artifacts—not only source manifests.
- Classify dependency licenses against a counsel-approved policy. Copyleft, source-available, custom, unknown, noncommercial, model/data, or missing licenses require explicit review before distribution.
- Confirm every dependency permits distribution under both the community offering and each paid delivery model. A dependency acceptable for source use may not permit SaaS, embedding, marketplace, or proprietary redistribution.
- Preserve required copyright, attribution, `NOTICE`, source code/source offers, and modification statements in each channel. Do not add dependency notices to the project `NOTICE` unless required.
- Add CI gates for missing first-party license files, unknown/prohibited dependency licenses, stale notices, package metadata, SBOM generation, and packed/container contents.
- Record exceptions with component/version, use and distribution context, rationale, approver, remediation owner, and expiry/review trigger. Scanner output alone is not legal approval.

## P13-05: commercial launch readiness

### Offering and economics

- Identify the initial ideal customer profile, buyer, urgent use case, competing alternatives, sales motion, and why customers will pay instead of remaining on community terms.
- Define a small initial product ladder: community self-hosted, managed cloud, enterprise self-hosted, OEM/embedding, and optional support/services. Do not create features solely to make the community edition unusable.
- Select measurable pricing units appropriate to customer value and infrastructure cost. Model gross margin using compute, storage, event traffic, support, payment fees, observability, backups, and incident overhead.
- Validate willingness to pay through design partners or signed pilots before treating pricing as settled. Record conversion, activation, retention, support burden, cloud cost, and sales-cycle targets with explicit continue/change/stop thresholds.
- Define which enterprise capabilities are proprietary and keep the package/service boundary auditable. Candidate paid capabilities include SSO/SAML, advanced RBAC/governance, audit retention/export, HA operations, policy controls, premium connectors, and support—not security fixes required by all users.

### Contracts and operations

- Prepare website terms, privacy policy, data-processing agreement, subprocessors list, acceptable-use policy, support policy, SLA/service-credit terms, order form, commercial license, and enterprise security materials.
- Define data residency, retention/deletion, backups, breach response, vulnerability disclosure, customer export, account closure, and subprocessors before accepting production customer data.
- Implement tax/VAT handling, invoicing, refunds, trials, renewals, cancellation, failed-payment recovery, and revenue recognition with appropriate professional advice.
- Establish support channels, severity levels, response targets, escalation/on-call ownership, status page, incident communication, and a sustainable paid-support boundary.
- Publish a security contact and vulnerability policy. Define patch eligibility so critical fixes reach affected community users and do not become an unsafe paywall.
- Prepare sales and support playbooks for community-to-commercial conversion without threatening legitimate users. License enforcement starts with clarification and cure, escalating through the approved legal process.
- Track license exceptions, commercial contracts, entitlement issuance, renewals, and obligations in systems with access controls and audit history.

## Tests and success criteria

### Legal and policy gates

- Counsel and the authorized rightsholder approve the exact community license, commercial templates, CLA, trademark policy, FAQ, and public terminology.
- Chain-of-title review accounts for every material existing contribution and asset; unresolved ownership blocks release.
- Allowed/prohibited scenario tests cover internal self-hosting, domain applications, consultants, managed hosting, OEM use, modified distributions, private plugins, and sold proprietary plugins without contradictory answers.
- Public pages consistently say “source-available,” not “open source,” and clearly link the applicable terms before download or purchase.

### Artifact and entitlement gates

- Automated policy tests verify required package metadata and canonical license/notice contents.
- Packed npm artifacts and container filesystem inspections prove recipients receive applicable terms and third-party notices.
- A scaffold integration test proves a generated private app remains user-owned and `UNLICENSED` unless its owner explicitly chooses otherwise.
- Entitlement tests cover valid, expired, revoked, malformed, wrong-customer, wrong-feature, offline, clock-skew, and key-rotation cases. Failure never corrupts or prevents export of customer data.
- CI emits archived SBOM and attribution artifacts; every shipped component has an identified compatible license or approved exception.

### Commercial-readiness gates

- At least one complete purchase path—from published terms/order through payment or invoice, entitlement provisioning, deployment, support access, renewal/cancellation, and data export—is rehearsed in a non-production environment.
- Pricing and gross-margin assumptions are documented with measured infrastructure/support inputs and evidence from target customers; unknowns have owners and review dates.
- Security/privacy/support obligations promised in sales material map to implemented controls and named operational owners.
- Community users can complete the self-hosted quickstart without a commercial key, while prohibited commercial scenarios have a clear purchasing route.
- Release artifacts, website claims, sales documents, and entitlement behavior agree on edition names, rights, and limitations.

Phase 13 passes only when P13-01 through P13-05 evidence is linked in `STATUS.md`, the authorized rightsholder and counsel approve publication, compliance checks pass against exact release artifacts, and commercial operations can honor every promise made to a paying customer. No public source-available or commercial MVP release may precede this phase.
