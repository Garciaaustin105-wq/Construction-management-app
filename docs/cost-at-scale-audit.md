# Cost at scale — what breaks when customers arrive

**Written 2026-09-04 by Claude Opus 5. Audit, nothing changed.**
**Context: 1 real customer today. Everything here is architecture, not usage data.**

---

## The only question that matters

For each thing that costs money: **what does it scale with?**

| Scales with | Meaning | Risk |
|---|---|---|
| **per org** | one charge per customer you sign | benign — revenue scales with it |
| **per user** | grows inside an org at no extra revenue | watch it |
| **per visit** | grows with how much work they do | **dangerous** — a busy customer costs more and pays the same |
| **per page view** | grows with how much they *use* the product | **dangerous** — punishes engagement |

Flat per-org pricing means anything scaling per-visit or per-page-view is a
margin leak that widens with your best customers. That is the lens for
everything below.

## 1. Vercel Active CPU — the biggest one, and the least visible

Active CPU is already the binding resource on the Vercel plan (75% of usage
versus 4% memory, measured 2026-08-31), and it **scales per page view**. A crew
member checking their route ten times a day is ten server renders. Multiply by
crew, by org.

### Correction: `force-dynamic` is NOT the lever

An earlier draft of this section said to audit the 30 pages carrying
`export const dynamic = "force-dynamic"` and relax the ones that do not need
per-request freshness. **That was wrong, and checking it took two minutes.**

`src/lib/supabase/server.ts` calls `cookies()` from `next/headers`. In the App
Router, reading cookies opts a route into dynamic rendering **automatically**.
Every authenticated page is therefore dynamic whether or not the directive is
present — removing it would change nothing at all. And these pages could not be
statically cached anyway: they render org-scoped data under RLS, so a shared
cache entry would be a tenant-leak, not just a staleness bug.

### The actual levers

**a. Move the work off the server.** A page that renders as a thin shell and
fetches from the client costs Vercel almost nothing — the query goes browser →
Supabase and never touches a Vercel function. **This codebase already does it**:
every crew surface (`crew/time`, `crew/photo`, `lawn/my-route`,
`lawn/visits/[id]`) is a client component using the Supabase browser client,
which is exactly why the estimator workspace could be built without a server
render per view. The pattern is proven here; it is a question of which
high-traffic pages get converted.

**b. Reduce work per render.** For pages that stay server-rendered, the cost is
the number and expense of queries plus serialisation. `lawn/completed` fetching
200 visits and then their photos in one extra query is the right shape;
anything doing per-row lookups is not.

**c. Target by traffic, not by count.** Thirty pages is not the number that
matters. The pages a crew or an office opens dozens of times a day are, and most
of those thirty (`admin/billing`, `lawn/products`, `signup`, the `[token]`
pages) are opened rarely. Optimising a page nobody loads buys nothing.

**One page worth a look for a different reason:** `templates` has no auth read,
so unlike the rest it is *not* dynamic by necessity — there the directive is
doing real work, and it is worth knowing whether that is deliberate.

## 2. Static Maps in customer emails — billed per open, not per send

`buildStaticMapUrl` embeds a Google Static Maps image in customer emails from
three places: the morning-of visit reminder (`lawn/cron/remind`), "on my way",
and the completion notice.

The URL is fetched **by the recipient's mail client**, so the charge lands when
the customer *opens* the email — and again on every re-open that misses a cache.
One send is not one request; it is an unknown number, driven by customer
behaviour you do not control.

**Scales per visit, then multiplied by opens.** At one org it is invisible. At
500 orgs × daily visit reminders it is a line item.

Mitigations, cheapest first: render the map once and store the image, so repeat
opens hit your storage rather than Google; or drop the map from the routine
daily reminder and keep it for "on my way", where it actually helps.

## 3. Supabase image transformations — per thumbnail, per photo

`signedThumbnail` requests a transformed image (width + quality) for photo grids.
Supabase bills image transformations on **origin images processed**. Crews upload
photos constantly and galleries render many at once.

**Scales per photo per view.** Also note `job-photos` is a private bucket, so
every thumbnail needs a signed URL minted on demand — 22 `createSignedUrl` call
sites.

Worth checking whether transformed variants are cached or re-requested per
render, and whether a stored thumbnail at upload time would be cheaper than
transforming on read.

## 4. Storage — the one your pricing already caps

`maxStorageBytes` is 1 GB free → 75 GB on both Pro and Business. Photos are the
driver and they never shrink. This is the one cost your plan limits already
control, which is why it is fourth rather than first.

Two notes: Pro and Business are **both 75 GB**, so the top tier buys no headroom
(flagged in the pricing proposal). And nothing in the app deletes old photos —
storage is monotonic, so a three-year customer costs strictly more than a
one-year customer at the same price.

## 5. Realtime crew tracking — already well designed

Broadcast every 30s (ephemeral, no rows, no Vercel invocation), a breadcrumb
insert every 5 minutes, and the whole thing presence-gated so it only runs when
someone is watching. That is a deliberately cheap design and the comments show it
was thought about.

**Scales per crew per hour worked.** Supabase bills Realtime on concurrent peak
connections and messages. Watch the concurrent-connection ceiling more than the
message count: it is a plan limit, and it is reached by crews *starting shifts at
the same time*, which is exactly what crews do.

## 6. AI — measured and fine

`claude-haiku-4-5` for the email draft and visit summary, quota-gated per plan
(0 / 0 / 25 / 100 / 5000 per month). A fully-consuming Business org runs roughly
$20–25/month against $199. Around 11% of that tier. **Leave it alone** — it is
the one metered feature already priced correctly.

## 7. SMS — highest unit cost, lowest volume

Per message, and the most expensive thing here per unit. Opt-in gated, so volume
is bounded by customer consent rather than by your usage. Worth a per-org cap
before it can surprise anyone.

## 8. Google Distance Matrix — fixed today

Route optimization: 10 calls ever, 9 from the sandbox. Not a risk at present.
Caps are still worth adding **precisely because there is no usage history to
forecast from** — an uncapped metered API is a bet that future customers behave
like the only one you have.

## What I would actually do, in order

1. **Find which pages are actually loaded most, then move those to
   client-fetching** (§1a). Not the `force-dynamic` list — that directive is
   redundant on authenticated pages. Vercel's analytics gives the traffic
   ranking; optimise the top few and ignore the rest. The crew pages already
   prove the pattern works here.
2. **Decide about the map image in the daily reminder.** Per-visit cost
   multiplied by an open rate you do not control.
3. **Check whether thumbnails are transformed on every render.** If so, store
   them at upload instead.
4. **Add the metered caps** — route optimization, SMS — before scale, not after.
5. **Give Business real storage headroom over Pro**, or stop selling it as
   headroom.

## What NOT to do

**Do not optimise on guesses.** Twice today a cost scare evaporated on contact
with data: Distance Matrix was 10 calls ever, and the "expensive" line on the
Google bill turned out to be a Kubernetes cluster unrelated to this app. Before
engineering around any item here, get its actual number from the provider's
console broken out by SKU.

The exception is item 1 — Active CPU is already known to be the binding resource
from real usage, not inference.
