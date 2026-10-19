#!/bin/sh
# Sandbox entry (uid 1000, no network, no capabilities). Everything here is customer-controlled
# from the first lifecycle script on; outputs are data for the trusted assembly step.
set -eu
export HOME=/tmp/home CI=true NODE_ENV=development COREPACK_ENABLE_STRICT=0
# Every pnpm invocation uses the prepared store and never reinstalls behind the scenes; there is
# no network to install from anyway.
export npm_config_store_dir=/store npm_config_verify_deps_before_run=false npm_config_offline=true
mkdir -p "$HOME"
cd /app
# --trust-lockfile: the trusted prepare step already applied pnpm's supply-chain checks
# (minimumReleaseAge/trustPolicy need registry metadata, which the sandbox cannot reach).
PNPM="pnpm --store-dir /store --config.strict-dep-builds=false --config.verify-store-integrity=true --trust-lockfile --reporter=append-only"
echo "embody: install"
$PNPM install --offline --frozen-lockfile
echo "embody: build"
# The project's build script, run like `npm run build` but without a package-manager wrapper.
PATH="/app/node_modules/.bin:$PATH"
build=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync("package.json","utf8")).scripts.build))')
sh -c "$build"
echo "embody: extract"
node /embody/extract.mjs
echo "embody: prune"
$PNPM install --offline --frozen-lockfile --prod
rm -rf /app/node_modules/.cache
echo "embody: sandbox build finished"
