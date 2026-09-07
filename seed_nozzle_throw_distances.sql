-- Manufacturer throw distances for the seeded nozzles that had none.
--
-- WHY THIS IS SEEDED WHEN PRICES ARE NOT: a throw distance is a published
-- manufacturer FACT, the same argument the Rain Bird catalogue was seeded on.
-- A Hunter PGJ with a #3.0 nozzle throws 31 ft at 40 psi in Florida and in
-- Colorado. Price is a business decision; radius is physics plus a chart.
--
-- THE "54 MISSING NOZZLES" WAS A MISLEADING NUMBER, and taking it apart is most
-- of the value here:
--
--   12  drip and bubbler rows. Dripline emits along the tube and an emitter
--       wets the ground it sits on. Radius 0 is CORRECT on these and must never
--       be filled. radiusUnset() now excludes them, so a drip-only plan stops
--       reporting a missing figure that does not exist.
--    8  strip and corner nozzles. These throw a RECTANGLE — a Hunter side strip
--       is roughly 4 ft by 30 ft. A single radius cannot describe that shape, so
--       these are not "missing a number", they are the wrong model for one.
--       Left at 0 deliberately; coverage for them needs a different primitive.
--   34  rotors and rotary nozzles genuinely missing a figure.
--
-- Of those 34, seven could be sourced. The rest are recorded below as still
-- open rather than guessed: a throw distance is a physical claim, and a wrong
-- one draws coverage that is not there.
--
-- PRESSURE IS THE POINT, not just the radius. rated_psi says what the figure was
-- measured at, and min_psi is where the nozzle stops working — below it a rotor
-- stops rotating and a spray breaks into mist, so adjustedRadius() REFUSES to
-- return a distance rather than quoting a shorter one. Those columns existed
-- unselected for days; this is the first data in them.
--
-- WHERE min_psi COULD NOT BE SOURCED IT IS LEFT NULL. A guessed minimum makes
-- the refusal fire at the wrong threshold, which is worse than it not firing.
--
-- Sources (fetched 2026-09-07):
--   Hunter PGJ performance card, via irrigationtutorials.com's reproduction of
--     the 30/40/50 psi columns. Minimum 30 psi, optimum 40 psi.
--   Hunter MP Rotator published radius ranges (MP3500 31-35 ft,
--     MP800SR 6-12 ft), seeded at the top of the range exactly as the Rain Bird
--     adjustable nozzles were — that is what they throw opened up, and spacing
--     dials them down.
--
-- STILL OPEN, because their per-nozzle charts are in manufacturer PDFs that
-- return 403 or binary: Toro T5 (8), K-Rain PROPLUS (7), Irritrol 700 (6),
-- Toro Precision rotating (3), K-Rain RCW (3). The catalogue screen now takes
-- rated_psi and min_psi alongside the throw, so an org can enter the brand it
-- actually stocks rather than waiting on all five.
--
-- Only rows still at 0 are touched, so an org that has already entered its own
-- figures keeps them. Re-runnable.

do $$
declare
  v_org uuid := '600d02fa-fae2-440b-99ab-42e96997da91'; -- Terra Verde Test Co
  v_pgj uuid;
begin
  select id into v_pgj from public.irrigation_products
   where organization_id = v_org and name = 'Hunter PGJ';

  -- PGJ ships a full three-point chart, so `performance` is populated too. With
  -- it present adjustedRadius() INTERPOLATES Hunter's own published numbers
  -- instead of scaling from a single figure — reading the chart, not modelling.
  update public.irrigation_product_nozzles n set
    radius_ft = v.r40, rated_psi = 40, min_psi = 30, performance = v.perf
  from (values
    ('#1.0', 19, '[{"psi":30,"radius_ft":18},{"psi":40,"radius_ft":19},{"psi":50,"radius_ft":19}]'::jsonb),
    ('#1.5', 22, '[{"psi":30,"radius_ft":21},{"psi":40,"radius_ft":22},{"psi":50,"radius_ft":22}]'::jsonb),
    ('#2.0', 25, '[{"psi":30,"radius_ft":24},{"psi":40,"radius_ft":25},{"psi":50,"radius_ft":25}]'::jsonb),
    ('#3.0', 31, '[{"psi":30,"radius_ft":30},{"psi":40,"radius_ft":31},{"psi":50,"radius_ft":31}]'::jsonb),
    ('#4.0', 34, '[{"psi":30,"radius_ft":33},{"psi":40,"radius_ft":34},{"psi":50,"radius_ft":34}]'::jsonb)
  ) as v(nozzle, r40, perf)
  where n.irrigation_product_id = v_pgj
    and n.nozzle = v.nozzle
    and n.radius_ft = 0;

  -- MP Rotator: published ranges, no minimum sourced.
  update public.irrigation_product_nozzles n set
    radius_ft = v.r, rated_psi = 40
  from (values
    ('MP3500', 35),
    ('MP800SR short radius', 12)
  ) as v(nozzle, r)
  where n.organization_id = v_org
    and n.nozzle = v.nozzle
    and n.radius_ft = 0;
end $$;
