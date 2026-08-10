-- Drop the recursive policy
drop policy if exists "Office read all profiles" on profiles;

-- Add role to app_metadata on each user so we can read it from JWT
update auth.users
set raw_app_meta_data = raw_app_meta_data || jsonb_build_object('role', 'office')
where id = '40b34e11-79f8-426a-b7c4-ad635e52e549';

update auth.users
set raw_app_meta_data = raw_app_meta_data || jsonb_build_object('role', 'crew')
where id = '68836060-8e32-49df-a0b9-c1a771c19478';

update auth.users
set raw_app_meta_data = raw_app_meta_data || jsonb_build_object('role', 'customer')
where id = 'ab40476f-95aa-42fd-9fc1-ef616011e050';

-- Now create the policy using JWT (no recursion since JWT is in request context, not in profiles table)
create policy "Office read all profiles" on profiles for select using (
  (auth.jwt() -> 'app_metadata' ->> 'role') = 'office'
  or id = auth.uid()
);