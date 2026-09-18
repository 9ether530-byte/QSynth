-- QSYNTH v1 — initial schema.
--
-- TENANT ISOLATION MODEL
-- ----------------------
-- Every tenant table has `org_id` and runs under ENABLE + FORCE ROW LEVEL SECURITY.
-- FORCE is the load-bearing word: without it the table owner (which is the role our
-- connection string uses) silently bypasses every policy, and isolation would look
-- configured while not existing. Policies read `app.current_org`, set per transaction
-- with SET LOCAL by withOrgTx(). When the setting is absent, current_setting(...,true)
-- returns NULL, the comparison is NULL, and no rows match — the failure mode is
-- "see nothing", never "see everything".
--
-- Three authentication lookups cannot supply an org up front, because resolving the
-- org is precisely what they do: session-by-token, api-key-by-hash, and user-by-email
-- at login. Rather than weaken RLS for those tables, they go through the narrow
-- SECURITY DEFINER functions at the bottom of this file. Those four functions are the
-- ONLY sanctioned RLS bypass in the system; each takes a secret (or an email plus a
-- password the caller must then verify) and returns a fixed, minimal row shape.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Session context helpers
-- ---------------------------------------------------------------------------

create or replace function app_org() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.current_org', true), '')::uuid $$;

create or replace function app_user() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.current_user', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

create table users (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  email_lower     text generated always as (lower(email)) stored,
  name            text not null,
  password_hash   text not null,
  password_salt   text not null,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz
);
create unique index users_email_lower_key on users (email_lower);

create table organizations (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text not null,
  plan         text not null default 'free',
  data_region  text not null default 'us-east-1',
  created_at   timestamptz not null default now()
);
create unique index organizations_slug_key on organizations (slug);

create table memberships (
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  role       text not null check (role in ('owner', 'admin', 'developer', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on memberships (user_id);

create table sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text,
  ip         text
);
create unique index sessions_token_hash_key on sessions (token_hash);
create index sessions_user_idx on sessions (user_id);

create table api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  created_by   uuid references users(id) on delete set null,
  name         text not null,
  prefix       text not null,               -- first chars, shown in UI; never sufficient to authenticate
  hashed_key   text not null,
  scopes       text[] not null default '{}',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
create unique index api_keys_hashed_key_key on api_keys (hashed_key);
create index api_keys_org_idx on api_keys (org_id);

-- ---------------------------------------------------------------------------
-- Projects and specifications
-- ---------------------------------------------------------------------------

create table projects (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  description text not null default '',
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index projects_org_idx on projects (org_id, created_at desc);

create table specs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  name         text not null,
  kind         text not null check (kind in ('boolean', 'truthtable', 'python')),
  source       text not null,
  budgets      jsonb not null default '{}'::jsonb,
  content_hash text not null,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index specs_project_idx on specs (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Compilation
-- ---------------------------------------------------------------------------

create table compile_jobs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  project_id         uuid not null references projects(id) on delete cascade,
  spec_id            uuid not null references specs(id) on delete cascade,
  spec_hash          text not null,
  status             text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'rejected')),
  seed               bigint not null,
  compiler_version   text not null,
  optimization_level smallint not null default 1,
  error_code         text,
  error_message      text,
  created_by         uuid references users(id) on delete set null,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz
);
create index compile_jobs_project_idx on compile_jobs (project_id, started_at desc);
create index compile_jobs_spec_idx on compile_jobs (spec_id, started_at desc);

-- Append-only state transitions (spec FR-7: job state is never overwritten in place).
create table compile_job_events (
  id         bigserial primary key,
  org_id     uuid not null references organizations(id) on delete cascade,
  job_id     uuid not null references compile_jobs(id) on delete cascade,
  from_status text,
  to_status  text not null,
  at         timestamptz not null default now(),
  detail     jsonb not null default '{}'::jsonb
);
create index compile_job_events_job_idx on compile_job_events (job_id, id);

create table compile_stages (
  id            bigserial primary key,
  org_id        uuid not null references organizations(id) on delete cascade,
  job_id        uuid not null references compile_jobs(id) on delete cascade,
  ordinal       smallint not null,
  stage         text not null,
  status        text not null check (status in ('ok', 'failed', 'skipped')),
  duration_ms   integer not null default 0,
  error_code    text,
  error_message text,
  detail        jsonb not null default '{}'::jsonb
);
create unique index compile_stages_job_ordinal_key on compile_stages (job_id, ordinal);

-- ---------------------------------------------------------------------------
-- Artifacts (content-addressed; bytes live in S3 at artifacts/<content_hash>)
-- ---------------------------------------------------------------------------

create table artifacts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  kind         text not null check (kind in (
                 'classical_ir', 'reversible_ir', 'quantum_ir', 'qasm3',
                 'verification_report', 'resource_estimate', 'trace')),
  content_hash text not null,
  storage_uri  text not null,
  size_bytes   integer not null,
  created_at   timestamptz not null default now()
);
-- Identical content within an org is stored once (spec FR-7 dedup).
create unique index artifacts_org_hash_key on artifacts (org_id, content_hash);

