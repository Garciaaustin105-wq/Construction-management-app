-- Rain Bird starter catalogue for the irrigation estimator.
--
-- WHY THIS IS SEEDED WHEN THE PLANT CATALOGUE DELIBERATELY IS NOT:
-- a Rain Bird 5000 is the same product in Florida and Colorado, and its throw
-- radius is a published manufacturer figure. Plant species and their prices
-- are regional; head specs are not. Seeding manufacturer FACT is help.
--
-- PRICES ARE ALL ZERO ON PURPOSE. Rain Bird does not publish contractor
-- pricing, and it varies by distributor, region and volume. Inventing numbers
-- would let an org quote a job at plausible-looking figures that are wrong,
-- which is worse than an empty field. `unpricedHeads()` in
-- src/lib/irrigationProducts.ts exists so the UI can flag exactly these rows
-- until someone fills them in. install_minutes is zero for the same reason —
-- it is a crew-speed number, not a manufacturer one.
--
-- RADII ARE AT 45 PSI, Rain Bird's recommended operating pressure for these
-- lines. A system running lower throws shorter; the radius column comment says
-- to record it at the pressure the org designs for, so an org on low pressure
-- should adjust these down.
--
-- ADJUSTABLE NOZZLES ARE SEEDED AT THE TOP OF THEIR RANGE. R-VAN14 is 8-14 ft;
-- 14 is recorded, because that is what it throws when opened up, and spacing
-- decisions dial it down. The nozzle name keeps the full range so the number
-- is checkable.
--
-- Sources (fetched 2026-09-05):
--   5000 MPR nozzle trees   rainbird.com/products/5000-series-mpr-nozzles
--   R-VAN rotary nozzles    rainbird.com/products/r-van-rotary-nozzles
--   MPR spray nozzles       rainbird.com/products/mpr-series-fixed-pattern-spray-nozzles
--   VAN spray nozzles       rainbird.com/products/van-series-variable-arc-spray-nozzles
--   Xeri-Bug emitters       rainbird.com/products/xeri-bug-drip-emitters
--
-- Re-runnable: every insert is guarded, so running it twice adds nothing.
-- Set :org to the organization receiving the catalogue.

do $$
declare
  v_org uuid := '600d02fa-fae2-440b-99ab-42e96997da91'; -- Terra Verde Test Co
  v_id  uuid;
