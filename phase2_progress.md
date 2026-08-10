# Phase 2 SQL Progress

## ✅ Done in public schema
- quotes table
- quote_line_items table
- invoices table
- invoice_line_items table
- All FKs:
  - quotes.job_id → jobs.id
  - quotes.customer_id → customers.id
  - quote_line_items.quote_id → quotes.id
  - invoices.quote_id → quotes.id
  - invoices.job_id → jobs.id
  - invoices.customer_id → customers.id
  - invoice_line_items.invoice_id → invoices.id
- Indexes (quotes_job_id_idx, quotes_customer_id_idx, quote_line_items_quote_id_idx, invoices_job_id_idx, invoices_customer_id_idx, invoices_status_idx, invoice_line_items_invoice_id_idx)
- Partial unique index: invoices_quote_id_unique on invoices(quote_id) where quote_id is not null
- RLS enabled on all 4 tables
- Policies:
  - quotes: office_quotes_all, crew_quotes_select, customer_quotes_select
  - quote_line_items: office_quote_line_items_all, crew_quote_line_items_select, customer_quote_line_items_select
  - invoices: office_invoices_all, customer_invoices_select
  - invoice_line_items: office_invoice_line_items_all, customer_invoice_line_items_select
- is_office() function exists ✓

## ⏳ Remaining (just one thing)
- approve_quote RPC — body in /lowvoltage-app/phase2_approve_quote.sql

## 🐛 Issue
Chat paste is corrupting words (exception→except, default→defaul, null→nu). Workaround next session: load the .sql file via Supabase SQL Editor "Open file" button or pipe via Bash + psql.

## Next session plan
1. Open `phase2_approve_quote.sql` in Supabase SQL Editor using file upload
2. Run it
3. Verify with: select * from pg_proc where proname = 'approve_quote';
4. Test the app: customer approve flow on /quotes/[id]
