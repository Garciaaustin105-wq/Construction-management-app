-- Starter list of irrigation system components — the parts between the water
-- source and the heads. Spec: docs/handoff-ui-lane-d-controls-and-mainline.md §1.
--
-- WHY THIS IS SEEDED, like the Rain Bird catalogue and unlike a plant list:
-- a 1 in inline globe valve is the same part in Florida and Colorado. What an
-- org stocks is regional; what the parts ARE is not. An org keeps the rows it
-- carries and deactivates the rest; nothing needs deleting and nothing is lost.
--
-- PRICES ARE ALL ZERO ON PURPOSE, same reason as every other catalogue here:
-- distributor pricing varies by supplier, region and volume, and inventing
-- numbers would let an org quote plausible-looking figures that are wrong.
-- `unpricedCount` in src/lib/irrigationSystem.ts exists so the UI can flag
-- exactly these rows until someone fills them in.
--
-- INSTALL MINUTES ARE ALSO ZERO, and this is a DEPARTURE from the plant
-- catalogue, where seeding them was justified. The difference is what could be
-- sourced. Plant install time has published, size-banded contractor benchmarks
-- that agree within a factor a crew can tune from (see the d185cdc commit
-- message). For irrigation components there is no equivalent per-part table in
-- the open literature — searching returns consumer cost guides, repair-call
-- times, and all-in figures. The one solid industry rule of thumb is:
--
--     roughly one man per zone per 10-hour day for residential new install
--
-- which is an ALL-IN number covering trenching, pipe, heads, valve and wire
-- together. Splitting that across fifty part rows by guesswork would produce
-- numbers that look sourced and are not, and they would double-count against
-- head install minutes the moment those are filled in. Zero is honest here;
-- the zone rule of thumb belongs in the labor panel, not in this column.
--
-- Tune these from your own crew time entries — the app already collects them.
--
-- TRENCHING IS NOT IN THIS LIST. It is excavation, not a part: the machine
-- belongs in the equipment catalogue and the digging in crew hours. Trenching
-- production is ~10 ft/hour hand-dug and ~300 ft/hour with a trencher, and it
-- moves with soil, roots, utilities and depth more than with anything here.
--
-- CODE CLAIMS: the notes on backflow and rain sensors say to CHECK local code.
-- They do not state what the code requires. Backflow type, mounting height,
-- permitting and annual testing vary by jurisdiction, and rain sensors are
-- required by statute in several states including Florida — but this app must
-- not assert any of that as fact or imply a chosen device is compliant. The
-- notes are org-editable for exactly that reason.
--
-- Sources (fetched 2026-09-05): lawnsite.com contractor threads (zone/man-day
-- rule, trenching production), contractortalk.com trenching production thread,
-- standard residential irrigation practice for the parts list itself.
--
-- Re-runnable: every insert is guarded on (organization_id, name), so running
-- it twice adds nothing and never overwrites an org's own edits.

do $$
declare
  v_org uuid := '600d02fa-fae2-440b-99ab-42e96997da91'; -- Terra Verde Test Co
