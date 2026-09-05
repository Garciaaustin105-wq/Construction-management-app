-- Remember the labor numbers so nobody retypes them on every quote.
--
-- WHAT WAS ALREADY REMEMBERED: install_minutes lives on plant_product_sizes,
-- so "30 gal Live Oak = 90 man-minutes" is entered once in the catalogue and
-- reused by every estimate forever. That half was always the design.
--
-- WHAT WAS NOT: labor_rate, labor_cost_rate and mobilization_hours went on the
-- estimate, so they started blank on every new quote. Correct for flexibility,
-- useless for speed — and an estimator who has to retype their rate will
-- eventually leave it blank, which quotes labor at nothing.
--
-- So: org-level DEFAULTS that a new estimate prefills from, with the estimate
-- keeping its own columns as the override. Nothing is computed or derived —
-- a person types these once and can change them per job.
--
-- PREFILL, DO NOT REFERENCE. The estimate stores its own copy when it is
-- created. Changing the org default later must not reprice a quote that has
-- already gone out — the same snapshot rule the plant catalogue follows, and
-- for the same reason.
--
-- WHY NOT AUTO-SAVE THE LAST VALUE USED: one unusual job poisons the default
-- forever. A three-day out-of-town install with 9 mobilization hours would
-- silently become the starting point for the next mow-and-go quote. The
-- default changes when someone deliberately says "save this as my default",
-- not as a side effect of estimating one odd job.
--
-- All nullable: a construction org and a mow-only lawn org have no use for
-- these, and null reads as "not set" where 0 would read as "free".
--
-- Idempotent and additive: ADD COLUMN IF NOT EXISTS only, no DROP.

alter table public.organizations
  add column if not exists default_labor_rate numeric;

comment on column public.organizations.default_labor_rate is
  'Org default for what a landscape install BILLS per man-hour. Prefills estimates.labor_rate on a new estimate; the estimate keeps its own copy so changing this never reprices a quote already sent.';

alter table public.organizations
  add column if not exists default_labor_cost_rate numeric;

comment on column public.organizations.default_labor_cost_rate is
  'Org default for what a man-hour COSTS, burdened. Prefills estimates.labor_cost_rate. Internal only — never shown to a customer.';

alter table public.organizations
  add column if not exists default_mobilization_hours numeric;

comment on column public.organizations.default_mobilization_hours is
  'Org default for fixed MAN-hours per job: drive both ways, unload, setup, cleanup, haul-off. Prefills estimates.mobilization_hours. Typical local job; an estimator raises it for distance or a multi-day install.';
