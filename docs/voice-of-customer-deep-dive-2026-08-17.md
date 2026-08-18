# Voice-of-Customer Deep-Dive — Competitor Complaints + User Wishes (Aug 2026)

## Executive Summary
Mining Reddit, Capterra, G2, TrustRadius, BBB, ContractorTalk, LawnSite, the Jobber Community, and App Store reviews surfaces five cross-cutting pain points — and four of them we **already counter**, while the fifth is a cheap, high-value build that sharpens our lawn roadmap:

1. **Pricing/billing trust is the #1 pain** — renewal hikes (Buildertrend +50–122%), billing-after-cancellation, contract lock-in, opaque pricing (Buildertrend, Housecall Pro, RealGreen). We counter with published, stable pricing + month-to-month + easy cancel + no lock-in.
2. **Accounting sync reliability** — Foreman's QB sync needs manual re-sync (and they sunset Desktop Jan 1 2026), Jobber is QB-Enterprise-incompatible, Fieldwire has no native QB, RealGreen has rounding/failed syncs, JobTread is QBO-only. We counter with 3-provider sync (QBO + Xero + FreshBooks) — "a sync that actually works."
3. **Reporting depth** — JobTrend's reporting is "the weakest part"; Fieldwire + PlanRadar are "light." We counter with the in-app Insights dashboard we already shipped.
4. **Field adoption** — "complexity kills adoption"; small subs won't use apps for billing/submittals. We counter with `crew_members` scheduling-only (no app-login burden).
5. **Lawn seasonal/bulk tools** (the one to BUILD) — Jobber users beg for seasonal pause/restart, skip-visit, bulk scheduling, text-photos-to-client, better routing. We already have recurring schedules + visits + Today's Route + customer notifications — these are direct extensions, not new platform.

> **Scope:** construction and lawn kept in separate sections (different rival sets). Quotes are verbatim where listed; sources are real (Reddit, Capterra, G2, TrustRadius, BBB, ContractorTalk, LawnSite, Jobber Community, App Store).

---

## Construction

### Buildertrend
**Complaints** (ContractorTalk, BBB, TrustRadius, G2/Capterra):
- Renewal hikes: one user **+65%** with no added value; a BBB reviewer **+122%** ($299→$699/mo); TrustRadius cites pricing "north of $900/mo"; 50–75% renewal increases documented across G2/Capterra.
- Pricing is **demo-gated / not published** — frustrating vs rivals that publish.
- Billing/cancellation friction (ContractorTalk "Buildertrend Warning"): **continued billing after cancellation** (charged months after a December cancel), single account rep unhelpful, support business-hours only, alleged "exit interview" requirement.
- **BBB rating 1.08/5** (12 reviews): "They will NOT refund your money," "used car salesman experience" demos, unauthorized charges after cancellation, refusal to honor cancellations within days of signup.
- Data lock-in: "extremely difficult to get years of data out," no bulk export.
- Essential plan ($339) **lacks estimating** → "effectively unusable" for contractors who must send proposals.
- Mobile: crashes requiring reinstall, limited offline.
- Integration gaps: no native CompanyCam, Xactimate, EagleView/Hover/aerial, DocuSign, JobNimbus/AccuLynx/Jobber/GoHighLevel.
- Job costing "difficult to navigate," lags QuickBooks/Xero.
- No AI chatbot/copilot, AI estimating, or AI photo analysis.
- Who loves it: custom-home builders on the **Selections** module. Who hates it: smaller contractors, specialty trades, those needing integrations + transparent pricing. (Capterra 4.5/5, 2,483 reviews — polarized.)

**Wishes:** transparent published pricing; easy cancellation; data export; estimating not gated to a $499+ tier; reliable QB sync; mobile reliability; AI features.

