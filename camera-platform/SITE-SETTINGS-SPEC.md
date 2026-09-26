# Site settings and layouts (settings, round 2)

Phase 4, round 2. The owner approved settings on 2026-09-26. Round 1 was the
per-camera AI settings (CAMERA-AI-SETTINGS-SPEC.md).

## 1. Site settings (installer only, `system.manage`; every save audited)

Stored in `<stateDir>/site.json`, written tmp then rename:

```json
{ "version": 1,
  "displayName": "Pflugerville Car Wash" | null,
  "timeZone": "America/Chicago" | null,
  "siteType": "retail" | "storage" | "carwash" | "home" | "other" | null,
  "features": { "activity": true, ... },
  "updatedUtc": "...", "updatedBy": "..." }
```

- **`displayName`:** what people see. The setup-time `siteId` stays the
  machine identifier and never changes here.
- **`timeZone`:** an IANA name, validated with Intl. `null` means the NVR's
  own system zone, and the page says which zone that is.
  - New camera AI schedules are saved in the site zone.
  - Existing schedules keep the zone they were saved in; never shift them
    silently. The page lists any camera whose schedule is in a different
    zone.
  - The Activity page uses the site zone when set, otherwise the browser's.
- **Per-site feature switches.** The owner's decision (memory
  features-are-per-site-options): advanced features are switched on per
  site by the installer, because sites range from storage facilities to
  plain homes.
  - **The feature registry** lives in a pure contract and lists only features
    that exist. It is `activity` today. `managerRules` and `appearanceOfDay`
    join when they are built.
  - **Always on, not switchable:** recording, live, review, health, the
    network page, and camera AI settings.
  - **A switched-off feature:** its nav link is hidden, its routes answer
    404 `feature_off` (never 403, which would read as a permission
    problem), and any engine it has does not run.
- **Site-type presets:** choosing a type pre-selects the switches, and the
  installer can change any of them afterwards. A preset never changes
  switches silently later: it applies once, when chosen.
  - retail: activity on
  - storage: activity on
  - carwash: activity on
  - home: activity off
  - other: activity on
  - Presets name future features too, so they turn on the moment those
    features exist.
- **Blank is not a zero.** A missing `site.json` means displayName null,
  timeZone null (the system zone), siteType null, and every feature at its
  registry default. The file is never rewritten with guessed values.

## 2. Version and license (read-only, installer)

- **Installed version:** the first 12 characters of `<appDir>/VERSION`.
- **When it was installed:** the VERSION file's mtime, labelled "installed
  at".
- **Trusted release keys:** the key ids from the trust anchor (public ids
  only).
- **License:** "No license service configured yet": licensing arrives with
  the cloud (CLOUD-B1-SPEC.md section 4).
- **Anything unreadable** shows its reason, never a blank or a guess.

## 3. Layouts saved per user, and per display

- **Today:** grids are kept in each browser's localStorage, so they are lost
  on a new phone or a cleared browser.
- **Per user:** each signed-in account (`layout.edit`, which store and
  installer hold) keeps named layouts on the NVR in
  `<stateDir>/layouts.json`:
  - a name;
  - a grid shape from contracts/gridLayout.mts;
  - the cell to camera-id list, where `null` means an empty cell;
  - the account's default layout.

  Other accounts' layouts are never visible or editable.
- **Per display:** the installer (`account.manage`) assigns a display (a
  paired wall screen) a layout: a shape plus cameras. The wall shows it on
  load and when it changes (poll 60 s). A display never edits it.
- **Migration:** the first load after this ships offers once to "save this
  browser's current layout to your account". Nothing moves on its own.
- **Removed cameras:** a camera id in a saved layout that no longer exists
  renders as an explicit "camera removed" cell, never a silent blank.

## 4. Where it goes

- **Contracts:**
  - `contracts/siteSettings.ts`: validation, the feature registry, presets
    and defaults;
  - `contracts/savedLayouts.ts`: validation, per-account scoping, and the
    removed-camera cells.
- **Routes** (routeAccess entries for each):
  - `GET/POST /site-settings` (system.manage)
  - `GET /site` (any signed-in role): display name, the effective time zone,
    and which features are on. The pages use it to hide nav links.
  - `GET/POST /layouts` (layout.edit, own account only)
  - `GET/POST /display-layouts` (account.manage)
  - `GET /display-layout` (the display credential, its own layout only)
- **UI**
  - A "Site" section on the System page: name, time zone, type with
    presets, feature switches, version and license.
  - Layout save / load / default on the Live page.
  - Display layout assignment on the Accounts page where displays are
    paired.
  - Every new client has its browser bootstrap AND the load check (bus note
    camera-page-bootstrap-lesson).
- **The Activity feature switch:** when off, /activity and /activity-page
  answer 404 `feature_off`, and the nav link is hidden.

## Tests that matter

- A missing site.json is the defaults, and a bad one is refused with every
  problem listed. An unknown feature key or a bad IANA zone gets 400.
- A preset applies once, and a later preset change never touches switches
  the installer set by hand afterwards.
- Activity off gives 404 `feature_off` on its routes and hides its link.
  Activity on is unchanged.
- The site zone reaches new AI schedules and the Activity page, and an
  existing schedule's zone is never shifted.
- Layouts: an account never reads or writes another account's layouts; a
  display gets only its own; a removed camera renders as "camera removed".
- Permissions:
  - store gets 403 on /site-settings;
  - a display gets 403 on everything except /display-layout and the live
    routes it already has.
- No credential or URL anywhere, in the files, JSON, audit, or pages.
- The bootstrap checks.
