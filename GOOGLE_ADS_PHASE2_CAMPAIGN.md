# Terra Verde — Google Search Ads Campaign Build (Phase 2)

**Prepared:** 2026-08-27
**Depends on:** [TERRA_VERDE_MARKETING_PLAN_2026-08-23.md](./TERRA_VERDE_MARKETING_PLAN_2026-08-23.md) Section 4, Phase 2
**Status:** Ready to build in Google Ads once Phase 1 exit criteria are met. Do not launch before the prerequisites in Section 0 are done — launching without them wastes spend on traffic you can't measure or convert.

---

## 0. Prerequisites (must be done before launch)

| Item | Status | Why it blocks launch |
|---|---|---|
| Homepage rewritten as a real marketing page with free-tier pitch | **Done** (2026-08-27) — [src/app/page.tsx](./src/app/page.tsx) | Ads need somewhere better than a bare "Sign In" screen to land on |
| `SAAS_OPEN=true` confirmed in production env | **Unverified — check this** | If signup is gated "invitation-only," every ad click hits a dead end |
| Conversion tracking (Google Ads tag + conversion action on signup) | **Not wired** | Without it you're spending blind — no cost-per-signup number, no way to let Smart Bidding optimize later |
| UTM capture on signup (attribute signups to channel/campaign) | **Not wired** | Plan's own Section 7 KPI ("community-sourced signups... via UTM per channel") needs this; also the only way to compare Google Ads cost-per-signup against organic |
| Phase 1 exit criteria met (per plan Section 4) | Tracked separately | Confirms messaging before paying to scale it |

**On tracking:** the app currently has no analytics/tag manager at all (no gtag, GA4, or similar) and the signup form doesn't capture `utm_source`/`utm_campaign`. This is a quick follow-up (Google tag snippet in the root layout + a conversion fire in [SignupForm.tsx](./src/app/signup/SignupForm.tsx) on the success state, plus persisting UTM params from the querystring into the signup payload) — flag if you want that built next, since it should land before spend starts, not after.

---

## 1. Campaign Structure

| Setting | Value |
|---|---|
| Campaign type | Search |
| Networks | **Google Search only** — uncheck Search Partners and Display expansion at launch. Revisit Search Partners after a month of data. |
| Goal | Website traffic → conversion action = signup (see Section 0) |
| Locations | United States, nationwide (software buyer, not a local service search — no reason to geo-restrict like a lawn mowing service would) |
| Language | English |
| Bid strategy (launch) | **Maximize Clicks** with a max CPC cap (~$1.50–2.00), or Manual CPC if you want tighter per-keyword control | 
| Bid strategy (after ~30 tracked signups/month) | Switch to **Maximize Conversions** — needs conversion volume to optimize well, so don't start here |
| Budget | $5–10/day (~$150–300/mo) per the plan's Phase 2 budget |
| Ad rotation | Optimize (let Google favor the better-performing RSA per auction) |
| Devices | No exclusions at launch — a crew owner searching from a truck is a real buyer. Watch mobile conversion rate once data comes in; the landing page is already responsive. |
| Sitelink destinations | `terraverdelawnmanagement.com/#pricing`, `terraverdelawnmanagement.com/#features`, `terraverdelawnmanagement.com/login` (added anchor IDs to the homepage for this) |

---

## 2. Ad Groups & Keywords

Six tightly-scoped ad groups, one per intent cluster from the plan's Section 4 keyword list. Keep ad groups this narrow — a niche B2B search term set burns budget fast on the wrong match type if grouped too broadly.

### Ad Group 1 — Free Lawn Care Software
*Leads with message #1 ("free means free") — this is the highest-intent, cheapest-to-convert cluster.*
- `[free lawn care software]` — exact
- `"free lawn care software"` — phrase
- `"lawn care software free"` — phrase
- `[free lawn care app]` — exact
- `"free lawn care app"` — phrase

### Ad Group 2 — Lawn Care Software (generic)
- `[lawn care software]` — exact
- `"lawn care software"` — phrase
- `"best lawn care software"` — phrase
- `"lawn care management software"` — phrase

### Ad Group 3 — Lawn Care Scheduling
- `[lawn care scheduling app]` — exact
- `"lawn care scheduling software"` — phrase
- `"lawn scheduling app"` — phrase
- `"lawn care scheduling app"` — phrase

### Ad Group 4 — Lawn Care Business App
- `[lawn care business app]` — exact
- `"lawn care business software"` — phrase
- `"app for lawn care business"` — phrase

### Ad Group 5 — Lawn Care Invoicing
- `[lawn care invoicing software]` — exact
- `"lawn care invoicing software"` — phrase
- `"lawn care billing software"` — phrase
- `"invoice software for lawn care"` — phrase

### Ad Group 6 — Route Planning
- `[lawn crew route planning software]` — exact
- `"lawn route planning software"` — phrase
- `"lawn care route optimization"` — phrase
- `"route planning software for lawn care"` — phrase

