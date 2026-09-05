-- Install labor for landscape estimates.
--
-- WHY THIS EXISTS: lawn maintenance and landscape installs price labor in
-- fundamentally different ways, and the app only modelled the first one.
--
--   Lawn maintenance — a crew of 3 hits 15 properties in a day. You price the
--   PROPERTY ($/sq ft), not the hour. Crew size drives scheduling capacity, not
--   the quote. This is what lawn_services.price_per_sqft already does.
--
--   Landscape install — a project priced in MAN-HOURS. Two people for six
--   hours is twelve man-hours. A 30 gal tree is ~1.5 man-hours; a 1 gal shrub
--   is five minutes. You cannot quote the job without estimating that up front,
--   so labor has to be a catalogue number, not only an after-the-fact actual.
--
-- Before this, `cost` on a plant size was material only and the margin it
-- produced was material margin — which overstates profit worst on exactly the
-- items where labor dominates (big trees). This closes that.
--
-- WHERE THE RATE LIVES: on the estimate, not the org. Chosen deliberately —
-- landscape jobs vary (subbed-out crews, access, season), and `estimates`
-- already carries per-estimate financial settings (markup_pct, contingency_pct,
-- tax_pct, deposit_pct), so this follows an established pattern rather than
-- inventing an org-settings surface.
--
-- TWO rates, not one, because the customer-facing quote shows labor as its own
-- line item:
--   labor_rate       — what you BILL per man-hour. Appears on the quote.
--   labor_cost_rate  — what a man-hour COSTS you, burdened. Internal only.
-- That pair maps exactly onto estimate_line_items.unit_price / internal_cost,
-- so jobProfitability (src/lib/insights.ts) computes labor margin with no new
-- machinery — the same trick the plant catalogue already uses for material.
--
-- Both nullable: a construction estimate and a mow-only lawn estimate have no
-- use for them, and a NOT NULL default of 0 would render as "$0/hr" rather
-- than "not set", which is the difference between a missing number and a
-- wrong one.
--
-- Idempotent and additive: ADD COLUMN IF NOT EXISTS only, no DROP.

alter table public.plant_product_sizes
  add column if not exists install_minutes integer not null default 0;

comment on column public.plant_product_sizes.install_minutes is
  'MAN-minutes to install one of these, not clock-minutes: two people for ten minutes is 20. Per size because a 30 gal tree and a 1 gal shrub are not remotely the same job. 0 means not estimated, and the UI must show that as unset rather than as free.';

alter table public.estimates
  add column if not exists labor_rate numeric;

comment on column public.estimates.labor_rate is
  'What this estimate BILLS per man-hour for landscape install labor. Customer-facing: it becomes the unit_price of the labor line item. Null = not a labor-priced estimate (construction, or mow-only lawn).';

alter table public.estimates
  add column if not exists labor_cost_rate numeric;

comment on column public.estimates.labor_cost_rate is
  'What a man-hour actually COSTS this org, burdened (wage + tax + insurance + equipment). Internal only — becomes internal_cost on the labor line so jobProfitability reports true labor margin. Never shown to a customer.';
