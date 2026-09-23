# Contributing to Embody

Thank you for your interest in Embody.

## Before you start

- Use [GitHub Discussions](https://github.com/embodyapp/embody/discussions) or an issue for design proposals and substantial changes.
- Search existing issues before filing a new one.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Contribution status

Embody uses a source-available, dual-licensing model. A contributor agreement is required before an external code or documentation contribution can be merged. The counsel-approved agreement and automated signing workflow are not installed yet, so maintainers must not merge external contributions in the meantime.

You may still open issues, participate in discussions, and submit a draft pull request to propose a change. A draft does not grant the project additional rights, and it will remain unmerged until the contributor agreement is available and signed.

This restriction does not apply to typo reports, vulnerability reports, or other feedback that contains no copyrightable contribution.

## Development

Requirements:

- Node.js 22 or 24
- pnpm 11.25.0
- PostgreSQL 16 for PostgreSQL integration tests

Set up the workspace:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Run the PostgreSQL suite separately when changing storage, transactions, tenancy, or migrations:

```sh
pnpm test:postgres
```

## Pull requests

Keep pull requests focused and include:

- a clear description and rationale;
- tests for changed behavior;
- documentation for user-visible changes;
- a changeset for changes to public packages (`pnpm changeset`);
- no credentials, customer data, generated build output, or unrelated formatting changes.

All required CI checks must pass on supported Node.js versions. Maintainers may request design or API changes before accepting a contribution.

## Conduct and licensing

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). The repository is licensed under the [Elastic License 2.0](LICENSE); see the [licensing FAQ](docs/commercial/LICENSING-FAQ.md) for plain-language guidance. The license text, rather than the FAQ, controls.
