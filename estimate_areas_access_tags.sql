-- estimate_areas_access_tags.sql
-- Office-side half of the "obstacle/access confirmation" differentiator
-- (customer-facing confirmation on /q/[token] is deferred to a later pass).
--
-- Adds estimate_areas.access_tags (mower-access chips picked while drawing,
-- e.g. "narrow gate", "steep slope" — distinct from the existing, compliance-
-- focused lawn_jobs.sensitive_site_tags). Rolls those tags up into the new
-- job's `obstacles` field at conversion time, so the crew sees them via the
-- SAME warning UI they already have (LawnPropertyDetails.tsx) — just fed by
-- data captured earlier, during quoting, instead of only after the sale.
--
-- Replaces convert_estimate_on_invoice_paid() (live, migration
-- lawn_estimator_convert_on_invoice_paid) — every other line of that function
-- is UNCHANGED; only the lawn_jobs insert gains an `obstacles` value.

alter table public.estimate_areas
  add column if not exists access_tags text[] not null default '{}';

CREATE OR REPLACE FUNCTION public.convert_estimate_on_invoice_paid()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_estimate estimates%rowtype;
  v_org organizations%rowtype;
  v_job_id uuid;
  v_schedule_id uuid;
  v_obstacles text;
  li record;
begin
  if new.status = 'paid' and old.status is distinct from 'paid' and new.estimate_id is not null then

    select * into v_estimate from estimates where id = new.estimate_id;

    -- Only convert estimates the customer actually approved, and only once.
    if v_estimate.id is null
       or v_estimate.status = 'converted'
       or v_estimate.status <> 'approved' then
      return new;
    end if;

    select * into v_org from organizations where id = v_estimate.organization_id;

    insert into jobs (organization_id, customer_id, name, address, description, status, type)
    select
      v_estimate.organization_id,
      v_estimate.customer_id,
      coalesce(v_estimate.title, 'Job from estimate ' || coalesce(v_estimate.estimate_number, v_estimate.id::text)),
      c.address,
      v_estimate.note,
      'scheduled',
      v_org.app_variant
    from customers c where c.id = v_estimate.customer_id
    returning id into v_job_id;

    update estimates
      set status = 'converted', converted_at = now(), job_id = v_job_id
      where id = v_estimate.id;

    if v_org.app_variant = 'lawn' then
      -- One line per area that has access tags: "Front yard: narrow gate, irrigation heads".
      select string_agg(a.name || ': ' || array_to_string(a.access_tags, ', '), e'\n')
        into v_obstacles
        from estimate_areas a
        where a.estimate_id = v_estimate.id
          and array_length(a.access_tags, 1) > 0;

      insert into lawn_jobs (id, organization_id, lot_sqft, map_lat, map_lng, obstacles)
      values (v_job_id, v_estimate.organization_id, v_estimate.measured_sqft, v_estimate.map_lat, v_estimate.map_lng, v_obstacles);
    end if;

    for li in
      select * from estimate_line_items
      where estimate_id = v_estimate.id
        and schedule_frequency is not null
        and recurring_schedule_id is null
    loop
      insert into recurring_schedules (
        job_id, organization_id, frequency, interval_weeks, days_of_week,
        day_of_month, start_date, end_date, service_type, price_per_visit, active
      )
      values (
        v_job_id, v_estimate.organization_id, li.schedule_frequency,
        coalesce(li.schedule_interval_weeks, 1), coalesce(li.schedule_days_of_week, '{}'),
        li.schedule_day_of_month, coalesce(li.schedule_start_date, current_date),
        li.schedule_end_date, li.description, li.unit_price, true
      )
      returning id into v_schedule_id;

      update estimate_line_items set recurring_schedule_id = v_schedule_id where id = li.id;
    end loop;
  end if;

  return new;
end;
$function$
