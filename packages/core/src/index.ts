/** @embody/core — shared entities, identity, and the registry, as an embody plugin. */
export { corePlugin, coreMigrationsDir } from "./plugin.ts";
export {
  registryService,
  partyService,
} from "./services.ts";
export type {
  RegistryService,
  PartyService,
  RegisterEntityInput,
  RelateInput,
  SearchHit,
  CreatePartyInput,
  Party,
} from "./services.ts";
export * as schema from "./schema.ts";
