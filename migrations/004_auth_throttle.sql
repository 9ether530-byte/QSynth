-- ---------------------------------------------------------------------------
-- 004: throttling for the unauthenticated auth endpoints.
--
-- rate_limit_buckets is keyed by org_id, which the login and register endpoints do
-- not have — at that point there is no tenant yet, and for a failed login there may
-- never be one. Rather than widen that table (and weaken its RLS policy to admit
-- NULL-org rows), this is a separate table reachable only through a SECURITY DEFINER
-- function. The application role gets EXECUTE on the function and no rights at all on
-- the table, so a pre-auth caller can increment a counter but cannot read or clear one.
--
-- Subjects are opaque strings supplied by the caller: 'login:<sha256(email)>' and
-- 'register:<ip>'. Hashing the email keeps a table of attempted addresses from
-- accumulating in a place that is, by design, readable without authentication.
-- ---------------------------------------------------------------------------

create table auth_throttle (
  subject      text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (subject, window_start)
);

create index auth_throttle_window_idx on auth_throttle (window_start);

revoke all on auth_throttle from public;

-- Returns the count within the current window *after* recording this attempt.
-- The caller compares it against its own limit; the function deliberately holds no
-- policy of its own, so limits can change without a migration.
create or replace function auth_throttle_hit(p_subject text, p_window_seconds integer)
  returns integer
  language plpgsql security definer set search_path = public
  as $$
  declare v_count integer;
  begin
    insert into auth_throttle (subject, window_start, count)
    values (
      p_subject,
      to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds),
      1
    )
    on conflict (subject, window_start) do update set count = auth_throttle.count + 1
    returning count into v_count;

    -- Opportunistic pruning: old windows are never read again.
    delete from auth_throttle where window_start < now() - interval '1 day';

    return v_count;
  end $$;

grant execute on function auth_throttle_hit(text, integer) to qsynth_app;
