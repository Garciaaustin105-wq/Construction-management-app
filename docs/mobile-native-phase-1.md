# Mobile native — Phase 1

**Shipping to the App Store and Google Play. Research and scope.**
**Written 2026-09-01 by Claude Opus 5. Code audit + external research.**
**Status: research complete, nothing built. Do not start without §7 and §8.**

---

## Phase 1 scope, in one line

**A single native shell: crew screens bundled natively for background GPS and the
camera; every office screen loaded from the hosted web inside the same app.**

One icon, one login. Native only where the web platform physically cannot go. No
port of the office surfaces — that is the expensive half and it buys nothing.

## Verdict

**Go native for the CREW app only. Leave the office on the web.**

The reason is not distribution or credibility — it is that **a core feature we have
already built four phases of cannot work as a web app.** Store presence is a side
effect, not the goal.

The code audit came back far better than expected: **every crew surface is already a
client component**, so the architecture Capacitor needs mostly exists. The real work
is a build-scoping problem and three files of API swaps, not a rewrite.

The real cost is not engineering. It is **permanent release friction** — Google
manually reviews every background-location submission for 3–5 days — and the fact
that **iOS users can silently downgrade the permission** that the whole measurement
programme depends on.

---

## 1. Why native — the load-bearing reason

Crew location comes from `navigator.geolocation.watchPosition`
(`src/lib/useCrewLocationBroadcast.ts:267`). There is no wake lock, no service-worker
fallback, no `visibilitychange` handling.

**That is a foreground-only browser API.** iOS Safari suspends JavaScript the moment
the phone locks or the app backgrounds; Android throttles it heavily.

So the real-world sequence — crew arrives, locks the phone, pockets it, mows for
forty minutes — records **nothing**. No arrival, no dwell, no on-site window.

That silently disables:

- the geofence arrive/depart detection (90s / 180s dwell),
- on-site measurement,
- the man-hours pricing model that consumes it,
- the settlement gates built on top.

It is very likely a large part of why there are **zero real measurements** after
four phases of work. A PWA cannot fix this on iOS at any price. This is the argument
for native, and it stands on its own without any reference to the stores.

## 2. Code audit — what actually has to change

Native-plugin swaps needed. **Three files:**

| File | Browser API | Capacitor replacement |
|---|---|---|
| `src/lib/useCrewLocationBroadcast.ts` | `navigator.geolocation.watchPosition` | background geolocation plugin |
| `src/lib/geo.ts` | `navigator.geolocation.getCurrentPosition` | `@capacitor/geolocation` |
| `src/components/FieldCamera.tsx` | `getUserMedia` / `mediaDevices` | `@capacitor/camera` |

**Already fine, no work:** `localStorage` and IndexedDB work in a WebView.
Supabase's browser client works unchanged.

**Already a PWA:** `src/app/manifest.ts` and `public/sw.js` exist, so
install-to-home-screen is done today. A store listing adds no capability over it —
only native plugins do.

**Entirely new work:** push. There is **no** Web Notification API usage and no push
subscription anywhere — all 27 "Notification" references are our own in-app feed
(the `notifications` table), not the browser API. Push would be built from scratch,
and it matters because it is one of the native features that defends against Apple's
4.2 rejection.

**The good news — every crew surface is already client-rendered:**

```
crew/daily-log  crew/photo  crew/punch  crew/rfi  crew/time     → "use client"
lawn/my-route   lawn/visits/[id]                                 → "use client"
```

They already fetch via the Supabase browser client. No SSR to unwind, no server
components to port. This is the single biggest cost saving in the whole exercise and
it was already true before we started.

## 3. The real architectural work

Capacitor ships **static assets into a WebView. There is no server at runtime.** Our
office surfaces are heavily server-rendered — `export const dynamic = "force-dynamic"`,
`getMe()`, RLS-scoped server queries — and none of that can run inside Capacitor.

`next build` with `output: "export"` is **all-or-nothing for the app**, so we cannot
statically export `/crew/*` while keeping `/lawn/*` server-rendered in the same
build. That is the actual engineering problem, and the options are:

1. **A separate crew-only build** — a second Next config/entry that includes only the
   crew routes and shared components. Cleanest; keeps the office app untouched.
2. **Capacitor remote-URL loading** — point the shell at the hosted Vercel app.
   Simplest, and **the pattern Apple rejects** (see §6). Avoid for a store build;
   fine for development live-reload.
3. Hybrid bundling. Messy; not recommended.

Option 1 is the one to cost out.

## 4. The solo operator — one shell, two rendering strategies

A solo operator IS both crew and office: they mow the lawn and they send the
invoice, both from a phone. Splitting that across a native crew app and a separate
mobile website would be the wrong product for the customer we most expect.

**It does not have to be split, and the mobile half is largely already built.**

