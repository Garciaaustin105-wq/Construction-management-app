-- Phase 1 of the estimator roadmap: let an "area" be a point or a line too.
-- Applied to prod 2026-09-04. See docs/quick-estimator-roadmap.md.
--
-- estimate_areas stores polygons only, which is why the workspace ships with
-- Measure and Items and no Landscape or Legend. The landscape work needs
-- geometry this table cannot express:
--
--   sprinkler head  -> a POINT with a coverage radius
--   pipe / lateral  -> a LINE with a length
--   tree, shrub     -> a POINT with a species
--   mulch bed, sod  -> a polygon (already works)
--
-- Extending this table rather than adding three more keeps rendering, hit
-- testing, undo, save/restore and the estimate join working unchanged — which
-- is the whole reason to do it this way. `polygon` keeps its name and becomes
-- "the coordinate list": one entry for a point, an open list for a line, a
-- closed ring for an area. Renaming it would break every existing row and all
-- the code that reads them for no gain.
--
-- No CHECK on `kind`: repo convention is that the app validates enum-ish
-- columns, so adding a value never needs a migration.
--
-- Idempotent and additive: ADD COLUMN IF NOT EXISTS only, no DROP, no TRUNCATE.
-- Existing rows are all polygons and default to kind='area', so nothing about
-- them changes. Verified after applying: 2 rows, both kind='area', 7,313 sqft
-- preserved, length_ft 0.

alter table public.estimate_areas
  add column if not exists kind text not null default 'area';

comment on column public.estimate_areas.kind is
  'How to read `polygon`: area = closed ring, line = open path, point = single coordinate. App-validated, deliberately not a CHECK.';

alter table public.estimate_areas
  add column if not exists length_ft numeric not null default 0;

comment on column public.estimate_areas.length_ft is
  'Run length for kind=line (pipe, edging, fence). Areas keep using area_sqft; a line has no meaningful area and a point has neither.';

alter table public.estimate_areas
  add column if not exists meta jsonb not null default '{}'::jsonb;

comment on column public.estimate_areas.meta is
  'Per-kind detail with no column of its own: coverage radius and arc for a sprinkler head, species/size for a plant, diameter for a pipe. Kept as jsonb so a new item type does not need a migration.';

-- Kind is the first filter for every landscape query ("all heads on this
-- estimate"), and it is always asked alongside the estimate.
create index if not exists estimate_areas_estimate_kind_idx
  on public.estimate_areas (estimate_id, kind);
