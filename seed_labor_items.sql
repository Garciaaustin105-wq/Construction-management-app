-- Starter list of labor lines. Research: docs/labor-production-rates.md.
--
-- WHAT IS SEEDED: the NAME, the CATEGORY and the UNIT. Nothing else.
--
-- WHAT IS NOT SEEDED: cost, price and man-minutes, all left at zero. These are
-- the org's own numbers and the app must not put a figure in the field. The
-- published research is exposed as SUGGESTIONS shown beside the field —
-- LABOR_BENCHMARKS in src/lib/laborItems.ts — where it can be judged and
-- ignored. A suggestion is not a default, and a default is what turns someone
-- else's crew speed into your quote.
--
-- The unit IS seeded, because a unit is not an opinion. Mulch is bought and
-- spread by the cubic yard whoever you are; only the rate differs. Getting the
-- unit right is also the thing the estimator cannot easily check later —
-- a wrong rate looks wrong, a wrong unit looks fine and is off by 9x or 1000x.
--
-- THE DOUBLE-COUNT RULE, and it is why there is no 'sod install' or 'planting'
-- row here: sod, plant and irrigation labor are already priced by their own
-- catalogues. A row here that repeats one of them bills the same man-hours
-- twice. REMOVAL is a different task from installation and does belong here.
--
-- msqft rows are per THOUSAND square feet. The UI must feed measured square
-- footage through toMsqft() rather than asking anyone to type thousands —
-- entering 5000 in an MSF field is a thousand-fold error that looks correct.
--
-- Re-runnable: guarded on (organization_id, name). Never overwrites an org's
-- own edits, and never fills a value it left blank.

do $$
declare
  v_org uuid := '600d02fa-fae2-440b-99ab-42e96997da91'; -- Terra Verde Test Co
begin
  insert into public.labor_items (organization_id, name, category, unit, notes)
  select v_org, x.name, x.category, x.unit, x.notes
  from (values
    -- ── Bed preparation ───────────────────────────────────────────────────
    ('Bed preparation - till and amend', 'bed_prep', 'sqft', null),
    ('Soil amendment - compost incorporated', 'bed_prep', 'cubic_yard', null),
    ('Weed barrier fabric - install', 'bed_prep', 'sqft', null),
    ('Topsoil - spread and rake', 'bed_prep', 'cubic_yard', null),

    -- ── Mulch ─────────────────────────────────────────────────────────────
    ('Hardwood mulch - spread', 'mulch', 'cubic_yard',
     'Carry distance and bed obstacles move this more than anything else.'),
    ('Pine bark mulch - spread', 'mulch', 'cubic_yard', null),
    ('Pine straw - spread', 'mulch', 'each',
     'Per BALE, not per yard - pine straw is bought by the bale.'),
    ('Decorative rock - spread', 'mulch', 'ton',
     'Sold by weight, not volume. Heavier work than mulch for the same coverage.'),

    -- ── Edging ────────────────────────────────────────────────────────────
    ('Bed edging - spade cut', 'edging', 'foot', null),
    ('Steel edging - install', 'edging', 'foot', null),
    ('Paver or block edging - install', 'edging', 'foot', null),

    -- ── Grading ───────────────────────────────────────────────────────────
    ('Rough grading', 'grading', 'sqft', null),
    ('Fine grading and rake out', 'grading', 'sqft', null),
    ('Slope correction / regrade', 'grading', 'sqft', null),

    -- ── Demolition and removal ────────────────────────────────────────────
    -- Removal is NOT the same task as installation, so these do not duplicate
    -- the sod or plant catalogues.
    ('Turf removal - sod cutter', 'demolition', 'sqft', null),
    ('Shrub removal', 'demolition', 'each', null),
    ('Small tree removal - under 6 in caliper', 'demolition', 'each',
     'Larger trees are specialist work and are not a line on a landscape estimate.'),
    ('Concrete or paver removal', 'demolition', 'sqft', null),
    ('Old irrigation removal', 'demolition', 'foot', null),

    -- ── Haul off and disposal ─────────────────────────────────────────────
    ('Debris haul off', 'haul_off', 'cubic_yard', null),
    ('Dump / tipping fee', 'haul_off', 'job',
     'Usually a pass-through. Put the fee in cost and mark up or not as you choose.'),
    ('Spoil removal from trenching', 'haul_off', 'cubic_yard', null),

    -- ── Drainage ──────────────────────────────────────────────────────────
    ('French drain - trench, fabric, stone and pipe', 'drainage', 'foot', null),
    ('Surface drain pipe - install', 'drainage', 'foot', null),
    ('Downspout tie-in', 'drainage', 'each', null),
    ('Catch basin - install', 'drainage', 'each', null),

    -- ── Cleanup ───────────────────────────────────────────────────────────
    ('Final cleanup and blow off', 'cleanup', 'job', null),
    ('Daily site cleanup', 'cleanup', 'hour', null),

    -- ── Weeding ───────────────────────────────────────────────────────────
    ('Hand weeding', 'weeding', 'hour',
     'Billed by the hour precisely because it does not estimate well.'),

    -- ── Seeding and turf treatment ────────────────────────────────────────
    -- Per THOUSAND square feet. Feed measured sqft through toMsqft().
    ('Overseed - broadcast', 'seeding', 'msqft', null),
    ('Hydroseed', 'seeding', 'msqft', null),
    ('Seed and straw', 'seeding', 'msqft', null),
    ('Core aeration', 'seeding', 'msqft', null),
    ('Fertilizer application', 'seeding', 'msqft', null),

    -- ── Mobilization ──────────────────────────────────────────────────────
    ('Mobilization - crew and equipment to site', 'mobilization', 'job',
     'Charged once per trip, not per day on site.'),
    ('Return trip / second mobilization', 'mobilization', 'job',
     'A phased job or a punch list is a second trip and a second charge.'),

    -- ── Other ─────────────────────────────────────────────────────────────
    ('Permit fee', 'other', 'job', 'Pass-through. Varies by jurisdiction.'),
    ('Dumpster rental', 'other', 'job', null)
  ) as x(name, category, unit, notes)
  where not exists (
    select 1 from public.labor_items c
     where c.organization_id = v_org
       and c.name = x.name
  );
end $$;
