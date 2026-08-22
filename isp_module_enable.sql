-- isp_module_enable.sql
-- ----------------------------------------------------------------------------
-- Turns the ISP / fiber module ON for ONE organization and seeds its install
-- type list. This is the file that actually makes the hidden tab appear.
--
-- ⚠️ RUN isp_module.sql AND isp_module_b.sql FIRST. This file guards on both.
--
-- TARGET ORG: Terra Vista building and development llc
--   id           7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b
--   app_variant  construction
--   plan         pro / active
--   resolved from Austin@terravistabuilding.com (role: admin) on 2026-08-21.
--
-- Matching on ID, not name, on purpose: org names in this database are not
-- reliably distinct — there are already two orgs called "Peanutz L@L" and
-- "Peanutz L&L" (different variants, one character apart). A name match is one
-- typo away from enabling a hidden module on the wrong tenant.
--
-- NOTE for future reference: the ISP module is for Austin's OWN construction
-- org — Terra Vista does the fiber/ISP work — NOT a separate internet-provider
-- tenant. No other org is touched by this file, and no other org can see any of
-- it: isp_module_enabled defaults to false everywhere else.
--
-- Idempotent: re-running changes nothing. Safe to run twice.
-- Run in the Supabase SQL editor — paste from a text editor (Notepad), NOT the
-- web editor (it mangles single quotes).
-- ----------------------------------------------------------------------------

-- ── Guards ─────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.installs') is null
     or to_regclass('public.install_types') is null then
    raise exception 'Run isp_module.sql first';
  end if;
  if to_regclass('public.install_time_entries') is null then
    raise exception 'Run isp_module_b.sql first';
  end if;
  if not exists (
    select 1 from public.organizations
    where id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b'
  ) then
    raise exception 'Target organization 7e3f1a2b-... not found in this project';
  end if;
end $$;


-- ── 1. Enable the module ───────────────────────────────────────────────────
update public.organizations
   set isp_module_enabled = true
 where id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b';


-- ── 2. Seed the install type list ──────────────────────────────────────────
-- A starting point, not a fixed list. These are rows, not a CHECK constraint —
-- rename, reorder, deactivate, or add types in the app afterwards and no
-- migration is ever needed. `active=false` retires a type without breaking
-- installs that already reference it.
insert into public.install_types (organization_id, name, position)
select '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b'::uuid, t.name, t.pos
from (values
  ('Aerial drop',            10),
  ('Underground drop',       20),
  ('Trunk line',             30),
  ('Splice',                 40),
  ('Service call',           50),
  ('Repair',                 60),
  ('Equipment swap',         70),
  ('Disconnect',             80)
) as t(name, pos)
on conflict do nothing;   -- unique (organization_id, lower(name))


-- ----------------------------------------------------------------------------
-- VERIFY
--
--   select name, isp_module_enabled from public.organizations
--   where id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b';
--   -- expect: Terra Vista building and development llc | t
--
--   select count(*) from public.organizations where isp_module_enabled;
--   -- expect: 1   (no other tenant enabled)
--
--   select name, position, active from public.install_types
--   where organization_id = '7e3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b'
--   order by position;
--   -- expect: the 8 rows above, all active
-- ----------------------------------------------------------------------------
