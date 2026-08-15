-- password_resets.sql — single-use bearer reset tokens (cross-device password reset)
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS: Supabase's built-in recovery flow is PKCE — the email link
-- carries only a `code`, and finishing it needs a `code_verifier` stored in a
-- COOKIE on the device that requested the reset. Click the link on a different
-- device / browser / the installed PWA and the exchange fails ("reset link is
-- invalid or has expired"). PKCE is inherently same-device.
--
-- This table backs a custom flow where the proof of intent lives ENTIRELY in
-- the emailed link: a 256-bit random token whose sha256 hash is stored here.
-- Clicking https://<prod>/reset-password?token=<raw> on ANY device lets the
-- server look the hash up, claim it (single-use, race-safe), and set a new
-- password via the service-role admin API — no PKCE, no code_verifier cookie,
-- no session required. See src/app/api/forgot-password + /reset-password +
-- /api/reset-password.
--
-- Security: only the HASH is stored (a DB leak can't replay), tokens are
-- 256-bit random + 15-min expiry + single-use + RLS-with-no-policies (only the
-- service role touches this table; anon/authenticated read nothing).
--
-- Additive + idempotent. No DROP/CHECK/RPC — passes scripts/check-migrations.mjs.
-- Run in the Supabase SQL Editor (paste via Notepad so quotes survive). Re-run
-- is safe.
-- ----------------------------------------------------------------------------
begin;

create table if not exists public.password_resets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  token_hash  text not null,                       -- sha256 hex of the raw token
  expires_at  timestamptz not null,                -- now() + 15 min at insert
  used_at     timestamptz,                          -- null = not yet consumed
  created_at  timestamptz not null default now()
);

-- One live token per hash; lookup path is always by token_hash.
create unique index if not exists password_resets_token_hash_idx
  on public.password_resets (token_hash);

-- Belt-and-suspenders: no app code reads this with the anon key (only the
-- service role in server routes), but enabling RLS with no policies means an
-- anon/authenticated client could never read or mint tokens even if a route
-- were miswired. The service role bypasses RLS.
alter table public.password_resets enable row level security;

-- (No policies created — service role only.)

commit;

-- ── Verify (run manually after) ───────────────────────────────────────────
-- select count(*) from public.password_resets;            -- 0 (or prior rows)
-- select relrowsecurity from pg_class where relname = 'password_resets';  -- true