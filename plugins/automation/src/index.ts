/**
 * @embody/automation — configurable triggers over embody's durable event bus.
 *
 * Enable it by adding `automationPlugin` to the `plugins` array in your
 * `embody.config.ts`. It needs a worker process to be running (`--mode worker`),
 * because triggers are domain events and events are delivered by the outbox drain.
 */
export { automationPlugin, automationMigrationsDir } from "./plugin.ts";
export type { WorkflowRow } from "./plugin.ts";
export {
  conditionsMatch,
  buildInput,
  parseCondition,
  resolvePath,
  eventScope,
  CONDITION_OPS,
} from "./rules.ts";
export type { Condition, Comparison, AnyOf, ConditionOp } from "./rules.ts";
