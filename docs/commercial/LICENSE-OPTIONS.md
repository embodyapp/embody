# License options: comparison and decision plan

> Planning document only. This is not a license, does not grant rights, and is not legal advice. Final terms require approval by the rightsholder and qualified counsel.

## Current repository status

Embody is licensed under the unmodified **Elastic License 2.0 (ELv2)**. The canonical text is the root `LICENSE`, and first-party package manifests use the SPDX identifier `Elastic-2.0`. ELv2 is source-available, not OSI-approved open source.

The distribution model combines:

- ELv2 for community use;
- a paid **Embody Commercial License** for rights outside ELv2; and
- a separate trademark policy.

ELv2 permits use, modification, and redistribution but permanently prohibits providing the software as a hosted or managed service where users receive access to a substantial set of its features or functionality. The intended application boundary allows internal self-hosting, customer-specific consulting, and hosting distinct domain applications whose users consume the application's functionality rather than Embody's general-purpose platform. Shared managed hosting of Embody requires a commercial agreement. Counsel review and the commercial and trademark terms remain release blockers.

## Comparison with Business Source License 1.1

| Topic | Embody under ELv2 | BSL 1.1 |
|---|---|---|
| Status today | Standard unmodified license installed | Standard source-available license text with project-specific parameters |
| Open source | No | No before its Change Date; automatically becomes open source afterward |
| Default use grant | Use, copying, modification, derivatives, and redistribution subject to three limitations | Copying, modification, derivatives, redistribution, and non-production use |
| Production self-hosting | Allowed when it is not a prohibited third-party managed service | Allowed only if the project’s Additional Use Grant permits it, otherwise commercial rights are needed |
| Domain SaaS built with Embody | Allowed when users do not receive access to a substantial set of Embody's functionality; edge cases need review | Must be expressly covered by the Additional Use Grant to be safe |
| Competing hosted Embody service | Permanently prohibited when it exposes a substantial set of Embody functionality | Can be excluded by the Additional Use Grant before conversion |
| Automatic conversion | None | Mandatory conversion for each released version on its Change Date or no later than four years after first public distribution |
| Long-term hosting protection | Permanent | Temporary for each version; competitors can host that version after conversion under the Change License |
| Modification of standard text | Embody uses the standard text unchanged | BSL text cannot be modified beyond permitted project parameters if using the BSL name/text |
| Familiarity and predictability | Existing concise license and public FAQ | Existing recognizable template, but project-specific Additional Use Grant still needs careful drafting |
| Contributions and relicensing | CLA/assignment rights are needed for commercial dual licensing | The same ownership issue applies, especially for commercial exceptions and future license changes |

Official BSL references:

- <https://mariadb.com/bsl11/>
- <https://mariadb.com/bsl-faq-adopting/>

## Fit with the business goal

The business goal is to operate the official Embody hosting service while preventing unauthorized competing Embody hosting services.

BSL 1.1 can protect that goal only during each version’s pre-conversion period. Its mandatory conversion means an unauthorized provider may eventually offer an older converted version as a competing service. Product velocity, trademarks, support, security updates, operational know-how, and commercial-only services can reduce that threat, but the license cannot eliminate it after conversion.

ELv2's permanent managed-service restriction aligns with the permanent no-competing-hosting requirement. The tradeoff is that it will not become open source automatically and may attract fewer contributors or adopters.

## Selected direction

Embody uses **unmodified ELv2 with a separate commercial license**, rather than BSL 1.1 or new custom wording.

ELv2 targets offering Embody’s substantial platform functionality to third parties, not every SaaS product that happens to use Embody internally. The FAQ should document these intended uses under the unchanged terms:

1. internal production self-hosting;
2. personal, evaluation, development, testing, and educational use;
3. customer-specific consulting where the customer controls its own deployment;
4. domain applications whose users consume the application's distinct functionality rather than Embody's platform; and
5. modification, redistribution, and plugins subject to ELv2's limitations and notice requirements.

Commercial rights are required to provide a hosted or managed service exposing a substantial set of Embody's functionality. ELv2 also prohibits bypassing protected license-key functionality and removing required notices. ELv2 does not independently prohibit every OEM, embedding, modified distribution, or proprietary plugin scenario; those activities are reserved only when they violate an ELv2 limitation or separate trademark rights.

### Why BSL 1.1 was not selected

BSL 1.1 would be suitable only if Embody accepted all of the following:

- every released version will become open source within four years;
- competitors may host converted older versions;
- the ecosystem benefit of guaranteed conversion outweighs that risk; and
- counsel confirms that an Additional Use Grant can clearly allow internal production and domain applications while excluding competing hosting.

If BSL is selected, use unmodified BSL 1.1 text, choose a GPLv2-compatible Change License with counsel, define a version-specific Change Date, and have counsel approve the Additional Use Grant. Do not describe pre-conversion BSL code as open source.

## Adoption plan

### 1. Confirm the ELv2 boundary

- Define the official hosted product and the capabilities that constitute a substantial set of Embody functionality.
- Document that the hosting restriction is permanent.
- Record which enterprise, OEM/embedding, plugin, and marketplace activities ELv2 actually permits and which separate offerings Embody will sell.
- Select concrete allowed and prohibited examples without implying restrictions absent from ELv2.

**Exit criterion:** the rightsholder and counsel approve a one-page use-case matrix with no unresolved core scenario.

### 2. Complete legal review

Evaluate ELv2 as applied to internal production, domain SaaS, consulting, distribution, modifications, plugins, competing hosting, patents, termination/cure, dependencies, and contribution policy. Confirm that no project document purports to modify ELv2.

**Exit criterion:** counsel provides written approval and identifies remaining operational risks.

### 3. Run scenario tests

Obtain an unambiguous answer for at least these cases:

- a company runs Embody internally;
- a developer sells a vertical SaaS backed by Embody;
- an agency deploys one isolated instance into each customer’s account;
- an agency runs many customer instances in its own account;
- a cloud provider exposes Embody APIs or UI;
- a vendor forks and rebrands Embody hosting;
- a vendor hosts an old Embody version under ELv2;
- a user distributes modifications or a plugin.

**Exit criterion:** approved FAQ answers match the commercial model and do not accidentally prohibit ordinary backend use.

### 4. Complete ownership and legal prerequisites

- Confirm chain of title and third-party contribution rights.
- Adopt a counsel-approved CLA or equivalent rights process for dual licensing.
- Confirm rightsholder, entity assignment, governing law, notice address, year, and signatory.
- Clear trademarks and approve a separate trademark policy.

**Exit criterion:** all legal publication blockers in `READINESS.md` are complete.

### 5. Verify the selected license implementation

- Verify the exact unmodified ELv2 text at root `LICENSE`; add only required notices to `NOTICE`.
- Verify package metadata uses the SPDX identifier `Elastic-2.0`.
- Include exact terms in npm tarballs, source archives, containers, and documentation artifacts.
- Publish a plain-language FAQ and commercial-license contact path.
- Extend CI to verify canonical file hashes, metadata, packed artifacts, and prohibited “open source” claims.
- Preserve generated application ownership and `UNLICENSED` default behavior.

**Exit criterion:** artifact tests and all checks in Phase 13 pass against the exact release candidate.

### 6. Validate commercial operation

- Publish a clear route to purchase managed-hosting, OEM, or other reserved rights.
- Rehearse purchase, entitlement, renewal, termination, cure, and data export.
- Review the license decision annually against adoption, contribution, conversion risk, and hosting competition.

**Exit criterion:** legal terms, product behavior, website claims, and sales practice give the same answer for every tested scenario.
