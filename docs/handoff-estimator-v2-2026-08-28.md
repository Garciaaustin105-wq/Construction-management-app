# Handoff — Quick Estimator v2 (measurement map redesign)

**Date:** 2026-08-28 · **Owner:** user verdict → redesign required
**Status:** NOT STARTED · Priority: TOP lawn feature
**Shipped draft being replaced:** `ff6d74f` (/estimates/quick + QuickQuoteForm + LawnMeasurementMap) — live on both prods. **Do not polish it; the interaction model is rejected.**

---

## 0. User verdict (the requirement source)

> "I do not like it and it's very confusing for the user."

Five concrete complaints — every task below traces to one:

| # | Pain | Verdict |
|---|------|---------|
| 1 | **No different areas** — one polygon per property | Must support MULTIPLE named areas (front / back / beds / etc.), each measured separately |
| 2 | **No color codes** | Each area gets its own color, visible at a glance |
| 3 | **Finicky tap-and-drag points** | Drawing vertices is unreliable/frustrating — needs forgiving UX |
| 4 | **Hard to find the feature** | Must be a TOP-of-nav / prominent entry, not buried inside estimate creation |
| 5 | **No pricing intelligence** | Estimator should gather web data to help price the yard based on the work to be accomplished |

Strategic context: this is the LawnVex counter (see memory `lowvoltage-lawn-competitive-roadmap` — polygon-draw-on-Maps → area → rate-card). It is the speed-to-quote wedge vs LawnVex/GorillaDesk. Treat as the headline feature, not a utility.

---

## 1. Task split (Claude-direct vs Opus/local-AI)

Per the standing delegation split ([[lowvoltage-opus-heavy-delegation]]):

**Claude-direct (do NOT delegate):**
- The SQL migration (schema below) — write + run on prod `avmqteevisqxwmmxkrbg` **after user approval** (prod DDL always requires explicit user OK).
- `src/lib/estimateAreas.ts` contract FIRST (types + helpers) so Opus builds against it.
- Any server route (e.g. web-pricing suggest endpoint).
- navItems.ts entry + any gate changes.

**Opus / local-AI (delegate):**
- The drawing surface component (biggest chunk).
- The area sidebar/list UI.
- QuickQuoteForm v2 wiring.

**Open decision needed from user before Task 5 (pricing data):** where web pricing comes from — live AI research per quote (Anthropic API, already keyed) vs a curated regional rate table. Recommend starting with AI-research-on-demand (no new data dependency), cached per region/zip.

---

## 2. Schema contract (Claude-direct writes; run AFTER user approves)

```sql
-- estimate_areas.sql (draft — do not run without user sign-off)
create table if not exists public.estimate_areas (
  id uuid primary key default gen_random_uuid(),
  estimate_id uuid not null references public.estimates(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,                       -- "Front yard", "Back beds"
  color text not null default '#22c55e',    -- hex; auto-assigned, editable
  polygon jsonb not null,                   -- [{lat,lng}, ...] ≥3 points
  area_sqft numeric not null default 0,     -- computed at save (spherical)
  service_type text,                        -- optional per-area override
  notes text,
  created_at timestamptz not null default now()
);
alter table public.estimate_areas enable row level security;
-- RLS: SELECT org-subquery pattern; ALL tier_office_or_pm (same as
-- rup_purchases in compliance_reviews_items.sql)
create index on public.estimate_areas (estimate_id);
```

Gotchas that apply (learned the hard way in this repo):
- Root-table insert must send `organization_id` (no set_org trigger pattern on new tables — mirror rup_purchases).
- RLS reads = `organization_id in (select organization_id from public.profiles where id = auth.uid())`; writes = `tier_office_or_pm(organization_id)` SECURITY DEFINER helper (exists — reuse, do not recreate).
- No FK between tables that lack a real FK → never embed; two-step `.in(...)`.
- Run through Supabase MCP `apply_migration`; the auto-mode classifier will deny prod DDL — ask the user via AskUserQuestion first (established pattern).