`buildMobileNavBase` already carries office surfaces per role — `/estimates`,
`/admin/customers`, `/admin/reports`, `/lawn/insights`, `/daily-logs`, `/punch` —
and 74 of 281 components use responsive breakpoints. Combined with the existing PWA
manifest, an operator can already run the office side from a phone today.

So Phase 1 is **one app with two rendering strategies inside it**:

| Surface | How it runs | Why |
|---|---|---|
| Clock in/out, photos, route, visit detail | **bundled native** | needs background GPS + native camera |
| Estimates, invoices, customers, compliance, insights | **hosted web in the shell** | needs neither; already mobile-navigable |

**Cost of the office half: close to zero.** It is loading pages we already serve and
have already made mobile-navigable. The expensive path would be porting those server
components to client-side fetching so they could be bundled — and nothing on the
office side needs a native capability, so that spend buys nothing.

**Two honest tradeoffs.** Office screens inside the shell will not work offline and
will feel like web pages, because they are — acceptable for invoicing, which nobody
does from a field with no signal. And keeping them web-served is also a *feature*:
those fixes still ship in minutes through Vercel instead of waiting on the 3–5 day
Android review (§5).

This also does not weaken the Apple position. 4.2 rejects apps that are *only* a
webview; the crew half here is genuinely native.

## 5. Google Play — the strictest gate

`ACCESS_BACKGROUND_LOCATION` requires a **separate declaration and enhanced review**.

- **3–5 day manual review on every submission**, regardless of track record.
- Background location must be **core functionality** — "a set of important features
  without which your app is broken or rendered unusable." Crew time-tracking and
  geofenced visit measurement qualifies squarely.
- The core feature "must be prominently documented and promoted in the app's
  description" — so the store listing has to lead with the tracking feature, not
  bury it.
- **New in 2026:** even `ACCESS_FINE_LOCATION` now needs a declaration justifying why
  the location button or coarse location is insufficient.

**Operational consequence, and it is the big one:** a hotfix currently ships in
minutes through Vercel. On Android it would take **3–5 days** to reach crews. That
argues for keeping the native shell as thin as possible and as much logic as possible
served from the web, so most fixes never require a store release.

## 6. Apple — guideline 4.2 and the permission problem

**4.2 Minimum Functionality.** Apple rejects apps "not sufficiently different from a
mobile web browsing experience." Reviewers look for: browser-like chrome, no native
navigation, non-persistent logins, a white screen with no network, and **no platform
features such as push notifications or location services**.

We would pass on substance — background location, native camera, push are real
native integrations. But this is precisely why **remote-URL loading (§3 option 2) is
the wrong choice for a store build**: it produces exactly the "lazy wrapper" profile
reviewers are trained to spot.

**The harder Apple problem is the permission itself.** Background location on iOS
requires "Always Allow." Users are first offered "While Using the App," iOS
periodically re-prompts and invites them to downgrade, and many will. When a crew
member picks "While Using," background tracking stops and **we are back to the exact
failure this whole project is meant to fix — silently.**

**This must be designed for, not assumed away:** detect the permission level, tell
the crew plainly that measurement is off, and fall back to the tap-based
start/done times we already record. A measurement that silently stops is worse than
one that announces it stopped.

## 7. Cost

| Item | Cost |
|---|---|
| Apple Developer Program | $99/year |
| Google Play registration | $25 one-time |
| Engineering | Capacitor shell + build scoping; 3 files of API swaps; push from scratch |
| Ongoing | 3–5 day Android review per release; two store listings; signing keys; release management |

## 8. Open questions before committing

1. **Which background-geolocation plugin?** The free `@capacitor/geolocation` is
   foreground-oriented; robust background tracking generally means a paid plugin
   (e.g. Transistor's). Licence cost not researched here — **get this number before
   committing**, it is the one unpriced line item.
2. **Does the office ever need the app?** If office users expect to log in on the
   phone app, a crew-only bundle will confuse them. Worth deciding before the store
   listing is written.
3. **Android-only first?** $25 versus $99, no 4.2 equivalent, and it would prove the
   background-location approach works before paying Apple's tax in both money and
   review friction.
4. **Does the geofence design survive a permission downgrade?** See §5. This is a
   product decision, not an engineering one.
5. Sources below are secondary (developer blogs, policy summaries). Confirm the
   current declaration flow in Play Console and App Store Connect directly before
   building to them.

## Sources

- Google Play, background location permissions — https://support.google.com/googleplay/android-developer/answer/9799150
- Google Play, foreground location and the location button — https://support.google.com/googleplay/android-developer/answer/17033915
- Android developers, access location in the background — https://developer.android.com/develop/sensors-and-location/location/background
- App Store review guidelines and webview wrappers — https://www.mobiloud.com/blog/app-store-review-guidelines-webview-wrapper
- Next.js static exports — https://nextjs.org/docs/app/guides/static-exports
- Next.js + Capacitor — https://capgo.app/blog/building-a-native-mobile-app-with-nextjs-and-capacitor/
