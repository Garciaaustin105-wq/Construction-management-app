-- Check prerequisites for Phase 2 schema
select 'table' as kind, table_schema, table_name
from information_schema.tables
where table_name in ('jobs', 'customers', 'profiles')
union all
select 'function' as kind, n.nspname as table_schema, p.proname as table_name
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'is_office'
order by 1, 3;
