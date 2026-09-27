# Site Settings and Layouts

## 1. Site settings

Installer accounts only. A store account won't see this section at all.

### Get there
1. Navigate to the "System" page.
2. Scroll down to the "Site" section (there's nothing to click open — it's part of the page).

### Display name
3. Type a name in the "Display name" field. This is just what people see; it doesn't change the site's underlying ID.

### Time zone
4. Type the time zone in the "Time zone" field. It suggests names as you type; it is not a dropdown.
5. Leave it blank to use the recorder's own system zone — the page tells you which zone that is.
6. New camera AI schedules use whichever zone the site is set to. Existing camera schedules keep the zone they were originally saved in and are never shifted automatically. Any camera whose saved schedule is in a different zone than the site's shows up under "Cameras in another time zone."

### Site type
7. Choose a site type: Retail, Storage, Car wash, Home, or Other.
8. Choosing a type pre-selects that type's feature switches, once, the moment you choose it. Watch out afterward: if you later change the site type again to a *different* type, that save replaces the feature switches with the new type's preset — any switch you set by hand is overwritten. A hand-set switch only stays put for as long as the site type itself does not change again; re-saving with the same site type, or saving other fields, never touches the switches.

### Features
9. The Features list shows every switch this build has, using the exact names the page shows: "Activity", "Manager rules", and "Appearance of the day (no face)". Activity gates the Activity page. Manager rules gates the Rules, Reports and Alerts pages and the manager-tracking routes underneath them (area management included). Appearance of the day controls only whether the recorder computes and sends today's clothing signature — clothing color and shape, never a face. Each day it is learned once from whoever spends the longest time at the manager's desk, then matched against every person detected on any camera all day, not just at the desk. It has no page of its own to hide. Recording, live, review, health, the network page, and camera AI settings are always on; they are never listed here, on or off.
10. Below the switches, a "Match threshold (%)" field sets how close a clothing match has to be to count, from 50 to 99, default 80. It stays visible whether or not Appearance of the day is switched on. Under it the page states its own limits, in these words: "Clothing-colour matching is weak across cameras with very different lighting, and useless under uniforms. It is uncalibrated until you record test walks."
11. Turning Activity off hides its nav link; opening its page directly answers 404 with the message "the activity feature is off for this site". Turning Manager rules off hides the Rules, Reports and Alerts links the same way, and opening any of those pages, or the routes underneath them, directly answers 404 with the message "the manager rules feature is off for this site". Neither is ever a permission error — the recorder answers 404, not 403.

### Save
12. Click "Save." Every save is written to the audit log.
13. If that save changed the site type, the page shows once, right after saving, which switches the preset turned on or off.

## 2. Version and license

Read-only, same "Site" section.

- Installed version and its install date (labeled "installed at") are shown.
- Trusted release key IDs are listed.
- License shows "No license service configured yet" — licensing arrives later, with the cloud.
- Anything the recorder can't read shows the reason, never a blank.

## 3. Layouts

### Save your own layout (Live page)
Any signed-in account (store or installer) can do this — it's private to that account.

1. On the Live page, arrange the camera grid the way you want it.
2. Click "Layouts" to open the panel.
3. Type a name into the "Layout name" field.
4. Click "Save current grid as…".
5. Saved layouts appear in the list, each with "Load," "Set default" (shown as "Default" once it is one), and "Delete."
6. You can only see and edit your own saved layouts — never another account's.
7. The first time you open this after upgrading, if your browser already has an unsaved grid, you're offered once to save it to your account. Nothing moves unless you click yes.

### Assign a display's layout (Accounts page)
Installer accounts only.

1. Navigate to the "Accounts" page.
2. Find the display in the "Wall displays" list.
3. Click that display's "Layout" button.
4. Choose a grid shape, then assign a camera to each cell.
5. Click "Save layout."
6. The paired screen picks up the change on its own within about 60 seconds; a display never edits its own layout.
7. If a camera in an assigned layout is later removed, that cell shows "Camera removed" instead of turning blank.
