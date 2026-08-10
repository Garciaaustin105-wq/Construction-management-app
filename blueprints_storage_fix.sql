-- Blueprints storage bucket + policies
-- Run this in Supabase SQL Editor

-- 1. Create the bucket (idempotent). public=true so customer portal can render PDFs without signed URLs.
insert into storage.buckets (id, name, public)
values ('blueprints', 'blueprints', true)
on conflict (id) do update set public = excluded.public;

-- 2. Allow office to upload blueprints
drop policy if exists "Office upload blueprints" on storage.objects;
create policy "Office upload blueprints" on storage.objects for insert with check (
  bucket_id = 'blueprints'
  and exists (
    select 1 from profiles
    where id = auth.uid() and role = 'office'
  )
);

-- 3. Allow office to delete blueprints
drop policy if exists "Office delete blueprints" on storage.objects;
create policy "Office delete blueprints" on storage.objects for delete using (
  bucket_id = 'blueprints'
  and exists (
    select 1 from profiles
    where id = auth.uid() and role = 'office'
  )
);

-- 4. Allow anyone to read blueprints (bucket is public)
drop policy if exists "Public read blueprints" on storage.objects;
create policy "Public read blueprints" on storage.objects for select using (
  bucket_id = 'blueprints'
);