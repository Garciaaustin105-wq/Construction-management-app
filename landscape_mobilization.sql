-- Mobilization: the fixed labor a job costs before anyone plants anything.
--
-- THE BUG THIS FIXES: install_minutes is per-plant, so total labor scaled
-- purely with plant count. A job with one 3 gal shrub quoted 8 minutes. The
-- real day is drive out, unload, set up, plant, clean up, haul off, drive
-- back — call it 90 minutes. The estimator was under-quoting small jobs by an
-- order of magnitude, and small jobs are most of what a lawn company sells.
--
-- At 200 shrubs the overhead vanishes into the noise. At one shrub it IS the
-- job. That asymmetry is why a flat per-item model cannot express it and a
-- fixed term has to exist.
--
-- MAN-hours, like install_minutes: two people driving thirty minutes each way
-- is two man-hours, not one. Easy to get wrong, so the UI label has to say it.
--
-- On the estimate rather than the org, matching the labor_rate decision:
-- mobilization varies with distance, access and season far more than it varies
-- between companies, and `estimates` already carries per-estimate financial
-- settings (markup_pct, contingency_pct, tax_pct, deposit_pct, labor_rate).
--
-- NULLABLE ON PURPOSE, and the app must not coalesce it to 0 silently. Null
-- means "nobody has estimated this" and should warn; 0 means "I considered it
-- and this job genuinely has none" (a crew already on site for another job).
-- Collapsing those two is how the under-quote comes back.
--
-- Multi-day jobs mobilize once per day. This column is the whole-job figure,
-- so a three-day job enters three trips' worth. Deliberately not derived from
-- an estimated day count: that needs a crew size and a working-day model the
-- estimator does not have, and inventing one to save an estimator from
-- multiplying by three is the kind of scope creep the roadmap warns against.
--
-- Idempotent and additive: ADD COLUMN IF NOT EXISTS only, no DROP.

alter table public.estimates
  add column if not exists mobilization_hours numeric;

comment on column public.estimates.mobilization_hours is
  'Fixed MAN-hours a landscape job costs regardless of plant count: drive time both ways, unload, setup, cleanup, debris haul-off. Two people driving 30 min each way is 2 man-hours. Whole-job figure — a 3-day job carries 3 trips. Null means not estimated (warn); 0 means genuinely none (crew already on site).';
