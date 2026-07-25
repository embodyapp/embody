/**
 * The deployment config shape. This is the single place a deployment declares WHICH
 * plugins it runs — the selection mechanism for the embody catalog *and* for a
 * company's own customizations.
 *
 * `core` (the foundation plugin: identity, shared entities, registry) is always
 * registered by the host, so a config only lists the *optional* plugins it enables.
 * Everything environment-specific (DATABASE_URL, PORT, secrets) stays in env, never
 * here — so the same config/artifact runs unchanged locally and in the cloud.
 */
import type { EmbodyPlugin, Logger } from "@embody/kernel";

/**
 * A deployment's plugin selection. Exactly one of `plugins` / `apps` is given.
 *
 * `plugins` is the current key: first-party catalog apps and a company's own
 * `custom/` plugins ride the same SPI and belong in the same list, so "apps" was a
 * misnomer. `apps` is still honoured for existing configs and will be removed.
 */
export type EmbodyConfig =
  | {
      /**
       * Plugins to enable in this deployment, e.g. `[crmPlugin, acmeCrmPlugin]`.
       * Import upstream plugins by package name (`@embody/crm`) so installing one and
       * enabling it are both type-checked; import your own `custom/` plugins by their
       * package name too (or by relative path, if they have no package.json).
       */
      plugins: EmbodyPlugin[];
      apps?: never;
    }
  | {
      /** @deprecated Renamed to `plugins`. Still honoured; will be removed. */
      apps: EmbodyPlugin[];
      plugins?: never;
    };

/** Identity helper that gives an `embody.config.ts` full type-checking + inference. */
export function defineConfig(config: EmbodyConfig): EmbodyConfig {
  return config;
}

/**
 * Read the enabled plugins out of a config, accepting the deprecated `apps` key.
 * Every consumer (host, CLI, MCP server) goes through this, so the two spellings
 * can never drift apart.
 */
export function resolvePlugins(config: EmbodyConfig, logger?: Logger): EmbodyPlugin[] {
  if (config.plugins) return config.plugins;
  logger?.warn(
    "embody.config.ts uses the deprecated `apps:` key — rename it to `plugins:`. " +
      "Catalog apps and your own custom plugins share one list.",
  );
  return config.apps;
}
