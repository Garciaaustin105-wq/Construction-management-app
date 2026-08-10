-- Verify the 4 tables exist after step 1
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('quotes', 'quote_line_items', 'invoices', 'invoice_line_items')
order by table_name;
