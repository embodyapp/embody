/**
 * @embody/plugin-sdk — the entire contract for writing an embody plugin.
 *
 * This is the ABI. A plugin depends on this package and nothing else from embody, so
 * everything a plugin author touches has one version and one stability promise. The
 * kernel, core, and db packages are implementation detail behind it: they can change
 * freely as long as what is re-exported here keeps its shape.
 *
 * Two rules follow, and both matter more than they look:
 *
 *   1. Declare this as a **peerDependency**, never a dependency. Two copies in one app
 *      means hooks register against a different registry than the kernel boots, and the
 *      plugin then loads cleanly, logs nothing, and silently never fires.
 *   2. Do the same for `zod`. Schemas cross the boundary into the host, which parses
 *      them and converts them to JSON Schema; `instanceof` checks fail across copies.
 *
 * The one piece of machinery here rather than in the kernel is `defineEntity`, which
 * runs the vetoable hook chain inside the tenant transaction around every entity write
 * — which is what makes a rule registered by a plugin genuinely block a real database
 * write, for agents, REST, and the CLI alike.
 *
 * Booting a kernel is not part of this surface; that is the host's job. To write tests
 * against a real runtime, use `@embody/testing`.
 */

// ── This package's own machinery ─────────────────────────────────────────────
export { defineEntity, mergePatch, EntityNotFoundError } from "./entity.ts";
export { defineAutomation, automationEventInput } from "./automation.ts";
export type { AutomationSpec } from "./automation.ts";
export type { EntitySpec, EntityRepository, EntityRow } from "./entity.ts";

/**
 * The Postgres handle a plugin is handed — on `ctx.tx` inside a hook, as the first
 * argument to `EntityRepository.link`, and inside `req.tx(...)`. Both already appear
 * in this package's public surface, so the type has to be nameable from here; without
 * it an author cannot write a helper that takes a transaction.
 */
export type { Sql } from "@embody/db";

// ── The plugin contract ──────────────────────────────────────────────────────
export type {
  EmbodyPlugin,
  KernelContext,
  CapabilityManifest,
  ServiceDescriptor,
  MigrationSet,
  MiddlewarePipeline,
  Json,
} from "@embody/kernel";

// ── Request context and authorization ────────────────────────────────────────
// A plugin receives these; it never constructs them.
export type { RequestContext, Principal, Authorizer } from "@embody/kernel";

// ── Extension surface: vetoable domain hooks ─────────────────────────────────
export { HookVetoError } from "@embody/kernel";
export type { HookHandler } from "@embody/kernel";

// ── Extension surface: MCP tools and resources ───────────────────────────────
export type {
  McpRegistrar,
  McpToolDefinition,
  McpToolHandler,
  McpResourceDefinition,
  McpResourceHandler,
} from "@embody/kernel";

// ── Extension surface: CLI commands ──────────────────────────────────────────
export type {
  CliRegistrar,
  CliCommandDefinition,
  CliCommandContext,
  CliCommandHandler,
  CliOptionDefinition,
} from "@embody/kernel";

// ── Extension surface: events ────────────────────────────────────────────────
export type { EventBus, DomainEvent, EventHandler } from "@embody/kernel";

// ── Logging ──────────────────────────────────────────────────────────────────
export type { Logger } from "@embody/kernel";

// ── Core services a plugin consumes by name through DI ───────────────────────
export type {
  RegistryService,
  PartyService,
  RegisterEntityInput,
  RelateInput,
  SearchHit,
  CreatePartyInput,
  Party,
} from "@embody/core";
