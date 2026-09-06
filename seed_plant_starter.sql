-- Common US landscape plants — a starter catalogue to pick from, not a
-- recommendation of what to plant.
--
-- WHY THIS EXISTS AFTER I ARGUED AGAINST IT: the original objection was that
-- species are regional, so a Florida palm list on a Colorado org is wrong data
-- presented as help. That still holds for RECOMMENDING plants. It does not
-- hold for a broad national list an org picks from, where the ones they do not
-- carry simply go unused. Picking beats typing sixty species from scratch.
--
-- NO HARDINESS ZONES, deliberately. Suitability is the professional's call,
-- and a zone number in this app would imply the app had checked. It has not.
-- An org keeps what it carries and deactivates the rest; nothing needs
-- deleting and nothing is lost.
--
-- PRICES AND INSTALL TIMES ARE ALL ZERO, same as the Rain Bird catalogue and
-- for the same reason: nursery cost is regional and per-supplier, and invented
-- numbers would let someone quote plausible figures that are wrong. Empty is
-- honest; wrong is not.
--
-- SIZES FOLLOW HOW STOCK IS ACTUALLY BOUGHT, which differs by category:
--   trees        small by container, larger by CALIPER inches, often B&B
--   palms        by CLEAR TRUNK feet, never by container
--   shrubs       by container gallons
--   groundcover  by flat or small pot
-- `size` is free text precisely so an org can use whatever its supplier
-- quotes. These are a starting point to re-cut, not a fixed vocabulary.
--
-- Sourced 2026-09-05 from wholesale/nursery popularity lists (GoMaterials
-- commercial landscaping, Arbor Day nursery popularity, Capitol Wholesale best
-- sellers) cross-checked against standard landscape practice.
--
--
-- EXPANSION PASS 2026-09-05: the first list skewed southern/Gulf. A second
-- pass added northern and transition-zone stock (bur/swamp white/willow oak,
-- Norway and Colorado spruce, arborvitae, prairie grasses and native
-- perennials) plus a `vine` category that did not exist before. 161 species
-- and 484 sizes now. The machine-readable list of the expansion lives in
-- seed_plant_expansion.mjs; this file documents the convention and
-- the first pass.
--
-- Re-runnable: a species already present is skipped, so an org's edits survive.

do $$
declare
  v_org uuid := '600d02fa-fae2-440b-99ab-42e96997da91'; -- Terra Verde Test Co
  v_id  uuid;
  r     record;
