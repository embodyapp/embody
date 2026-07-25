/**
 * @embody/plugin-sdk — the helpers a plugin author builds on.
 *
 * The kernel defines the plugin *contract*; this package supplies the machinery that
 * makes the extension surfaces actually bite. Chiefly `defineEntity`, which runs the
 * vetoable hook chain inside the tenant transaction around every entity write — so a
 * rule registered by a `custom/` plugin genuinely blocks a real database write, for
 * agents, REST, and the CLI alike.
 */
export { defineEntity, mergePatch, EntityNotFoundError } from "./entity.ts";
export type { EntitySpec, EntityRepository, EntityRow } from "./entity.ts";
