-- Terra Vista — public invoice delivery (share_token + sent_at).
-- ----------------------------------------------------------------------------
-- Invoices today are created on approval / cycle billing but never SENT to the
-- customer, and there's no public link to view one — only estimates have a
-- share_token + public /q/{token} view. This adds the same two columns to
-- invoices so a public /invoices/view/{token} page (service role, token = only
-- credential) and a delivered-to-customer flow can work exactly like estimates:
--   • share_token  — a uuid minted when the invoice is first delivered; the
--     public view resolves the invoice by it (no auth).
--   • sent_at      — timestamp of the last successful delivery (email/SMS); null
--     until at least one channel actually delivered, preserving "sent means
--     delivered" (mirrors estimates.sent_at).
--
-- Additive + idempotent only (no DROP). No RLS change — the public view reads
-- via the service role, so RLS is bypassed by design (same as /q/{token}).
-- Passes scripts/check-migrations.mjs. Safe to re-run.
--
-- Run BEFORE deploy (paste from a text editor / Notepad — the SQL Editor mangles
-- pasted single quotes into double quotes). Single-quoted literals only.
-- ============================================================================

alter table public.invoices
  add column if not exists share_token uuid;

alter table public.invoices
  add column if not exists sent_at timestamptz;

-- Lookup-by-token index (partial — only rows that have a token are looked up).
create index if not exists idx_invoices_share_token
  on public.invoices (share_token)
  where share_token is not null;