### JobTread
**Complaints** (Reddit, Software Advice, GetApp):
- 2026 pricing change from $99 flat to **$199/mo base + $20/user** "pricing out small crews": 5-person team ~$279/mo, 10-person ~$379/mo.
- **No free trial** — only 30-day money-back guarantee (upfront commitment required).
- 3% card-processing fee on client payments erodes margins on larger jobs.
- Reporting is **"the weakest part"** — no custom dashboards, no data visualization; answering a business question needs multiple reports.
- Mobile app is a **"companion tool, not a full experience"**; on-site estimate editing limited.
- Catalog ↔ cost-group disconnect: updating a cost item in the Catalog **does not auto-update cost groups** — manual re-update each group.
- Document customization **near zero**: can't change logo sizes/fonts/formatting; **no message signatures or message templates** (users copy-paste premade messages).
- Estimating friction: can't simply hide an item or turn it into an option — must create multiple groups.
- Steep learning curve (cost types, margin settings, selection logic); one team took **"a good month."**
- Not ideal for multifamily/complex bids; designed for cost-plus/T&M, not fixed-price; design-build hits selection-approval limits.
- Gusto two-way sync missing (users want hours to sync without each employee as a paid user).
- **Praise:** support NPS 9.2 / 5.0 on Software Advice, team "actually listening," built-in accounting removes separate QB, customizable estimating templates.

**Wishes:** flat-rate pricing return; custom dashboards/visualization; document customization (fonts, logos, signatures, message templates); catalog↔cost-group auto-update; full mobile estimate editing; free trial; Gusto two-way sync.

### Contractor Foreman
**Complaints** (Capterra 4.5/5 831 rev, G2 4.5/5 360, TrustRadius 9.2/10, SelectHub, The Digital Project Manager):
- **Performance lag on large estimates**: "software slows down a lot" on very large estimates; "starts to glitch after too many items"; SelectHub — 95% of citing users noted large-dataset slowdowns.
- **Shallow cost-item database**: "missing tons of everyday items"; users build their own pricebook.
- **Limited customization**: "unable to customize the system in any way; changes must come from a vote of many users"; no custom layout/view; PDF limits (can't rename change-order number titles, can't input >2 decimal points).
- Scheduling confusion: two separate interfaces (task vs crew scheduling); "awkward for specialty trades."
- **No true offline mode** (offline time cards in preview Q1 2026; daily logs/photos/files still need internet); slow photo uploads, crashes, "site login issues."
- **QuickBooks integration problems**: SelectHub — "all users who reviewed this con said it's difficult to integrate with QuickBooks"; sync failures need manual re-sync; **QuickBooks Desktop sunset Jan 1 2026** (forced QBO migration); no native Xero/Sage yet (Xero in dev).
- **No true month-to-month billing** (annual or quarterly only; quarterly ~25% more than annual).
- Narrow AI: "bolt-on, not built-in" — only Clark Bot + Kreo (external 2D takeoff via CSV); no AI estimating, damage detection, copilot, or generative proposals.
- Limited native integrations (Zapier-dependent) beyond QB Online, Gusto, Stripe, CompanyCam, Kreo.
- Dated UI; "back button doesn't take you to the last page but to the module"; to-do lists not inside projects; settings hard to navigate.
- **Customer support drop-off after purchase**: "flooded with emails offering support during your trial, which is very misleading"; slower responses on lower tiers.
- Not for specialty trades (no Xactimate/ESX/insurance-supplement) nor service-trade dispatch; not enterprise (no SSO/SAML, SLAs, multi-subsidiary, BIM).
- **Praise:** price + module breadth at $49–332 flat, unlimited users.

**Wishes:** reliable QB sync (without Desktop sunset pain); monthly billing; performance on large estimates; deeper customization + PDF control; offline mode; native integrations beyond Zapier; AI-native features.