Start every keyword at exact/phrase only — **no broad match** at launch. This niche has a huge consumer-intent overlap ("lawn care" as a *service*, not software), and broad match is where budget disappears fastest.

---

## 3. Negative Keywords (account-level shared list)

Apply to all ad groups from day one. This list is deliberately aggressive — the plan's own risk section (#4) calls out consumer "hire a lawn service" clicks as the main way this campaign wastes money.

**Consumer service-seeking intent:**
lawn care near me · lawn mowing service · lawn mowing near me · hire lawn care · lawn care company · lawn care services · lawn maintenance company · lawn treatment · lawn fertilization service · weed control service · landscaping company · landscaper near me · lawn care quote · get a quote for lawn care

**Price/DIY/consumer research intent:**
lawn care cost · how much does lawn care cost · lawn care prices · diy lawn care · lawn care tips · best lawn mower · lawn mower for sale · riding lawn mower

**Employment intent:**
lawn care jobs · lawn care careers · lawn care salary · lawn care employee · lawn care resume · lawn care training · lawn care certification

**Business-setup intent (adjacent but not software buyers):**
lawn care franchise · lawn care business insurance · lawn care license · lawn care logo · lawn care business cards · lawn care equipment

Review the Search Terms report weekly for the first month and add negatives aggressively — per the plan, this is the single highest-leverage maintenance task early on.

---

## 4. Ad Copy (Responsive Search Ads)

One RSA per ad group, message #1 ("free means free") leading per the plan's channel guidance. Google allows up to 15 headlines (30 chars) and 4 descriptions (90 chars) — this gives a solid starting set; verify exact character counts in Google Ads Editor before upload since a couple run close to the limit.

### Shared headline pool (use across all ad groups, pin 2–3 per group to keep the free-tier message anchored)
1. Free Lawn Care Software
2. No Credit Card Required
3. Real Free Tier, Not Trial
4. Scheduling, Routing, Billing
5. Start Free in Minutes
6. Built for Lawn Crews
7. Weather-Aware Scheduling
8. Smarter Route Planning
9. No Per-Seat Crew Fees
10. Free Forever Plan
11. Try Terra Verde Free
12. Lawn Software, No Catch
13. Grow Beyond Spreadsheets
14. Route + Schedule + Bill
15. Free Lawn Scheduling App

### Shared description pool (4 minimum per ad)
1. "A genuinely free lawn care software tier. No credit card, no trial countdown, ever."
2. "Schedule visits, optimize routes, and bill customers — free for solo operators and small crews."
3. "No per-seat fees for scheduling-only crew members. Pay only when you actually need to."
4. "Weather-aware scheduling reschedules affected visits automatically. Try it free today."

### Ad-group-specific headline swaps
- **Ad Group 1 (Free Lawn Care Software):** pin "Free Lawn Care Software" + "No Credit Card Required" as top headlines — this ad group's query already says "free," so the ad should mirror it exactly (Quality Score reward for message match).
- **Ad Group 3 (Scheduling):** swap in "Weather-Aware Scheduling" and "Route + Schedule + Bill" as top headlines.
- **Ad Group 5 (Invoicing):** swap in a billing-specific headline — add "Invoicing Built In" (18 chars) and "Bill Customers Free" (19 chars) to the pool for this group.
- **Ad Group 6 (Route Planning):** swap in "Smarter Route Planning" and "Fewer Miles, More Stops" (23 chars) as top headlines.

**Final URL for every ad:** `https://terraverdelawnmanagement.com/?utm_source=google&utm_medium=cpc&utm_campaign=free_signup` (once UTM capture is wired — see Section 0).

---

## 5. Extensions

**Sitelinks** (2–4, all pointing at the new homepage's sections):
- "See Pricing" → `/#pricing`
- "How It Works" → `/#features`
- "Sign In" → `/login`

**Callouts** (no link, ≤25 chars each):
- No Credit Card Required
- Free Forever Tier
- Weather-Aware Scheduling
- Smart Route Optimization
- No Per-Crew-Member Fees

**Structured snippet** — Type: *Features* → Scheduling, Route Optimization, Billing & Invoicing, Weather Rescheduling, Crew Management

---

## 6. Launch Checklist

1. Confirm `SAAS_OPEN=true` in production.
2. Wire conversion tracking (Google tag + conversion action firing on successful signup) and UTM capture on the signup payload.
3. Verify Phase 1 exit criteria are met (plan Section 4): community participation running consistently, at least a couple live blog posts up, rough organic signup rate known as a baseline.
4. Build the campaign in Google Ads using Sections 1–5 above; double-check every headline/description character count in Ads Editor.
5. Set the daily budget to the low end ($5/day) for the first week, watch the Search Terms report daily, then scale toward $10/day once negatives have settled.
6. Weekly: check cost-per-signup (Google Ads conversion data + UTM-tagged signups) against your organic cost-per-signup baseline from Phase 1 — this is the actual go/no-go signal for scaling Phase 2 spend, per the plan's Section 7 reporting cadence.
