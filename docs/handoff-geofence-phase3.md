# HANDOFF — Phase 3: geofenced auto arrive/depart

**Written 2026-08-31 by Claude Opus 5. Base: `main` @ `4115c0c`.**

Crews should not tap Start and Done at every stop. The phone already streams
position while on shift, and every property already has a map pin — so arrival
and departure can be detected and the visit stamped automatically.

---

## Lanes

| Lane | Files | Owner |
|---|---|---|
| Pure state machine | `src/lib/geofence.ts` | **done — do not edit** |
| Integration | `src/lib/useCrewLocationBroadcast.ts`, `src/components/CrewTrackingMount.tsx` | **YOURS** |
| Office visibility | `src/app/lawn/routes/page.tsx` or `/lawn/track` | yours, if there is room |

`src/lib/geofence.ts` is a pure reducer with a full test suite. Import it; do not
reimplement distance or dwell logic.

```ts
import {
  stepGeofence, initialGeofenceState, GEOFENCE_DEFAULTS,
  type GeoStop, type Fix, type GeofenceState, type GeofenceEvent,
} from "@/lib/geofence";

const { state: next, events } = stepGeofence(state, fix, stops);
// events: { type: "arrive" | "depart"; stopId: string; at: number }[]
```

---

## The research this is built on

Geofencing fails in known ways. These values are chosen, not guessed:

| Parameter | Value | Why |
|---|---|---|
| enter radius | 100 m | Industry guidance is 100–300 m to absorb GPS drift (10–20 m in built-up areas). Residential lots are small, so the low end — larger and you capture the neighbour's property. |
| **exit radius** | **150 m** | **Hysteresis.** Leaving uses a LARGER radius than entering, and the 50 m gap must exceed GPS error. Without this, a truck parked on the boundary flaps arrive/depart forever. This is the single most important parameter. |
| arrive dwell | 90 s | Stops a drive-by opening a visit. Guidance is 30–60 s minimum; a lawn stop is never under a couple of minutes. |
| depart dwell | 180 s | Deliberately longer than arrive: a crew member walking to the truck for a trimmer must not end the visit. |
| accuracy floor | reject > 75 m | A fix with a 200 m accuracy radius cannot tell you which property you are on. Drop it rather than act on it. |

## What to build

### 1. Run the geofence on every fix, while on shift

`useCrewLocationBroadcast` currently starts GPS **only when an office viewer is
present** (the presence gate that keeps the live map cheap).

**That has to change, and it is the one real design decision here.** Auto
arrive/depart must work unattended — arrivals happen all day whether or not
anyone is watching the map. So:

- **GPS runs whenever the crew member is on shift.** Not presence-gated.
- **Broadcasting stays presence-gated.** Do not send Realtime messages when
  nobody is watching — that quota discipline is why this feature is affordable.

So the cost moves from Realtime messages to battery. Keep
`enableHighAccuracy: false`; it is the difference between a phone lasting a
shift and not.

### 2. Load today's stops

For the signed-in crew member: today's `lawn_visits` where `crew_id` = them and
`status = 'pending'`, joined to `lawn_jobs.map_lat/map_lng` for the pin. Map each
to `GeoStop { id: visit.id, lat, lng }`. Skip visits with no pin — they simply
never auto-stamp and fall back to the manual buttons.

Load once when the shift starts and refresh sparingly. **Do not poll.**

### 3. Act on events through the EXISTING routes

Do not write to `lawn_visits` directly. Both routes are already
server-authoritative and carry rules you must not bypass:

- `arrive` → `POST /api/lawn/visits/{stopId}/start` — idempotent, so a repeat is
  safe.
- `depart` → `POST /api/lawn/visits/{stopId}/status` with `{ status: "done" }` —
  this is what fires the customer `service_complete` / `review_request`
  notifications and the re-entry notice.

**A depart marks a visit DONE and emails a customer.** Treat it with the caution
that deserves: never fire it for a visit already done, and make the call
idempotent from the client's side too.

### 4. Tell the crew what happened

Auto-stamping without feedback feels broken. On My Route, an auto-started visit
should read the same as a manually started one ("On site 12m"), and an
auto-completed one should be visibly done. A crew member must still be able to
override — GPS gets denied and pins are sometimes wrong, and an automatic
timestamp nobody can correct is worse than none.

### 5. Office visibility for unpinned properties

Pin coverage is the feature's ceiling. Current state: Terra Verde Test Co 100%,
Peanutz L&L 40%, two orgs 0%. A property with no pin silently never auto-stamps,
so the office needs to see which ones are missing. A count with a link to the
route planner is enough.

---

## Rules

- `npx tsc --noEmit` exit 0 and `npx eslint <changed files>` clean before commit.
- `react-hooks/set-state-in-effect` is enforced — derive state, never setState in
  an effect body.
- **No polling, no `useEffect` fetch loops.** This app had 10s page loads from
  exactly that.
- Do not edit `src/lib/geofence.ts`, and do not add migrations — none are needed.
- Stage explicitly, never `git add -A`. `src/lib/turnstile.ts` holds another
  lane's uncommitted work — leave it.
- Branch from `main` as `feat/geofence`, do not push `main`.
- Report what you verified, not that you finished. The state machine has tests;
  the integration does not — say plainly which parts you actually exercised.