begin
  for r in
    select * from (values
      ('Red Maple',              'Acer rubrum',                  'tree','#ef4444'),
      ('Sugar Maple',            'Acer saccharum',               'tree','#f97316'),
      ('Japanese Maple',         'Acer palmatum',                'tree','#dc2626'),
      ('Southern Live Oak',      'Quercus virginiana',           'tree','#8b5cf6'),
      ('Northern Red Oak',       'Quercus rubra',                'tree','#7c3aed'),
      ('Eastern Redbud',         'Cercis canadensis',            'tree','#db2777'),
      ('Flowering Dogwood',      'Cornus florida',               'tree','#f472b6'),
      ('Crape Myrtle',           'Lagerstroemia indica',         'tree','#e11d48'),
      ('Southern Magnolia',      'Magnolia grandiflora',         'tree','#65a30d'),
      ('River Birch',            'Betula nigra',                 'tree','#a16207'),
      ('Bald Cypress',           'Taxodium distichum',           'tree','#0d9488'),
      ('Ginkgo',                 'Ginkgo biloba',                'tree','#ca8a04'),
      ('Eastern White Pine',     'Pinus strobus',                'tree','#166534'),
      ('Green Giant Arborvitae', 'Thuja plicata Green Giant',    'tree','#15803d'),
      ('Eastern Red Cedar',      'Juniperus virginiana',         'tree','#14532d'),
      ('Wax Myrtle',             'Myrica cerifera',              'tree','#4d7c0f'),
      ('Sabal Palm',             'Sabal palmetto',               'palm','#a3620a'),
      ('Queen Palm',             'Syagrus romanzoffiana',        'palm','#b45309'),
      ('European Fan Palm',      'Chamaerops humilis',           'palm','#92400e'),
      ('Christmas Palm',         'Adonidia merrillii',           'palm','#c2410c'),
      ('Boxwood',                'Buxus sempervirens',           'shrub','#16a34a'),
      ('Dwarf Yaupon Holly',     'Ilex vomitoria Nana',          'shrub','#22c55e'),
      ('Nellie Stevens Holly',   'Ilex x Nellie R. Stevens',     'shrub','#15803d'),
      ('Loropetalum',            'Loropetalum chinense',         'shrub','#a21caf'),
      ('Indian Hawthorn',        'Rhaphiolepis indica',          'shrub','#ec4899'),
      ('Arrowwood Viburnum',     'Viburnum dentatum',            'shrub','#059669'),
      ('Azalea',                 'Rhododendron spp.',            'shrub','#f43f5e'),
      ('Camellia',               'Camellia japonica',            'shrub','#be123c'),
      ('Glossy Abelia',          'Abelia x grandiflora',         'shrub','#10b981'),
      ('Japanese Spirea',        'Spiraea japonica',             'shrub','#fb7185'),
      ('Podocarpus',             'Podocarpus macrophyllus',      'shrub','#047857'),
      ('Japanese Privet',        'Ligustrum japonicum',          'shrub','#4ade80'),
      ('Gardenia',               'Gardenia jasminoides',         'shrub','#84cc16'),
      ('Hydrangea',              'Hydrangea macrophylla',        'shrub','#3b82f6'),
      ('Cocoplum',               'Chrysobalanus icaco',          'shrub','#0891b2'),
      ('Sweet Pepperbush',       'Clethra alnifolia',            'shrub','#2dd4bf'),
      ('Witch Hazel',            'Hamamelis virginiana',         'shrub','#eab308'),
      ('Shore Juniper',          'Juniperus conferta',           'shrub','#0f766e'),
      ('Muhly Grass',            'Muhlenbergia capillaris',      'grass','#e879f9'),
      ('Fountain Grass',         'Pennisetum alopecuroides',     'grass','#d946ef'),
      ('Maiden Grass',           'Miscanthus sinensis',          'grass','#c026d3'),
      ('Pampas Grass',           'Cortaderia selloana',          'grass','#f5d0fe'),
      ('Daylily',                'Hemerocallis spp.',            'perennial','#fbbf24'),
      ('Lantana',                'Lantana camara',               'perennial','#fb923c'),
      ('Purple Coneflower',      'Echinacea purpurea',           'perennial','#a855f7'),
      ('Black-eyed Susan',       'Rudbeckia fulgida',            'perennial','#facc15'),
      ('African Iris',           'Dietes bicolor',               'perennial','#60a5fa'),
      ('Salvia',                 'Salvia spp.',                  'perennial','#818cf8'),
      ('Liriope',                'Liriope muscari',              'groundcover','#6366f1'),
      ('Asiatic Jasmine',        'Trachelospermum asiaticum',    'groundcover','#06b6d4'),
      ('Mondo Grass',            'Ophiopogon japonicus',         'groundcover','#0ea5e9'),
      ('Creeping Juniper',       'Juniperus horizontalis',       'groundcover','#0284c7')
    ) as x(name, botanical, category, color)
  loop
    select id into v_id from public.plant_products
     where organization_id = v_org and name = r.name;
    continue when v_id is not null;

    insert into public.plant_products (organization_id, name, botanical_name, category, color, notes)
    values (v_org, r.name, r.botanical, r.category, r.color,
            'Starter catalogue - set your own sizes, cost and price.')
    returning id into v_id;

    if r.category = 'tree' then
      -- Small stock by container, larger by caliper. Both conventions appear
      -- because both are how trees are actually quoted.
      insert into public.plant_product_sizes (organization_id, plant_product_id, size, sort_order)
      values (v_org, v_id, '15 gal', 0), (v_org, v_id, '30 gal', 1),
             (v_org, v_id, '2 in cal B&B', 2), (v_org, v_id, '3 in cal B&B', 3);
    elsif r.category = 'palm' then
      -- Palms are bought by clear trunk height, never by container.
      insert into public.plant_product_sizes (organization_id, plant_product_id, size, sort_order)
      values (v_org, v_id, '6 ft CT', 0), (v_org, v_id, '10 ft CT', 1), (v_org, v_id, '16 ft CT', 2);
    elsif r.category = 'shrub' then
      insert into public.plant_product_sizes (organization_id, plant_product_id, size, sort_order)
      values (v_org, v_id, '1 gal', 0), (v_org, v_id, '3 gal', 1), (v_org, v_id, '7 gal', 2);
    elsif r.category in ('grass','perennial') then
      insert into public.plant_product_sizes (organization_id, plant_product_id, size, sort_order)
      values (v_org, v_id, '1 gal', 0), (v_org, v_id, '3 gal', 1);
    else
      insert into public.plant_product_sizes (organization_id, plant_product_id, size, sort_order)
      values (v_org, v_id, '4 in pot', 0), (v_org, v_id, '1 gal', 1), (v_org, v_id, 'flat of 18', 2);
    end if;
  end loop;
end $$;
