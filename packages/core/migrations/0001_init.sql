-- @embody/core — initial schema.
-- Owns the `core` Postgres schema: identity, shared entities, and the registry.
-- Every business table carries org_id and is protected by Row-Level Security so a
-- tenant can never read another tenant's rows (Decision D1). Migrations run as the
-- OWNER role, which bypasses RLS; the api-server's non-owner app role is subject to it.

create schema if not exists core;

-- ---------------------------------------------------------------------------
-- Identity (control plane)
-- ---------------------------------------------------------------------------

create table core.orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  created_at timestamptz not null default now()
);

create table core.users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  name       text,
  created_at timestamptz not null default now()
);

create table core.memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references core.orgs(id) on delete cascade,
  user_id    uuid not null references core.users(id) on delete cascade,
  role       text not null default 'member',
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index memberships_org_idx  on core.memberships (org_id);
create index memberships_user_idx on core.memberships (user_id);

-- ---------------------------------------------------------------------------
-- Shared entities (referenced by every app via facets — Decision D3)
-- ---------------------------------------------------------------------------

create table core.parties (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.orgs(id) on delete cascade,
  kind          text not null check (kind in ('person', 'organization')),
  display_name  text not null,
  custom_fields jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index parties_org_idx    on core.parties (org_id);
create index parties_cf_gin     on core.parties using gin (custom_fields);

create table core.products (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.orgs(id) on delete cascade,
  sku           text,
  name          text not null,
  custom_fields jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index products_org_idx on core.products (org_id);
create index products_cf_gin  on core.products using gin (custom_fields);

create table core.documents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.orgs(id) on delete cascade,
  title         text not null,
  uri           text,
  custom_fields jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index documents_org_idx on core.documents (org_id);

-- ---------------------------------------------------------------------------
-- The thin registry: pointers to typed rows, powering global search, the
-- cross-plugin relationship graph, and audit (Decision D2).
-- ---------------------------------------------------------------------------

create table core.entities (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.orgs(id) on delete cascade,
  type          text not null,                 -- e.g. 'crm.deal', 'core.party'
  source_schema text not null,
  source_table  text not null,
  source_id     uuid not null,
  display_label text not null default '',
  search_vector tsvector generated always as (to_tsvector('simple', coalesce(display_label, ''))) stored,
  created_at    timestamptz not null default now(),
  unique (source_schema, source_table, source_id)
);
create index entities_org_type_idx on core.entities (org_id, type);
create index entities_search_gin   on core.entities using gin (search_vector);

create table core.entity_relationships (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references core.orgs(id) on delete cascade,
  from_entity_id uuid not null references core.entities(id) on delete cascade,
  to_entity_id   uuid not null references core.entities(id) on delete cascade,
  kind           text not null,                -- e.g. 'deal_for_account'
  created_at     timestamptz not null default now(),
  unique (org_id, from_entity_id, to_entity_id, kind)
);
create index rel_from_idx on core.entity_relationships (from_entity_id);
create index rel_to_idx   on core.entity_relationships (to_entity_id);

create table core.audit_log (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references core.orgs(id) on delete cascade,
  entity_id     uuid references core.entities(id) on delete set null,
  action        text not null,                 -- 'create' | 'update' | 'delete'
  actor_user_id uuid references core.users(id) on delete set null,
  diff          jsonb not null default '{}'::jsonb,
  at            timestamptz not null default now()
);
create index audit_org_idx    on core.audit_log (org_id);
create index audit_entity_idx on core.audit_log (entity_id);

-- ---------------------------------------------------------------------------
-- Row-Level Security. Policies read current_setting('app.current_org'), which the
-- app sets per-transaction via withTenant(). Unset => NULL => fail closed (no rows).
-- ---------------------------------------------------------------------------

-- Helper: the current tenant, or NULL if unset.
create or replace function core.current_org() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.current_org', true), '')::uuid $$;

-- orgs: you only see your own org.
alter table core.orgs enable row level security;
create policy tenant_isolation on core.orgs
  using (id = core.current_org())
  with check (id = core.current_org());

-- users: visible only if a member of the current org.
alter table core.users enable row level security;
create policy tenant_members on core.users
  using (exists (
    select 1 from core.memberships m
    where m.user_id = users.id and m.org_id = core.current_org()
  ));

-- memberships and every shared entity: isolated by org_id.
alter table core.memberships          enable row level security;
alter table core.parties              enable row level security;
alter table core.products             enable row level security;
alter table core.documents            enable row level security;
alter table core.entities             enable row level security;
alter table core.entity_relationships enable row level security;
alter table core.audit_log            enable row level security;

create policy tenant_isolation on core.memberships
  using (org_id = core.current_org()) with check (org_id = core.current_org());
create policy tenant_isolation on core.parties
  using (org_id = core.current_org()) with check (org_id = core.current_org());
create policy tenant_isolation on core.products
  using (org_id = core.current_org()) with check (org_id = core.current_org());
create policy tenant_isolation on core.documents
  using (org_id = core.current_org()) with check (org_id = core.current_org());
create policy tenant_isolation on core.entities
  using (org_id = core.current_org()) with check (org_id = core.current_org());
create policy tenant_isolation on core.entity_relationships
  using (org_id = core.current_org()) with check (org_id = core.current_org());
create policy tenant_isolation on core.audit_log
  using (org_id = core.current_org()) with check (org_id = core.current_org());