### Fieldwire
**Complaints** (Capterra, SelectHub, Contractor ToolStack):
- Integration ecosystem materially smaller than Procore's — **no native QuickBooks Online, Sage, Vista, Spectrum, CompanyCam, EagleView, or Zapier**.
- **RFIs, submittals, change orders, budget management gated to Business Plus ($89/user/mo)** — big jump from the $39 Pro tier.
- Advanced features limited for complex commercial; customization behind Procore.
- **Sync lag with large drawing files / poor cell signal**; drawing revisions slow to re-upload.
- No FSM dispatch (not for service-trade calls).
- Limited BIM/Revit/Navisworks integration.
- Owner/client portal is institutional-developer-focused — **no Selections, no AIA progress billing w/ retainage**.
- Forms/reports lack deep customization; **mobile trails web**.

**Wishes:** native accounting integrations; feature parity without tier jumps; sync robustness; residential client portal + AIA/retainage; deeper form/report customization.

### PlanRadar
**Complaints** (user reviews, SelectHub):
- Filters/search can hide tickets; mobile fields too small; phone↔PC **sync delays**.
- **Photos/annotations can't be edited — must re-upload**; multi-file upload time-consuming.
- Ticket creation repetitive on large projects; plan/user limits by tier; permissions sometimes too rigid.
- **Drawing version control Enterprise-tier only**; steep jump Basic $32 → Starter $107.
- Reporting/analytics **lighter than Procore/PlanGrid**; form customization restrictive; **mobile trails web**; learning curve; worker adoption reluctance; smaller review base.

**Wishes:** drawing versioning at lower tiers; editable photos/annotations; deeper reporting; mobile parity; smoother large-project ticket creation.

### Procore
**Complaints** (Software Advice, App Store):
- **Price/value (most common)**: ACV-based pricing **$15,000–$80,000+/yr** — prohibitive for small/mid firms.
- **SOV (schedule of values) option lacking** — hard to collaborate on who billed what.
- Training cost (wages paid to train) with little support; Xero integration flaws.
- Mobile: photos not uploading / staying grey-blank (re-uploads create duplicates); new left-side menu widely criticized (users want a toggle to revert); drawing-version swipe lag on iPad; observations don't show linked equipment; civil scaling issues; updates "less functional" than before.

**Wishes:** value pricing for small/mid; SOV collaboration; mobile stability + menu revert option; reliable Xero integration.

