# packages/ — 📦 published as `@embody/*`

The runtime and the SPI, on one version line.

`plugin-sdk` is the public contract — the only embody package a plugin depends on.
`kernel`, `core`, and `db` sit behind it as implementation detail. `host` is the server
a deployment runs, `cli` the `embody` binary, `mcp-server` the agent transport,
`testing` the harness plugin authors use, and `create-embody-app` the project generator.

See [../PLUGINS.md](../PLUGINS.md).
