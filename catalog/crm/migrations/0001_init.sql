-- @embody/crm — initial schema.
-- Owns the `crm` Postgres schema. `crm.deals` is an app facet that references shared
-- parties in `core` (Decision D3 — one party, many app facets). Every row carries
-- org_id and is protected by RLS (Decision D1); migrations run as the OWNER role.

create schema if not exists crm;

create table crm.deals (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.orgs(id) on delete cascade,
  -- The account/contact this deal is for: a shared party in core.
  party_id      uuid references core.parties(id) on delete set null,
  title         text not null,
  stage         text not null default 'lead',
  amount        numeric(14, 2),
  custom_fields jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index deals_org_idx     on crm.deals (org_id);
create index deals_party_idx   on crm.deals (party_id);
create index deals_cf_gin      on crm.deals using gin (custom_fields);

-- Row-Level Security: isolate by org_id, reading the per-transaction tenant set by
-- withTenant() via core.current_org(). Unset => NULL => fail closed (no rows).
alter table crm.deals enable row level security;
create policy tenant_isolation on crm.deals
  using (org_id = core.current_org())
  with check (org_id = core.current_org());