create table compile_job_artifacts (
  org_id      uuid not null references organizations(id) on delete cascade,
  job_id      uuid not null references compile_jobs(id) on delete cascade,
  artifact_id uuid not null references artifacts(id) on delete cascade,
  kind        text not null,
  primary key (job_id, kind)
);
create index compile_job_artifacts_artifact_idx on compile_job_artifacts (artifact_id);

create table circuit_versions (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  project_id        uuid not null references projects(id) on delete cascade,
  spec_id           uuid not null references specs(id) on delete cascade,
  job_id            uuid not null references compile_jobs(id) on delete cascade,
  version           integer not null,
  parent_version_id uuid references circuit_versions(id) on delete set null,
  created_at        timestamptz not null default now()
);
create unique index circuit_versions_spec_version_key on circuit_versions (spec_id, version);

-- ---------------------------------------------------------------------------
-- Verification and estimation
-- ---------------------------------------------------------------------------

-- The export gate reads `passed` from this table server-side. It is the sole
-- authority on whether an artifact may leave the system.
create table verification_reports (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  job_id       uuid not null references compile_jobs(id) on delete cascade,
  passed       boolean not null,
  method       text not null check (method in ('exhaustive', 'sampled')),
  sample_count integer,
  seed         bigint not null,
  checks       jsonb not null,
  created_at   timestamptz not null default now()
);
create unique index verification_reports_job_key on verification_reports (job_id);

create table resource_estimates (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  job_id          uuid not null references compile_jobs(id) on delete cascade,
  qubits          integer not null,
  ancillas        integer not null,
  depth           integer not null,
  gate_count      integer not null,
  two_qubit_count integer not null,
  t_count         integer not null,
  t_depth         integer not null,
  created_at      timestamptz not null default now()
);
create unique index resource_estimates_job_key on resource_estimates (job_id);

-- ---------------------------------------------------------------------------
-- Audit, idempotency, rate limiting
-- ---------------------------------------------------------------------------

create table audit_logs (
  id              bigserial primary key,
  org_id          uuid not null references organizations(id) on delete cascade,
  actor_user_id   uuid references users(id) on delete set null,
  actor_api_key_id uuid references api_keys(id) on delete set null,
  action          text not null,
  resource_type   text not null,
  resource_id     text,
  ip              text,
  user_agent      text,
  metadata        jsonb not null default '{}'::jsonb,
  ts              timestamptz not null default now()
);
create index audit_logs_org_ts_idx on audit_logs (org_id, ts desc);

create table idempotency_keys (
  org_id          uuid not null references organizations(id) on delete cascade,
  key             text not null,
  request_hash    text not null,
  response_status integer,
  response_body   jsonb,
  state           text not null default 'in_progress' check (state in ('in_progress', 'complete')),
  created_at      timestamptz not null default now(),
  primary key (org_id, key)
);

