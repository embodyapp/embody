# Publishing the npm packages

This runbook covers the public Embody packages only. Never commit an npm token or paste a password, one-time code, recovery code, or token into an issue or chat.

## One-time owner setup

1. Sign in to [npmjs.com](https://www.npmjs.com/) and enable two-factor authentication for both authorization and writes.
2. Confirm that your npm account is an Owner of the `embody` organization.
3. Confirm that the unscoped name `create-embody-app` is available to your account.
4. In GitHub, open **Settings → Environments**, create an environment named `npm`, restrict deployment to `main`, and add a required reviewer if desired.

The first publication cannot use npm trusted publishing because the package settings do not exist until each package has been created. Bootstrap the first release interactively from a trusted machine. Do not add a long-lived npm token to the repository.

## Prepare the first beta

Do not perform these steps until CI and the external-consumer release test are green.

```sh
git checkout main
git pull --ff-only
pnpm install --frozen-lockfile
pnpm verify
pnpm release:artifacts
pnpm changeset status
pnpm changeset version
pnpm install --lockfile-only
pnpm verify
git add .
git commit -m "chore(release): version public beta packages"
git push origin main
```

Wait for the pushed commit's required CI checks to pass. Review the version and changelog changes before publishing.

## Bootstrap publication

Authenticate on your own trusted machine:

```sh
npm login
npm whoami
```

Publish the versioned packages under the beta tag:

```sh
pnpm changeset publish --tag next
```

Complete npm's interactive two-factor authentication when prompted. Verify every package with `npm view`, and then log out if this is not a dedicated release machine:

```sh
npm logout
```

Never rerun a partially failed publication blindly. First use `npm view <package> versions --json` to identify which immutable versions were published, fix the cause, and let Changesets publish only missing versions.

## Configure trusted publishing

After all nine package pages exist, open each package on npmjs.com and select **Settings → Trusted Publisher → GitHub Actions**. Use exactly:

- GitHub organization or user: `nimrod4278`
- Repository: `embody`
- Workflow filename: `release.yml`
- Environment: `npm`
- Allowed action: direct `npm publish`

Configure this for:

- `@embody/auth`
- `@embody/cli`
- `@embody/core`
- `create-embody-app`
- `@embody/gateway`
- `@embody/host`
- `@embody/mcp`
- `@embody/storage`
- `@embody/testing`

The workflow uses a GitHub-hosted runner and `id-token: write`; npm automatically records provenance for trusted publications. Do not configure an `NPM_TOKEN` secret.

## Later releases

1. Merge changesets with user-facing changes.
2. Run `pnpm changeset version`, update the lockfile, and merge the version commit after CI passes.
3. Open **GitHub → Actions → Release npm packages → Run workflow** on `main`.
4. Select `next` for beta releases. Use `latest` only after the externally installed beta has passed the release smoke test.
5. Verify versions and dist-tags on npm after the workflow succeeds.
