-- @embody/automation — workflow definitions and run history.
--
-- The configurable half of "set a trigger, write a function". A row here says: when
-- `on_event` fires and `conditions` hold, invoke the tool named `action_tool`. The
-- function it names lives in TypeScript, in somebody's plugin — this table only wires
-- things together, which is what keeps it on the right side of Decision D8.

create schema if not exists automation;

create table automation.workflows (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references core.orgs(id) on delete cascade,
  name        text not null,
  description text,
  -- Event name or trailing-wildcard pattern, matched exactly as a subscription is:
  -- "crm.deal.created", "crm.*", "*".
  on_event    text not null,
  -- [{path, op, value}] ANDed; an element may be {any_of: [...]} for OR. Empty = always.
  conditions  jsonb not null default '[]'::jsonb,
  -- Any registered tool. `defineAutomation` actions are the ergonomic case, but a
  -- workflow can drive `crm_update_deal` directly given an input_map.
  action_tool text not null,
  -- NULL means "pass the event envelope", which is what a defineAutomation action
  -- expects. Otherwise a template object: {"dealId": "{{payload.id}}"}.
  input_map   jsonb,
  -- The roles the action runs with. Least privilege per workflow, and never more than
  -- the creator held — enforced in automation_create_workflow, not here, because the
  -- check needs the caller's principal.
  run_as_roles text[] not null default array['member'],
  enabled     boolean not null default true,
  created_by  uuid references core.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, name)
);
create index workflows_lookup_idx on automation.workflows (org_id, on_event) where enabled;

create table automation.runs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references core.orgs(id) on delete cascade,
  workflow_id uuid not null references automation.workflows(id) on delete cascade,
  event_name  text not null,
  -- 'ok' | 'error'. A workflow whose conditions did not match produces no row at all:
  -- a run log full of non-events is a run log nobody reads.
  status      text not null,
  error       text,
  result      jsonb,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index runs_recent_idx on automation.runs (org_id, started_at desc);
create index runs_workflow_idx on automation.runs (workflow_id, started_at desc);

-- Tenant isolation, same rule as every other business table (Decision D1).
alter table automation.workflows enable row level security;
alter table automation.runs      enable row level security;

create policy tenant_isolation on automation.workflows
  using (org_id = core.current_org()) with check (org_id = core.current_org());
create policy tenant_isolation on automation.runs
  using (org_id = core.current_org()) with check (org_id = core.current_org());
