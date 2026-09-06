-- Pallet coverage and install labor for the sod catalogue.
--
-- WHY THIS WAS URGENT: every sod product had sqft_per_pallet = 0, which makes
-- the sod calculator unusable rather than merely unpriced. Pallet count is
-- sqft / sqft_per_pallet, so a zero there does not produce a cautious estimate,
-- it produces no estimate at all. Unlike a price, this is not something the
-- estimator can shrug off and fill in later — the feature does not work.
--
-- SQFT PER PALLET = 450, and it is an ASSUMPTION the UI states out loud with a
-- per-job override, which is why a single figure is safe to seed. Published
-- pallet coverage runs 400-500 sqft for warm-season slab sod (bermuda, zoysia,
-- St. Augustine, centipede, bahia — 16x24 in slabs at 2.66 sqft each) and
-- 400/450/500 for cool-season mini-roll pallets. It genuinely varies by farm
-- with harvest method, moisture and soil, so the honest figure is the middle of
-- the published range plus a visible override, not fake precision per variety.
-- Large rolls (103x42 in, ~360 sqft) are a different product; set the override
-- when buying those.
--
-- INSTALL MINUTES PER 1000 SQFT = 420, i.e. 7 man-hours per 1000 sqft, about
-- 143 sqft per man-hour. Published production rates:
--
--     275 sqft/man-hour   best case, short carry (800 sqft barrowed 30 ft)
--     125-167 sqft/man-hr flat accessible 1000 sqft lawn, 6-8 man-hours
--     83-100 sqft/man-hr  irregular shape or difficult soil, 10-12 man-hours
--     100 sqft/man-hour   worst case cited (750 sqft carried up 20 flights)
--
-- 420 sits at the middle of the accessible band. The spread is nearly 3x and it
-- is driven by CARRY DISTANCE AND ACCESS more than by grass type, which is why
-- this is seeded uniformly rather than per variety — varying it by grass would
-- imply the app knows something it does not.
--
-- WHAT THESE MINUTES COVER: laying, fitting around obstacles, edge cutting and
-- rolling. NOT soil prep, tilling, grading, or old-turf removal. Those are
-- separate labor lines and folding them in here would either double-count them
-- or hide them.
--
-- THESE ARE A STARTING POINT, and the sources are unanimous that borrowed
-- production rates are the wrong long-term answer: time your own next three
-- installs and log sod, planting, mulch and edging separately. The app already
-- collects crew time entries. See docs/labor-production-rates.md.
--
-- Sources (fetched 2026-09-05): lawnsite.com sod install production threads,
-- Sod Solutions and The Grass Outlet pallet coverage, homeguide/Angi sod
-- labor-hour ranges.
--
-- Only rows still at 0 are touched, so an org that has already tuned its own
-- figures keeps them. Re-runnable.

do $$
declare
  v_org uuid := '600d02fa-fae2-440b-99ab-42e96997da91'; -- Terra Verde Test Co
begin
  update public.sod_products
     set sqft_per_pallet = 450
   where organization_id = v_org
     and sqft_per_pallet = 0;

  update public.sod_products
     set install_minutes_per_1000_sqft = 420
   where organization_id = v_org
     and install_minutes_per_1000_sqft = 0;
end $$;
