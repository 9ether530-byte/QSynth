-- The application role.
--
-- WHY THIS EXISTS: the platform's connection string authenticates as `neondb_owner`,
-- and that role carries rolbypassrls = true. A BYPASSRLS role ignores row level
-- security entirely — including FORCE ROW LEVEL SECURITY, which only closes the
-- weaker "owner implicitly bypasses" hole. Running application queries as the owner
-- would therefore leave every policy in 001_init.sql decorative.
--
-- So we create a role that cannot bypass RLS, grant it exactly the table privileges
-- the API needs, and have withOrgTx() issue `SET LOCAL ROLE qsynth_app` inside each
-- transaction. SET LOCAL scopes the switch to the transaction, which is safe under
-- connection pooling — the role reverts on COMMIT/ROLLBACK even if a handler throws.
--
-- The four SECURITY DEFINER auth functions remain owned by neondb_owner, so they
-- still reach the identity tables. That is deliberate and is the only bypass path.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'qsynth_app') then
    -- NOLOGIN: unreachable as a connection identity; only arrived at via SET ROLE.
    -- NOBYPASSRLS is the default but is stated explicitly because it is the point.
    create role qsynth_app nologin nobypassrls noinherit;
  end if;
end $$;

grant usage on schema public to qsynth_app;

-- Read/write on tenant data.
grant select, insert, update, delete on
  organizations, memberships, projects, specs,
  compile_jobs, compile_stages, artifacts, compile_job_artifacts,
  circuit_versions, verification_reports, resource_estimates,
  api_keys, sessions, idempotency_keys, rate_limit_buckets
to qsynth_app;

-- users: no DELETE. Account removal is an admin operation, not something an
-- ordinary request path should be able to reach even with a policy bug.
grant select, insert, update on users to qsynth_app;

-- Append-only tables: INSERT and SELECT only. The absence of UPDATE/DELETE here is
-- a second, independent guarantee alongside the "for update using (false)" policies
-- in 001 — a policy mistake alone cannot make audit history mutable.
grant select, insert on audit_logs, compile_job_events to qsynth_app;

grant usage, select on all sequences in schema public to qsynth_app;

-- The controlled RLS-bypass surface.
grant execute on function
  auth_session(text), auth_api_key(text), auth_user_by_email(text),
  register_user(text, text, text, text, text, text),
  create_session(uuid, text, timestamptz, text, text),
  app_org(), app_user()
to qsynth_app;

-- Anything added by a later migration must grant explicitly; no blanket default.
alter default privileges in schema public revoke all on tables from qsynth_app;
