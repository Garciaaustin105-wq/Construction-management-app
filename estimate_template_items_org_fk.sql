-- §7 (feature-completeness audit): estimate_template_items.organization_id had
-- no FK — noted in the earlier scalability pass, still open. A template item
-- pointing at a deleted/nonexistent org would dangle. This adds the FK.
--
-- Applied live 2026-08-26. Verified safe before applying: 0 rows in the table
-- (no template items in prod yet) so there are no orphans to reconcile. The
-- column is nullable, so a null organization_id (a platform-default template
-- not scoped to any one org) does NOT violate the FK — null FKs are allowed.
-- ON DELETE CASCADE matches the other org-scoped tables (lawn_visits,
-- recurring_schedules, etc.): an org's templates are meaningless without it.

alter table public.estimate_template_items
  drop constraint if exists estimate_template_items_organization_id_fkey;
alter table public.estimate_template_items
  add constraint estimate_template_items_organization_id_fkey
  foreign key (organization_id) references public.organizations(id)
  on delete cascade;