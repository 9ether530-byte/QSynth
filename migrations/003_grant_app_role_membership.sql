-- SET ROLE requires the connecting role to be a member of the target role.
-- 002 created qsynth_app and granted it table privileges, but never granted
-- membership to the role the platform actually connects as — so `SET LOCAL ROLE
-- qsynth_app` failed with 42501.
--
-- The connecting role is whatever the platform's DATABASE_URL uses (neondb_owner
-- today), so derive it rather than hardcoding it: the same migration then works if
-- the project is ever migrated to Aurora, where the role name differs.

do $$
begin
  execute format('grant qsynth_app to %I', current_user);
end $$;
