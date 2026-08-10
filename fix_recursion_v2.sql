-- Drop the recursive policy
drop policy if exists "Office read all profiles" on profiles;

-- Drop the original own-profile policy too, to start fresh
drop policy if exists "Users read own profile" on profiles;

-- Use a SECURITY DEFINER function to avoid recursion.
-- The function runs as the table owner, not as the user, so RLS doesn't apply to it.
create or replace function public.is_office(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles
    where id = uid and role = 'office'
  );
$$;

-- Now create policies using the function
create policy "Users read own profile" on profiles for select using (
  id = auth.uid()
);

create policy "Office read all profiles" on profiles for select using (
  public.is_office(auth.uid())
);