### Cross-cutting construction themes
1. **Mobile apps consistently lag web/desktop** (all).
2. **Pricing surprises + billing-after-cancellation + opaque/contract lock-in** (BT, Foreman no-monthly).
3. **Sync/upload lag with large files or poor signal** (Fieldwire, PlanRadar, Procore).
4. **Reporting/analytics light** (JobTread, Fieldwire, PlanRadar).
5. **Integration gaps, especially accounting** (Fieldwire no QB; Foreman QB issues + Desktop sunset).
6. **Customization shallow** (Foreman, JobTread docs, PlanRadar forms).
7. **"Vendors make you run your business their way" + bloat** (Procore overkill, BT modules don't work as well, Foreman complexity).
8. **Sub/field adoption is the biggest hurdle** — "complexity kills adoption"; small subs won't use apps for billing/submittals (ContractorTalk).

---

## Lawn / field-service

### Jobber
**Complaints** (LawnSite "What's missing in Jobber?", Jobber Community):
- **Routing is poor**: "The routing feature in Jobber is trash." No real route optimization by job (only customer-level); "almost forces you to have pre-set schedules."
- **No "skip visit" feature** for seasonal work (droughts/off-season) — must manually delete visits (error-prone with hundreds of customers + crews).
- **No seasonal pause/restart**: mowing companies "dread spring reopenings" — must manually re-open hundreds of closed jobs; workarounds = set recurring jobs to span 10 years + delete winter visits, or update dates year-by-year; pay "a hefty annual fee" yet invent workarounds.
- **No bulk processing tools**: "Jobber needs more bulk processing features"; setup/scheduling "very manual."
- **Can't text photos to clients from the app**: "WE NEED THE ABILITY TO TEXT PHOTOS TO CLIENTS IN THE JOBBER APP… it's 2025 for god's sake."
- **Converting estimates to jobs is clunky** — duplicates + scheduling issues; long-term multi-task yearly contracts hard to structure; multi-line plant-healthcare/tree = "an unworkable system."
- Tags "only so reliable"; messy.
- **Weak field-to-office notes flow**: "no great way to enforce good notes from techs in the field"; Job Forms mainly for customer leave-behinds not billing; chemical tracking/reporting not customizable; description-of-work won't flow into reports.
- Random billing glitches: visits from months earlier (already paid) randomly appearing on invoices.
- QuickBooks Enterprise incompatible.
- Installment billing doesn't match contract value cleanly.

**Wishes:** seasonal pause/restart (bulk) button; skip-visit; better route optimization; text-photos-to-client from app; more bulk processing/scheduling; auto-scheduling by employee/sub permissions + location; better multi-line estimate→separately-scheduled-jobs conversion; grayed-out indicators for already-converted tasks; customizable reporting (chemical tracking).

### Housecall Pro
**Complaints** (BBB 75 complaints/3yr, FieldServiceCompare, Reddit/Trustpilot):
- BBB: billing issues / difficulty canceling (charged after cancellation for months, refund delays).
- **Aggressive sales outreach** — repeated unsolicited calls (5+/day) after asked to stop; #1 Reddit/Trustpilot complaint.
- Predatory billing: charges continuing after trial, failed payment retries, users change card numbers to stop.
- Product "too involved and difficult to use"; misled about features.
- Pricing opacity: only Basic ($59) public; Essential (~$149) and Max (custom) need a sales call.
- Overkill for small shops — solo operators 30–40% of features unused; Basic tier "indistinguishable from cheaper alternatives."
- **Android app significantly weaker (2.8 stars vs 4.6 iOS).**
- ~2x the cost of Jobber's entry tier.

**Wishes:** transparent pricing; no aggressive sales; easy cancellation/billing; lighter small-shop tier; Android parity.

### RealGreen / WorkWave
**Complaints** (BBB 18 complaints, SoftwareFinder 3.0/5 60 rev):
- **Software bugs not fixed** for long stretches: linked document images falling off with every update; estimates not sending for 55+ days.
- **Locked into annual contracts**; unable to cancel even when software doesn't work; threatened with collections; auto-renew requires 60-day written notice.
- **Billing after cancellation** — charged for months; some closed bank accounts; one reviewer **"the Comcast of field service software"** after contacting billing 17 times for a refund; one reported a **cease-and-desist threat** just for contacting to cancel.
- Unresponsive support: weeks to email replies; phones unanswered; no support outside narrow East Coast hours.
- High-pressure sales: "offer ends at midnight"; features promised on sales calls that were discontinued/not included.
- QuickBooks sync issues: rounding inconsistencies, failed syncs needing manual fixes.
- Payment processing glitches: portal payments fail → duplicate payments + stuck credits; one **$1,500 overpayment unresolved 4+ months**.
- Per-user costs feel high; reducing user count incurs charges.
- Mobile app **"practically unusable"** per one reviewer.

**Wishes:** software reliability; no contract lock-in; responsive support; reliable QB sync; payment-processing reliability; usable mobile app; honest sales.

### Cross-cutting lawn themes
1. Aggressive sales + billing-after-cancellation (HCP, RealGreen severe).
2. Contract lock-in / hard cancel (RealGreen — 60-day notice, collections, cease-and-desist).
3. Software reliability / bugs unfixed (RealGreen worst).
4. Routing weak + no seasonal/bulk tools (Jobber — the loudest unmet need).
5. Pricing opacity (HCP hidden tiers; RealGreen custom).
6. Mobile app gaps (RealGreen unusable; HCP Android 2.8).
7. Accounting sync issues (Jobber QB Enterprise incompatible; RealGreen QB rounding).

---

## What This Means for Terra Vista

### Complaints we ALREADY counter (sales weapons)
| Complaint | Rivals | How we counter |
|---|---|---|
| Transparent, stable pricing + easy cancel + no lock-in | Buildertrend (50–122% hikes, BBB 1.08/5), RealGreen ("Comcast of field service," 60-day notice + collections), Housecall Pro (BBB 75 complaints, aggressive sales) | Publish pricing; offer month-to-month; honor cancellations; no "exit interview"; no contract lock-in |
| Accounting sync that actually works | Foreman (QB sync manual re-sync + Desktop sunset), Jobber (QB Enterprise incompatible), Fieldwire (no native QB), RealGreen (rounding/failed syncs), JobTread (QBO-only) | 3-provider sync (QBO + Xero + FreshBooks) — "a sync that actually works" |
| Reporting depth | JobTread ("weakest part"), Fieldwire, PlanRadar (light) | In-app Insights + per-job profitability without the accounting provider (shipped) |
| Field adoption | "complexity kills adoption"; subs won't use apps | `crew_members` scheduling-only — no app-login burden on field crew |
| Data lock-in | Buildertrend ("extremely difficult to get years of data out") | Offer data export; make leaving easy (trust signal) |

### Complaints we can cheaply BUILD against (roadmap sharpeners)
| Wish | Rival gap | Our roadmap fit |
|---|---|---|
| Seasonal pause/restart (bulk) | Jobber lacks | Recurring schedules + visits — direct extension (lawn) |
| Skip-visit | Jobber lacks | Direct extension (lawn) |
| Bulk scheduling | Jobber lacks | Direct extension (lawn) |
| Text-photos-to-client from app | Jobber lacks | Direct extension (lawn) |
| Better route optimization | Jobber ("trash") | Today's Route + Google Maps Directions already in — extend optimization (lawn) |
| Multi-line estimate → separately-scheduled jobs | Jobber ("unworkable") | Estimates + scheduling — direct extension (lawn) |
| Document customization (fonts, logos, signatures, message templates) | JobTread near-zero, Foreman limits | Build into Proposals/e-sign (NOW tier) + invoice/estimate templates |
| AI admin (submittal/pay-app/CO summarization, photo analysis, AI client updates) | Foreman "bolt-on," JobTread, BT (no AI) | Flagged AI client updates in growth tier; add AI doc summarization + AI photo analysis |
| Offline mode that works | Foreman (no true offline), Fieldwire/PlanRadar (sync lag) | PWA + Capacitor store-and-forward (ties to store-launch) |
| Customizable dashboards/reporting | JobTread weak reporting | Extend shipped Insights to user-configurable dashboards |
| Reliable field-to-office notes flow | Jobber weak | Enforce structured visit notes that flow to invoicing (lawn) |
| Data export | Buildertrend lock-in | Honest no-lock-in export policy |

### Wishes rivals DON'T satisfy that we can own
- Reliable **multi-provider** sync (most have QB-only or broken).
- **Transparent, stable pricing + easy cancel** (most have hikes/lock-in).
- In-app insights **without** QB.
- **Lawn seasonal/bulk/skip-visit tools** (Jobber lacks).
- **Two variants** (construction + lawn) one platform (no one).
- Honest, no-lock-in **data-export** policy.

### Sales weaponization (one-liners)
- **vs Buildertrend:** "No 65–122% renewal hikes, no 'exit interview' to cancel, published pricing — and estimating isn't locked behind a $499 tier."
- **vs Contractor Foreman:** "A QuickBooks sync that actually works (theirs needs manual re-sync and they just killed Desktop), monthly billing if you want it, and reporting that isn't an afterthought."
- **vs JobTread:** "Flat per-org pricing that doesn't price out your crew at $20/seat, real dashboards, and documents you can actually customize."
- **vs Jobber (lawn):** "Seasonal pause/restart, skip-visit, bulk scheduling, and text-photos-to-client — the things Jobber users have asked for for years."
- **vs RealGreen/Housecall:** "No annual contract lock-in, no billing-after-cancellation, no aggressive sales calls — cancel anytime."

---

## Roadmap sharpeners (concrete additions)
1. **Lawn seasonal/bulk tools** (highest-value, loudest unmet need): seasonal pause/restart (bulk) + skip-visit + bulk scheduling + text-photo-from-app + route optimization + multi-line estimate→separately-scheduled-jobs.
2. **Document customization** (fonts, logos, signatures, message templates) in Proposals/e-sign (NOW tier) + invoice/estimate templates.
3. **AI admin**: AI doc summarization (submittals/pay-apps/COs) + AI photo analysis + AI client updates.
4. **Offline mode**: reliable PWA + Capacitor store-and-forward (ties to store-launch).
5. **Customizable dashboards/reporting**: user-configurable Insights.
6. **Field-to-office notes flow**: structured visit notes → invoicing (lawn).
7. **Data export**: honest no-lock-in export policy (trust signal + counter to BT lock-in).

## Sources
- Buildertrend: [ContractorTalk warning](https://www.contractortalk.com/threads/buildertrend-warning.450111/), [price hike](https://www.contractortalk.com/threads/buildertrend-price-hike.447579/), [BBB reviews](https://www.bbb.org/us/ne/omaha/profile/computer-software/buildertrend-0714-300027310/customer-reviews), [TrustRadius pricing](https://www.trustradius.com/products/buildertrend/pricing)
- JobTread: [EstimatorSuite review](https://estimatorsuite.com/reviews/jobtread/), [Software Advice](https://www.softwareadvice.com/construction/jobtread-profile/), [ContractorTalk](https://www.contractortalk.com/threads/jobtread-anyone-using.463095/), [GetApp reviews](https://www.getapp.com/construction-software/a/jobtread/reviews/)
- Contractor Foreman: [Capterra](https://www.capterra.com.sg/software/166113/contractor-foreman), [Contractor ToolStack](https://contractortoolstack.com/software/contractor-foreman/), [SelectHub](https://www.selecthub.com/p/construction-management-software/contractor-foreman/), [TrustRadius](https://www.trustradius.com/reviews/contractor-foreman-2026-02-03-13-35-36)
- Fieldwire/PlanRadar: [SelectHub comparison](https://www.selecthub.com/construction-management-software/fieldwire-vs-planradar/), [Contractor ToolStack Fieldwire](https://contractortoolstack.com/software/fieldwire/), [PlanRadar reviews](https://www.planradar.com/us/planradar-reviews/)
- Procore: [Software Advice reviews](https://www.softwareadvice.com/construction/procore-profile/reviews/), [App Store](https://apps.apple.com/us/app/procore/id374930542)
- Jobber: [LawnSite "What's missing"](https://www.lawnsite.com/threads/whats-missing-in-jobber.522926/), [Jobber Community 1951](https://community.getjobber.com/discussions/job-details-scheduling/jobber-failing-to-update-features/1951), [Jobber Community 697](https://community.getjobber.com/discussions/insights-reporting/landscapers-lets-unite-on-best-practices-/697), [Jobber Community 2790](https://community.getjobber.com/discussions/job-details-scheduling/managing-year-long-jobs-with-multiple-tasks--recurring-visits/2790)
- Housecall Pro: [BBB complaints](https://www.bbb.org/us/ca/san-diego/profile/marketing-software/housecall-pro-1126-1000067843/complaints), [FieldServiceCompare 2026](https://fieldservicecompare.com/software/housecall-pro/)
- RealGreen/WorkWave: [BBB complaints](https://www.bbb.org/us/nj/holmdel/profile/computer-software/workwave-llc-0221-90155720/complaints), [SoftwareFinder reviews](https://softwarefinder.com/field-service/workwave/reviews)
- Construction wish-list threads: [ContractorTalk "What's annoying"](https://www.contractortalk.com/threads/whats-annoying-taking-up-unnecessary-time-resources-any-software-tools-you-wish-you-had.462739/), [ContractorTalk PM apps](https://www.contractortalk.com/threads/project-management-apps.461791/), [Boom & Bucket forum](https://forums.boomandbucket.com/threads/best-construction-management-software-for-job-site-efficiency.141/)