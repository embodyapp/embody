# plugins/ — 📦 published as `@embody/*`

First-party plugins, built on the **public** SPI exactly as a stranger's would be.

That is the point of keeping them out of `packages/`: each depends on
`@embody/plugin-sdk` by version range rather than by workspace link, so if a
first-party plugin cannot be built through the public SPI, no community plugin can be
either.

See [../PLUGINS.md](../PLUGINS.md).
