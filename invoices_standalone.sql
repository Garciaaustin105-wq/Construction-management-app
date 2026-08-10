-- Allow standalone invoices (created without a quote).

alter table public.invoices
  alter column quote_id drop not null;

alter table public.invoices
  drop constraint if exists invoices_quote_id_key;

create unique index if not exists invoices_quote_id_unique
  on public.invoices(quote_id)
  where quote_id is not null;
