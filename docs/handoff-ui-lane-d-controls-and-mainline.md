# HANDOFF — Lane D: controller, valves, backflow, wire and mainline

Everything between the water source and the heads. Today the estimator prices
heads, drip and pipe-between-heads and **nothing else** — so a quote can show
40 sprinklers and omit the controller, the valves, the backflow and every foot
of wire. That is not a small gap; on a residential install it is a large share
of the material.

**Lane D owns a new contract (`src/lib/irrigationSystem.ts`), a new migration,
and the components UI.** It does NOT own `LawnMeasurementMap.tsx` (Lane B) or
`LawnEstimateWorkspace.tsx` (Lane C). If placement on the map is wanted, it
lands in Lane B's file AFTER Lane B is merged — coordinate, do not both edit.

---

## 1. What a system actually contains

Beyond heads and pipe, in the order water and power reach them:

| Part | Unit | Notes |
|---|---|---|
| Point of connection (POC) | each | Tap into the service or a dedicated line. Meter size caps total flow. |
| Backflow preventer | each | PVB / RPZ / DCVA. **Type and installation height are set by local code and often need a permit and a test.** |
| Master valve | each | Optional; shuts the mainline when nothing is running. |
| Flow sensor | each | Optional, usually commercial. |
| Mainline pipe | **foot** | Constantly pressurised, so a heavier class than laterals. Different part, different price. |
| Zone (control) valve | each | One per zone, usually grouped in a manifold. |
| Valve box | each | One per manifold or per valve. |
| Controller / timer | each | Station count must cover the zones. Indoor vs outdoor is a real difference. |
| Low-voltage wire | **foot** | Common wire plus one station wire per zone. |
| Wire connectors | each | Waterproof, one per splice — routinely forgotten and cheap to add. |
| Rain / soil sensor | each | Required by statute in some states, including Florida. |
| Sleeving | **foot** | Under drives and walks. Far cheaper to include now than to cut concrete later. |

**Two units, and that is the shape of the problem.** Heads are per-each; wire,
mainline and sleeving are per-FOOT. The existing irrigation catalogue is
per-each only, which is exactly why dripline had to be flagged "priced per foot,
not built yet".

---

## 2. Schema

New table rather than extending `irrigation_products`: the nozzle table is
model→nozzle two-level and these are flat, and a `unit` column is needed that
would be meaningless on a nozzle.

```sql
create table public.irrigation_components (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  category text not null default 'other',
  -- 'each' | 'foot'. THE reason this table exists separately.
  unit text not null default 'each',
  cost numeric not null default 0,
  unit_price numeric not null default 0,
  install_minutes integer not null default 0,
  -- Free text: "requires permit and annual test in most jurisdictions".
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
```

Categories: `poc, backflow, master_valve, flow_sensor, mainline, zone_valve,
valve_box, controller, wire, connector, sensor, sleeve, fitting, other`.
App-validated, no CHECK — matching every other catalogue here.

Estimate side: `estimate_components (estimate_id, snapshot jsonb, quantity
numeric)`. **Snapshot the component**, same rule as plants, heads, sod and
equipment: re-pricing the catalogue must not move a quote already sent.

RLS on both: `tier_office_or_pm` for writes, `same_org` for reads. Copy the
policies from `irrigation_catalogue.sql` verbatim.

---

## 3. Contract — `src/lib/irrigationSystem.ts`

```ts
listComponents(supabase, orgId, activeOnly?)
createComponent / updateComponent
componentSnapshot(c) / readComponentSnapshot(raw)
componentCharge(snapshot, quantity) -> { cost, revenue, manHours, unit, basis }
systemTotals(lines) -> { cost, revenue, manHours, unpricedCount }
componentLineItem(charge) -> line | null
```

Rules that are not guessable from the types:

- **`unit: 'foot'` means quantity IS feet.** The UI must label the quantity
  field with the unit, or someone enters "2" meaning two rolls.
- Every `*LineItem` returns **null when there is nothing billable** — no `$0`
  line reaches a quote. Same as every other contract here.
- `install_minutes` is MAN-minutes, per unit. For a per-foot component that is
  per FOOT, which is small and adds up: 200 ft of wire at 0.5 man-min/ft is
  100 man-minutes.

### Wire and sleeve length

The map knows where the valves are only if Lane B places them. Until then,
**quantity is typed, not computed** — and that is fine, because wire routing
follows the trench, not a straight line.

If Lane B later places a controller and valves as points, wire length can reuse
the pipe approach: `distanceFt` between controller and each valve, then the
SAME two allowances the pipe panel uses (routing % and waste %), because the
reasoning is identical — a straight line is a floor and the real run follows
the trench. Do not invent a second allowance model.

---

## 4. Zone count — an input, never a computation

The controller must have at least as many stations as there are zones, and
that check is worth surfacing:

> 6 zone valves, controller has 4 stations.

**That is arithmetic on what the estimator entered, and it is the only
system-level check in scope.** Do NOT compute how many zones the property
needs. Zone sizing is available flow ÷ head demand, with pressure loss along
the run, and it is licensed design work. The app counts what was specified; it
does not specify.

---

## 5. Backflow, and the one thing to be careful with

Backflow type, installation height, permitting and annual testing are set by
**local code and vary by jurisdiction**. The catalogue carries the part and its
price. It must not state a code requirement as fact, recommend a type, or imply
a chosen device is compliant.

The honest shape is a `notes` field on the component saying what the installer
already knows — "PVB, typically 12 in above the highest head; check local code
and permitting" — surfaced as text the org itself wrote or edited, never as an
assertion this app makes.

Same for **rain sensors**: required by statute in several states including
Florida. Carry it as a component and let the org note it. Do not have the app
declare the law.

---

## 6. UI

A catalogue screen at `/lawn/irrigation-components` (or a tab on
`/lawn/irrigation` — your call, but do not make Lane A's screen wait on it),
and a panel that adds components to an estimate with a quantity.

Match `PlantCatalogueManager` for structure, and the same rules apply
throughout: **a null or zero price is not a free one**, empty renders empty,
every write busy-gated.

Seed a starter list of the parts in §1 with **prices at zero**, matching the
Rain Bird, plant, sod and equipment catalogues. The parts are the same trade to
trade; the prices are not.

---

## Verify

Commit `e2e-irrigation-components.mjs` at the repo root. Copy the isolation
discipline from `e2e-plant-placement.mjs`: deactivate the org's real catalogue,
scope every delete and REST read to `E2E%` rows, restore on the failure path.
An earlier version of these harnesses wiped a whole org silently.

Cover: per-each and per-foot components price correctly and are labelled with
their unit; `install_minutes` on a per-foot part multiplies by feet; the
station-count check fires when valves exceed stations and not otherwise; a
component with no price is flagged rather than billed at zero; and every
`add to estimate` produces one line with a non-null `internal_cost`.
