-- Diagnose: list tables and check for invoices
select table_schema, table_name
from information_schema.tables
where table_name = 'invoices';
