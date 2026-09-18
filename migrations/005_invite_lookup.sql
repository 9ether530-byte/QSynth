-- ---------------------------------------------------------------------------
-- 005: resolving an email address to a user id when adding a member.
--
-- Adding someone to an organization requires finding their account, but by design
-- RLS makes users outside your active org invisible. auth_user_by_email() would work
-- and is already granted — but it returns the password hash and salt, and handing
-- those to code that has no business with them is how they end up in a log line.
--
-- This function returns the two fields the invite path actually needs. It is still an
-- email-existence oracle, which is why the route behind it requires member:write
-- (admin or owner) and is audited.
-- ---------------------------------------------------------------------------

create or replace function find_user_for_invite(p_email text)
  returns table (user_id uuid, name text)
  language sql stable security definer set search_path = public
  as $$
    select u.id, u.name from users u where u.email_lower = lower(p_email)
  $$;

grant execute on function find_user_for_invite(text) to qsynth_app;