begin
  -- ── Rotors ────────────────────────────────────────────────────────────
  -- MPR nozzle trees ship Q/T/H/F (90/120/180/360) per radius. The ARC is
  -- chosen when the head is placed, so one row per radius covers all four.
  select id into v_id from public.irrigation_products
   where organization_id = v_org and name = 'Rain Bird 5000 / 5000 Plus';
  if v_id is null then
    insert into public.irrigation_products (organization_id, name, category, color, notes)
    values (v_org, 'Rain Bird 5000 / 5000 Plus', 'rotor', '#2563eb',
            'Gear-drive rotor. MPR nozzle trees give matched precipitation across 25/30/35 ft. Radii at 45 psi.')
    returning id into v_id;
    insert into public.irrigation_product_nozzles
      (organization_id, irrigation_product_id, nozzle, radius_ft, sort_order)
    values
      (v_org, v_id, 'MPR 25 (Q/T/H/F)', 25, 0),
      (v_org, v_id, 'MPR 30 (Q/T/H/F)', 30, 1),
      (v_org, v_id, 'MPR 35 (Q/T/H/F)', 35, 2);
  end if;

  -- ── Rotary nozzles on spray bodies ────────────────────────────────────
  select id into v_id from public.irrigation_products
   where organization_id = v_org and name = 'Rain Bird R-VAN';
  if v_id is null then
    insert into public.irrigation_products (organization_id, name, category, color, notes)
    values (v_org, 'Rain Bird R-VAN', 'mp_rotator', '#0ea5e9',
            'Adjustable rotary nozzle for 1800 spray bodies. Arc 45-270 adjustable, or fixed 360 variants. 30-55 psi, 45 psi recommended.')
    returning id into v_id;
    insert into public.irrigation_product_nozzles
      (organization_id, irrigation_product_id, nozzle, radius_ft, sort_order)
    values
      (v_org, v_id, 'R-VAN14 (8-14 ft)',  14, 0),
      (v_org, v_id, 'R-VAN18 (13-18 ft)', 18, 1),
      (v_org, v_id, 'R-VAN24 (17-24 ft)', 24, 2),
      (v_org, v_id, 'R-VAN-LCS 5x15 strip', 15, 3),
      (v_org, v_id, 'R-VAN-RCS 5x15 strip', 15, 4),
      (v_org, v_id, 'R-VAN-SST 5x30 strip', 30, 5);
  end if;

  -- ── Fixed spray ───────────────────────────────────────────────────────
  select id into v_id from public.irrigation_products
   where organization_id = v_org and name = 'Rain Bird 1800 + MPR spray';
  if v_id is null then
    insert into public.irrigation_products (organization_id, name, category, color, notes)
    values (v_org, 'Rain Bird 1800 + MPR spray', 'spray', '#7c3aed',
            'Pop-up spray body with fixed-pattern MPR nozzles. Series number is the radius in feet.')
    returning id into v_id;
    insert into public.irrigation_product_nozzles
      (organization_id, irrigation_product_id, nozzle, radius_ft, sort_order)
    values
      (v_org, v_id, '5 Series (Q/H/F)',   5,  0),
      (v_org, v_id, '8 Series (Q/H/F)',   8,  1),
      (v_org, v_id, '10 Series (Q/H/F)', 10,  2),
      (v_org, v_id, '12 Series (Q/H/F)', 12,  3),
      (v_org, v_id, '15 Series (Q/H/F)', 15,  4),
      (v_org, v_id, '15 Strip (L/R/C)',  15,  5);
  end if;

  -- ── Adjustable spray ──────────────────────────────────────────────────
  select id into v_id from public.irrigation_products
   where organization_id = v_org and name = 'Rain Bird 1800 + VAN spray';
  if v_id is null then
    insert into public.irrigation_products (organization_id, name, category, color, notes)
    values (v_org, 'Rain Bird 1800 + VAN spray', 'spray', '#a855f7',
            'Pop-up spray body with variable-arc nozzles. 4/6/8-VAN adjust 0-330 degrees; 10/12/15/18-VAN adjust 0-360.')
    returning id into v_id;
    insert into public.irrigation_product_nozzles
      (organization_id, irrigation_product_id, nozzle, radius_ft, sort_order)
    values
      (v_org, v_id, '8-VAN (6-8 ft)',    8,  0),
      (v_org, v_id, '10-VAN (7-10 ft)', 10,  1),
      (v_org, v_id, '12-VAN (9-12 ft)', 12,  2),
      (v_org, v_id, '15-VAN (11-15 ft)',15,  3),
      (v_org, v_id, '18-VAN',           18,  4);
  end if;

  -- ── Drip emitters ─────────────────────────────────────────────────────
  -- radius_ft is 0 and that is CORRECT: drip wets a basin, not an arc, so it
  -- must draw no coverage circle at all.
  select id into v_id from public.irrigation_products
   where organization_id = v_org and name = 'Rain Bird Xeri-Bug emitter';
  if v_id is null then
    insert into public.irrigation_products (organization_id, name, category, color, notes)
    values (v_org, 'Rain Bird Xeri-Bug emitter', 'drip', '#059669',
            'Pressure-compensating point-source emitter, 15-50 psi. No throw radius: drip wets a basin, so no coverage is drawn.')
    returning id into v_id;
    insert into public.irrigation_product_nozzles
      (organization_id, irrigation_product_id, nozzle, radius_ft, sort_order)
    values
      (v_org, v_id, 'XB-05PC 0.5 GPH (blue)',  0, 0),
      (v_org, v_id, 'XB-10PC 1.0 GPH (black)', 0, 1),
      (v_org, v_id, 'XB-20PC 2.0 GPH (red)',   0, 2);
  end if;

  -- ── Dripline ──────────────────────────────────────────────────────────
  -- Sold and installed PER FOOT. The nozzle table has no unit column yet, so
  -- these are recorded for reference and priced per foot by hand until the
  -- per-foot unit lands. See docs/quick-estimator-roadmap.md.
  select id into v_id from public.irrigation_products
   where organization_id = v_org and name = 'Rain Bird XFD dripline';
  if v_id is null then
    insert into public.irrigation_products (organization_id, name, category, color, notes)
    values (v_org, 'Rain Bird XFD dripline', 'drip', '#0d9488',
            'On-surface dripline, pressure compensating 8.5-60 psi. PRICED PER FOOT, not per each - the per-foot unit is not built yet.')
    returning id into v_id;
    insert into public.irrigation_product_nozzles
      (organization_id, irrigation_product_id, nozzle, radius_ft, sort_order)
    values
      (v_org, v_id, '0.6 GPH, 12 in spacing', 0, 0),
      (v_org, v_id, '0.6 GPH, 18 in spacing', 0, 1),
      (v_org, v_id, '0.9 GPH, 12 in spacing', 0, 2),
      (v_org, v_id, '0.9 GPH, 18 in spacing', 0, 3),
      (v_org, v_id, '0.9 GPH, 24 in spacing', 0, 4);
  end if;
end $$;
