-- custom-crm — initial schema.
-- A CUSTOMER customization living in custom/, extending the CRM without editing core or
-- the first-party apps. It owns its own Postgres schema (`custom_acme`) and adds an audit
-- table for HIPAA reviews of healthcare-vertical deals. Every row carries org_id and is
-- protected by RLS (Decision D1); the FK to crm.deals demonstrates the cross-app graph
-- (this plugin depends on `crm`, so its schema exists before this migration runs).

create schema if not exists custom_acme;

create table custom_acme.hipaa_reviews (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references core.orgs(id) on delete cascade,
  deal_id     uuid not null references crm.deals(id) on delete cascade,
  reviewer    text not null default 'system',
  note        text,
  reviewed_at timestamptz not null default now(),
  unique (org_id, deal_id)
);
create index hipaa_reviews_org_idx  on custom_acme.hipaa_reviews (org_id);
create index hipaa_reviews_deal_idx on custom_acme.hipaa_reviews (deal_id);

-- Row-Level Security: isolate by org_id, reading the per-transaction tenant set by
-- withTenant() via core.current_org(). Unset => NULL => fail closed (no rows).
alter table custom_acme.hipaa_reviews enable row level security;
create policy tenant_isolation on custom_acme.hipaa_reviews
  using (org_id = core.current_org())
  with check (org_id = core.current_org());
