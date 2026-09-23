# @embody/cli

Command-line client, local development host, and MCP stdio bridge for Embody.

```sh
npm install --save-dev @embody/cli
# or run without installation
npx -y @embody/cli --help
```

Requires Node.js 22 or 24 and uses ESM.

## Local development

```sh
npx -y @embody/cli dev
```

This loads `embody.config.ts`, starts a loopback SQLite host, and exposes the development inspector. It must not be exposed as a production service.

## Use registered applications

```sh
export EMBODY_GATEWAY_URL=https://gateway.example.com
export EMBODY_TOKEN=your-short-lived-token

npx -y @embody/cli apps list
npx -y @embody/cli apps inspect operations
npx -y @embody/cli operations task list --status todo --output json
```

The CLI discovers schemas dynamically, coerces flags, accepts complex JSON through stdin with `--json`, streams progress to stderr, and writes results to stdout.

## MCP stdio bridge

```sh
npx -y @embody/cli mcp --url https://gateway.example.com/mcp --token "$EMBODY_TOKEN"
```

The bridge lets stdio-only desktop clients connect to a remote Streamable HTTP MCP endpoint. Tokens can also be supplied through `EMBODY_TOKEN`; command-line arguments may be visible in process listings.

See the complete [CLI reference](https://github.com/embodyapp/embody/blob/main/docs/developer-tools/01-cli-reference.md).

Licensed under the [Elastic License 2.0](./LICENSE).