---

## 3. UI spec (Opus builds against the contract)

### 3a. Entry point (pain #4)
- Prominent **"Measure & quote"** button: TOP of the Lawn tab home (/lawn) and dashboard quick-actions — above Estimates, first action. Also keep /estimates/quick working as its landing page (rename copy to "Measure & quote").
- Nav: it is a headline feature — do not bury it. If a dedicated route (/lawn/measure) reads cleaner than a modal, prefer the route.

### 3b. Drawing UX (pains #2, #3) — the core redo
- Use Google Maps **Drawing library** or custom polygon overlay: add `drawing` to the `googleMaps.ts` loader libraries (currently `["places","geometry"]`).
- **Forgiving vertices:** large draggable handles (≥20px hit area), tap-edge-to-insert-point, long-press or dedicated button to delete a vertex, undo (and redo) stack.
- Live sqft readout while drawing (`google.maps.geometry.spherical.computeArea` — geometry lib already loaded).
- **Colors:** 8-color palette, auto-cycled per new area; swatch shown everywhere the area appears.
- **Multiple areas (pain #1):** "Add area" → next polygon gets next color; areas are independent polygons. Sidebar list: color swatch + name (editable inline) + sqft + delete. Tap a list row → map pans/fits that polygon.
- Mobile-first: this is used standing in a driveway on a phone. Touch targets big; no hover-dependent controls.

### 3c. Pricing (pain #5 — Phase 2, needs user decision)
- Per-area line item: service type pick (from lawn_services) + org rate card × area sqft.
- Suggested-price assist: research regional rate ranges for the selected work (mow / trim / cleanup / aeration…). v1 candidate: `/api/estimates/pricing-suggest` calling Anthropic (ANTHROPIC_API_KEY is set on both deploys) with org region + work types, returning a range the user accepts/edits. Cache per (region, service) to bound cost. Mark AI suggestions visually as "suggested" — never auto-fill silently.

### 3d. Data flow
- Quick quote flow: create/choose estimate → draw areas → per-area items → totals → existing estimate → invoice → convert pipeline (871c082) unchanged downstream.
- Keep `/estimates/quick` numbering + 23505 retry behavior from QuickQuoteForm v1 — that part was fine; it's the map UX that failed.

---

## 4. Files (current state, for reference)

- `src/app/estimates/quick/page.tsx` + `QuickQuoteForm.tsx` — v1 to be replaced/absorbed
- `src/components/LawnMeasurementMap.tsx` — current finicky drawing; replace interaction model, keep loadGoogleMaps usage
- `src/lib/lawnMeasurement.ts` — measurement helpers; extend, don't break (estimates/[id] map imports it)
- `src/lib/googleMaps.ts` — loader; ADD "drawing" library
- `src/lib/chemicals.ts`, `LawnPropertyDetails.tsx`, `SchedulingTools.tsx` — component style references (section cards, busy-ids, toasts, dynamic browser client import)
- Local-AI delegation pipeline + recurring AI-output bugs to review for: `"use server"` on pages, `.single()`/`.maybeSingle()` on lists, `React.` without import, shared-helper cross-contamination, U+2011 mojibake, `catch (e: any)` — see memory `lowvoltage-estimator-handoff-execution`.

---

## 5. Verification gate (before push)

1. `npx tsc --noEmit` + `npm run build` green.
2. Browser-E2E on prod (the standing 🔴): draw 2+ areas, rename, recolor, delete a vertex, undo, verify sqft vs a known lot, per-area line items roll into the total, entry button reachable from Lawn tab in ≤1 tap.
3. Push = deploys BOTH prods (construction + lawn) — user GO required (established pattern).

## 6. NOT in scope
- Turf-segmentation AI auto-trace (LawnVex's approach) — manual polygon v2 first.
- Customer-facing measurement portal.
- Route optimization (deferred separately).

Related memory: `lowvoltage-quick-estimator-redesign` (the verdict record).