create table rate_limit_buckets (
  org_id       uuid not null references organizations(id) on delete cascade,
  subject      text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (org_id, subject, window_start)
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

-- Tables keyed purely by org_id: the policy is uniform, so apply it in a loop
-- rather than repeating 14 near-identical blocks that could drift apart.
do $$
declare t text;
begin
  foreach t in array array[
    'api_keys', 'projects', 'specs', 'compile_jobs', 'compile_job_events',
    'compile_stages', 'artifacts', 'compile_job_artifacts', 'circuit_versions',
    'verification_reports', 'resource_estimates', 'audit_logs',
    'idempotency_keys', 'rate_limit_buckets'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I on %I using (org_id = app_org()) with check (org_id = app_org())',
      t || '_tenant', t);
  end loop;
end $$;

-- organizations: reachable when it is the active org, or when the caller is a member
-- (needed to list "your organizations" before an active org has been chosen).
alter table organizations enable row level security;
alter table organizations force row level security;
create policy organizations_tenant on organizations
  using (
    id = app_org()
    or exists (select 1 from memberships m where m.org_id = organizations.id and m.user_id = app_user())
  );
create policy organizations_insert on organizations for insert with check (true);
create policy organizations_update on organizations for update
  using (id = app_org()) with check (id = app_org());

-- memberships: the active org's roster, plus the caller's own rows across orgs.
alter table memberships enable row level security;
alter table memberships force row level security;
create policy memberships_tenant on memberships
  using (org_id = app_org() or user_id = app_user())
  with check (org_id = app_org());

-- users: yourself, plus anyone sharing your active org (member lists need names).
alter table users enable row level security;
alter table users force row level security;
create policy users_visible on users for select
  using (
    id = app_user()
    or exists (select 1 from memberships m where m.user_id = users.id and m.org_id = app_org())
  );
create policy users_self_update on users for update
  using (id = app_user()) with check (id = app_user());

-- sessions: only your own. Creation happens in a SECURITY DEFINER function
-- (at login there is no session context yet to authorise the insert).
alter table sessions enable row level security;
alter table sessions force row level security;
create policy sessions_own on sessions
  using (user_id = app_user()) with check (user_id = app_user());

-- audit_logs are append-only: no update or delete policy exists, so both are
-- refused for every caller regardless of role.
create policy audit_logs_no_update on audit_logs for update using (false);
create policy audit_logs_no_delete on audit_logs for delete using (false);

-- ---------------------------------------------------------------------------
-- The only sanctioned RLS bypass: four narrow authentication entry points.
-- Each requires a secret the caller must already hold, and returns a fixed,
-- minimal shape. None of them accept an org_id or return another org's data.
-- ---------------------------------------------------------------------------

-- Look up a live session by the SHA-256 of its bearer token.
create or replace function auth_session(p_token_hash text)
  returns table (session_id uuid, user_id uuid, expires_at timestamptz)
  language sql stable security definer set search_path = public
  as $$
    select s.id, s.user_id, s.expires_at
    from sessions s
    where s.token_hash = p_token_hash
      and s.revoked_at is null
      and s.expires_at > now()
  $$;

-- Look up a live API key by the SHA-256 of the presented key.
create or replace function auth_api_key(p_hashed_key text)
  returns table (key_id uuid, org_id uuid, scopes text[])
  language sql stable security definer set search_path = public
  as $$
    select k.id, k.org_id, k.scopes
    from api_keys k
    where k.hashed_key = p_hashed_key
      and k.revoked_at is null
      and (k.expires_at is null or k.expires_at > now())
  $$;

-- Fetch the credential material for an email so the caller can verify a password.
-- Returns the hash and salt only; verification happens in the application.
create or replace function auth_user_by_email(p_email text)
  returns table (user_id uuid, password_hash text, password_salt text, name text)
  language sql stable security definer set search_path = public
  as $$
    select u.id, u.password_hash, u.password_salt, u.name
    from users u
    where u.email_lower = lower(p_email)
  $$;

-- Registration: creates user + organization + owner membership atomically.
-- Needed as a definer function because none of the three inserts has an
-- authenticated context to authorise it yet.
create or replace function register_user(
  p_email text, p_name text, p_password_hash text, p_password_salt text,
  p_org_name text, p_org_slug text
) returns table (user_id uuid, org_id uuid)
  language plpgsql security definer set search_path = public
  as $$
  declare v_user uuid; v_org uuid;
  begin
    insert into users (email, name, password_hash, password_salt)
      values (p_email, p_name, p_password_hash, p_password_salt)
      returning id into v_user;
    insert into organizations (name, slug) values (p_org_name, p_org_slug)
      returning id into v_org;
    insert into memberships (org_id, user_id, role) values (v_org, v_user, 'owner');
    return query select v_user, v_org;
  end $$;

-- Session creation at login (no session context exists yet to satisfy the policy).
create or replace function create_session(
  p_user_id uuid, p_token_hash text, p_expires_at timestamptz,
  p_user_agent text, p_ip text
) returns uuid
  language sql security definer set search_path = public
  as $$
    insert into sessions (user_id, token_hash, expires_at, user_agent, ip)
    values (p_user_id, p_token_hash, p_expires_at, p_user_agent, p_ip)
    returning id
  $$;
