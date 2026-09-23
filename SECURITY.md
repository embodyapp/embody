# Security policy

## Supported versions

Security fixes are provided for the latest published release. Pre-release and older versions may be assessed case by case. Upgrade to the newest release before reporting an issue that may already be fixed.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Earlier versions | No |

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in a public issue, discussion, pull request, or social-media post.

Use [GitHub's private vulnerability reporting form](https://github.com/embodyapp/embody/security/advisories/new). Include, when possible:

- affected package and version or commit;
- impact and attack prerequisites;
- minimal reproduction steps or proof of concept;
- suggested remediation;
- whether the issue is already public or subject to a disclosure deadline.

Do not include real credentials, personal data, or customer data. Use synthetic test data and revoke any credential that may have been exposed.

The project will acknowledge reports through the private advisory, validate and prioritize them, and coordinate remediation and disclosure with the reporter. Response or remediation times are not guaranteed. Please keep the report confidential until a coordinated disclosure date is agreed or the project publishes a fix.

If the private-reporting form is unavailable, email [nimrod@tryembody.com](mailto:nimrod@tryembody.com). Do not open a public issue containing vulnerability details.

## Scope

Reports about Embody's source code and published npm packages are in scope. Vulnerabilities exclusively in third-party services, unsupported versions, or social-engineering attempts are generally out of scope, but dependency findings that affect Embody are welcome.

Good-faith research must avoid privacy violations, data destruction, service disruption, and access to systems or data you do not own or have explicit permission to test. This policy does not create a bug-bounty program or promise compensation.