begin
  insert into public.irrigation_components
    (organization_id, name, category, unit, notes)
  select v_org, x.name, x.category, x.unit, x.notes
  from (values
    -- ── Point of connection ───────────────────────────────────────────────
    ('Point of connection - 1 in tap into service line', 'poc', 'each',
     'Meter size caps total system flow. Confirm the service can carry the design demand.'),
    ('Point of connection - dedicated irrigation meter', 'poc', 'each',
     'Separate meter avoids sewer charges in many districts. Tap fee is usually a separate line.'),
    ('Point of connection - well pump tie-in', 'poc', 'each',
     'Pump curve sets available pressure and flow, not the street main.'),

    -- ── Backflow prevention ───────────────────────────────────────────────
    -- Type and height are set by local code. These rows carry the part only.
    ('Backflow - 3/4 in PVB (pressure vacuum breaker)', 'backflow', 'each',
     'Type, mounting height, permitting and annual testing are set by local code. Check your jurisdiction.'),
    ('Backflow - 1 in PVB (pressure vacuum breaker)', 'backflow', 'each',
     'Type, mounting height, permitting and annual testing are set by local code. Check your jurisdiction.'),
    ('Backflow - 1 in DCVA (double check valve assembly)', 'backflow', 'each',
     'Type, mounting height, permitting and annual testing are set by local code. Check your jurisdiction.'),
    ('Backflow - 1 in RPZ (reduced pressure zone)', 'backflow', 'each',
     'Highest protection and highest pressure loss. Type and testing are set by local code.'),
    ('Backflow - 1.5 in RPZ (reduced pressure zone)', 'backflow', 'each',
     'Highest protection and highest pressure loss. Type and testing are set by local code.'),

    -- ── Master valve and flow sensing ─────────────────────────────────────
    ('Master valve - 1 in', 'master_valve', 'each',
     'Optional. Shuts the mainline when no zone is running, so a mainline break does not run unchecked.'),
    ('Master valve - 1.5 in', 'master_valve', 'each',
     'Optional. Shuts the mainline when no zone is running.'),
    ('Flow sensor - 1 in', 'flow_sensor', 'each',
     'Usually commercial. Needs a controller that can read it.'),
    ('Flow sensor - 1.5 in', 'flow_sensor', 'each',
     'Usually commercial. Needs a controller that can read it.'),

    -- ── Mainline ──────────────────────────────────────────────────────────
    -- Constantly pressurised, so a heavier class than lateral pipe.
    ('Mainline - 1 in Sch 40 PVC', 'mainline', 'foot',
     'Mainline stays under pressure, so it is a heavier class than lateral pipe. Different part, different price.'),
    ('Mainline - 1.25 in Sch 40 PVC', 'mainline', 'foot', null),
    ('Mainline - 1.5 in Sch 40 PVC', 'mainline', 'foot', null),
    ('Mainline - 2 in Sch 40 PVC', 'mainline', 'foot', null),
    ('Mainline - 1 in poly (freeze climates)', 'mainline', 'foot',
     'Poly tolerates freeze-thaw better than PVC where the line cannot be fully drained.'),

    -- ── Lateral pipe ──────────────────────────────────────────────────────
    -- pipeEstimate() in irrigationProducts.ts computes this footage between
    -- placed heads. Before these rows existed there was nothing to price it
    -- against.
    ('Lateral pipe - 3/4 in Class 200 PVC', 'lateral', 'foot',
     'Downstream of the zone valve, so only pressurised while the zone runs. Quantity comes from the pipe estimate.'),
    ('Lateral pipe - 1 in Class 200 PVC', 'lateral', 'foot', null),
    ('Lateral pipe - 3/4 in poly', 'lateral', 'foot', null),
    ('Lateral pipe - 1 in poly', 'lateral', 'foot', null),
    ('Funny pipe / flex riser tubing', 'lateral', 'foot',
     'Flexible run from lateral to head. Sold by the roll, priced here by the foot.'),

    -- ── Drip ──────────────────────────────────────────────────────────────
    -- The Rain Bird seed shipped dripline flagged "priced per foot, not built
    -- yet" because irrigation_products has no unit column. These rows are that
    -- gap closed.
    ('Dripline - 0.6 GPH, 12 in spacing', 'drip', 'foot',
     'Pressure-compensating dripline. Sold and installed by the foot.'),
    ('Dripline - 0.9 GPH, 12 in spacing', 'drip', 'foot', null),
    ('Dripline - 0.9 GPH, 18 in spacing', 'drip', 'foot', null),
    ('Drip distribution tubing - 1/4 in', 'drip', 'foot', null),
    ('Drip zone kit - filter and pressure regulator', 'drip', 'each',
     'Drip needs filtration and a regulator ahead of it. One per drip zone.'),

    -- ── Zone valves ───────────────────────────────────────────────────────
    ('Zone valve - 3/4 in inline globe', 'zone_valve', 'each',
     'One per zone, usually grouped in a manifold.'),
    ('Zone valve - 1 in inline globe', 'zone_valve', 'each', null),
    ('Zone valve - 1 in inline globe with flow control', 'zone_valve', 'each',
     'Flow control lets a zone be throttled at the valve rather than at every head.'),
    ('Zone valve - 3/4 in anti-siphon', 'zone_valve', 'each',
     'Combines valve and backflow protection. Whether it satisfies local code is a jurisdiction question.'),
    ('Zone valve - 1 in anti-siphon', 'zone_valve', 'each', null),

    -- ── Valve boxes ───────────────────────────────────────────────────────
    ('Valve box - 6 in round', 'valve_box', 'each', 'One valve.'),
    ('Valve box - 10 in round', 'valve_box', 'each', null),
    ('Valve box - standard rectangular', 'valve_box', 'each', 'Fits a small manifold.'),
    ('Valve box - jumbo rectangular', 'valve_box', 'each', 'Fits a larger manifold or an RPZ.'),

    -- ── Controllers ───────────────────────────────────────────────────────
    -- Station count is in the name so stationCheck() has something to read.
    ('Controller - 4 station, indoor', 'controller', 'each',
     'Station count must cover the zone valves. Indoor enclosures are not rated for outdoor mounting.'),
    ('Controller - 6 station, indoor/outdoor', 'controller', 'each', null),
    ('Controller - 8 station, outdoor', 'controller', 'each', null),
    ('Controller - 12 station, outdoor', 'controller', 'each', null),
    ('Controller - 16 station, outdoor', 'controller', 'each', null),
    ('Controller - smart WiFi, 8 station', 'controller', 'each',
     'Weather-based scheduling. Needs WiFi reach at the mounting location.'),
    ('Controller - smart WiFi, 16 station', 'controller', 'each', null),

    -- ── Low-voltage wire and splices ──────────────────────────────────────
    -- One common wire plus one station wire per zone.
    ('Low-voltage wire - 18-2 direct burial', 'wire', 'foot',
     'Conductor count must cover one station wire per zone plus a common. Sold and pulled by the foot.'),
    ('Low-voltage wire - 18-5 direct burial', 'wire', 'foot', null),
    ('Low-voltage wire - 18-7 direct burial', 'wire', 'foot', null),
    ('Low-voltage wire - 18-9 direct burial', 'wire', 'foot', null),
    ('Low-voltage wire - 14-1 common, direct burial', 'wire', 'foot',
     'Heavier common wire for long runs.'),
    ('Waterproof wire connector - gel cap (DBY/DBR)', 'connector', 'each',
     'One per splice. Routinely forgotten and cheap to add.'),
    ('Waterproof wire connector - silicone filled, 3 port', 'connector', 'each', null),

    -- ── Sensors ───────────────────────────────────────────────────────────
    ('Rain sensor - wired', 'sensor', 'each',
     'Required by statute in several states including Florida. Check your jurisdiction.'),
    ('Rain sensor - wireless', 'sensor', 'each',
     'Required by statute in several states including Florida. Check your jurisdiction.'),
    ('Freeze / rain sensor - wireless', 'sensor', 'each', null),
    ('Soil moisture sensor', 'sensor', 'each',
     'Waters on soil moisture rather than a fixed schedule. Placement decides whether it reads the zone honestly.'),

    -- ── Sleeving ──────────────────────────────────────────────────────────
    ('Sleeve - 2 in Sch 40 PVC', 'sleeve', 'foot',
     'Under drives and walks. Far cheaper now than cutting concrete later.'),
    ('Sleeve - 3 in Sch 40 PVC', 'sleeve', 'foot', null),
    ('Sleeve - 4 in Sch 40 PVC', 'sleeve', 'foot',
     'Size up so wire and a future line both fit without a second dig.'),

    -- ── Fittings and consumables ──────────────────────────────────────────
    ('Fitting - 1 in Sch 40 tee', 'fitting', 'each', null),
    ('Fitting - 1 in Sch 40 ell', 'fitting', 'each', null),
    ('Fitting - 1 in Sch 40 coupling', 'fitting', 'each', null),
    ('Swing joint - 1/2 in x 6 in', 'fitting', 'each',
     'Lets a head take a mower hit without breaking the lateral.'),
    ('Swing joint - 3/4 in x 12 in', 'fitting', 'each', null),
    ('PVC solvent cement and primer', 'fitting', 'each',
     'Consumable, usually one line per job rather than per joint.'),

    -- ── Electrical side and the rest ──────────────────────────────────────
    ('Pump start relay', 'other', 'each',
     'Needed when the controller has to start a pump rather than open a valve.'),
    ('Ground rod and clamp - controller surge protection', 'other', 'each',
     'Surge protection for the controller. Grounding practice is set by local electrical code.'),
    ('Conduit - 1/2 in PVC, controller to manifold', 'other', 'foot', null),
    ('GFCI outlet for outdoor controller', 'other', 'each',
     'Line-voltage work. Whether a licensed electrician is required is set by local code.'),
    ('Winterization blow-out connection', 'other', 'each',
     'Freeze climates. Fitted at install so the system can be blown out each fall.')
  ) as x(name, category, unit, notes)
  where not exists (
    select 1 from public.irrigation_components c
     where c.organization_id = v_org
       and c.name = x.name
  );
end $$;
