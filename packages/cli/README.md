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

## Upload source to a hosted gateway

```sh
export EMBODY_GATEWAY_URL=https://gateway.example.com
export EMBODY_TOKEN=your-deployer-token

npx -y @embody/cli source pack . --output json   # local preview: included/excluded files
npx -y @embody/cli source upload . --workspace ws_… --app app_…
```

`source upload` packages only supported project files (never `.env*`, dotfiles, credentials, local databases, `.git`, `node_modules` or build outputs), uploads them through short-lived, single-object upload access, and waits for the gateway to verify them. Re-running it resumes safely under the same upload ID. It does not deploy or build anything. Rules, limits and errors: [hosted source admission](https://github.com/embodyapp/embody/blob/main/docs/mvp/SOURCES.md).

## Deploy to a hosted workspace

```sh
# Profiles in ~/.config/embody/config.json (mode 0600) hold the gateway URL and your keys.
npx -y @embody/cli deploy --app kanban            # pack, upload, submit, follow to active
npx -y @embody/cli deploy --app kanban --no-wait --output json   # prints the deployment ID
npx -y @embody/cli deployments status dep_… --app kanban --wait  # from any machine, by ID
npx -y @embody/cli deployments cancel dep_… --app kanban         # server-side, fenced
npx -y @embody/cli mcp setup --app kanban --write ~/.embody-mcp.json
```

`deploy` reads the static `embody.hosted` declaration from `package.json` (create-embody-app writes it); it never runs project code. The deployment ID is printed as soon as the gateway accepts it, rerunning the same command resumes the same deployment, and Ctrl-C stops only local waiting. Exit codes, JSON output, workspace URL forms and MCP setup: [hosted CLI guide](https://github.com/embodyapp/embody/blob/main/docs/mvp/CLI.md).

## MCP stdio bridge

```sh
npx -y @embody/cli mcp --url https://gateway.example.com/mcp --token "$EMBODY_TOKEN"
```

The bridge lets stdio-only desktop clients connect to a remote Streamable HTTP MCP endpoint. Tokens can also be supplied through `EMBODY_TOKEN`; command-line arguments may be visible in process listings.

See the complete [CLI reference](https://github.com/embodyapp/embody/blob/main/docs/developer-tools/01-cli-reference.md).

Licensed under the [Elastic License 2.0](./LICENSE).
