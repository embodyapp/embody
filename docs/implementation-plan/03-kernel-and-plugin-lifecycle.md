# Phase 3 — Kernel and plugin lifecycle

**Spec:** 02. **Status:** P3-01, P3-02.

## Objective

Implement deterministic plugin composition, service/action/hook registries, and the seven boot phases without transport-specific logic.

## P3-01: plugin graph and services

- Validate plugin IDs/semver and reject duplicates before side effects.
- Resolve `dependsOn` with deterministic topological sorting; use plugin ID as tie-breaker for otherwise independent plugins.
- Report missing dependencies and cycles with the full useful path.
- Service registry registers singleton values under canonical keys. Define ownership (`pluginId.serviceName`) and optional aliases; reject duplicate keys.
- Register all service factories in topological order, then expose only dependencies that are declared/available. Dispose services in reverse order if a disposal contract is adopted.
- Detect access before registration and return a structured dependency error listing requester and key.

## P3-02: boot state machine and registries

Represent states (`created`, `booting`, `ready`, `stopping`, `stopped`, `failed`) and make boot single-flight. Implement:

1. Validate/sort plugins.
2. Ensure storage schema.
3. Register services.
4. Run plugin `init` in order.
5. Register entity definitions, CRUD actions, hooks, custom actions, events, and reserved workflows.
6. Compile immutable manifest/surface registrations (actual HTTP/MCP/CLI mounting is delegated).
7. Start configured worker/ingress lifecycle components.

Separate `boot()` from `listen()`: tests and embedded consumers can boot without sockets; host supplies ingress component. On failure, stop already-started components and dispose resources in reverse order. `stop()` is idempotent and waits for bounded graceful completion.

Hook registry behavior:

- Multiple handlers per exact hook key execute serially in topological plugin order.
- A veto stops remaining handlers and mutation; classify explicit `HookVetoError` while safely wrapping ordinary hook errors.
- Build an execution trace (handler ID, start/end, outcome) usable by inspector/audit, with no sensitive payload by default.

Action registry rejects collisions between custom and generated names. Workflow definitions follow D-02 (likely fail boot if nonempty in MVP).

## Tests and success criteria

### Graph/service tests

- Randomized plugin input permutations produce the same valid topological order.
- Diamond dependencies initialize once in dependency-before-dependent order.
- Missing dependency, self-cycle, multi-node cycle, duplicate plugin, duplicate service, and unavailable service fail before `init` side effects.
- A dependent plugin can consume its dependency service in `init`; an undeclared/unavailable service access fails clearly.
- Disposal runs once in reverse order after partial initialization failure.

### Lifecycle tests

- A phase recorder observes exactly the specified seven-phase ordering.
- Two concurrent `boot()` calls execute initialization once and receive the same outcome.
- `boot()` after ready is idempotent; boot after failed/stopped follows a documented policy (recommended reject).
- Failure injected into every phase cleans up preceding resources and does not start later phases.
- Stop during active execution stops admission first, waits for work within deadline, then closes worker/storage/ingress; repeated stop is harmless.

### Registry/hook tests

- Generated/custom action and entity-name collisions are rejected with owners named.
- Three hook handlers execute in deterministic order; first veto prevents later handlers and transaction callback observes rollback.
- Hook traces record success/veto/latency with fake clock and redact supplied sensitive values.
- Empty workflow registry boots; nonempty workflow gets the D-02 approved behavior.
- Compiled manifest and registries are immutable after ready.

Phase 3 passes when a transport-free kernel boots against both storage adapters, lifecycle fault-injection tests are green, and no plugin-domain logic appears in core.