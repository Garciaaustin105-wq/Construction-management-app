# Setting up a camera's AI

For each camera you can set four things: **zones** (where to watch, where to ignore), the **schedule** (when the AI watches), **sensitivity** (the camera's minimum confidence), and **kinds** (person, vehicle). Zone and kind settings never delete a detection — they hide it (see step 19). Schedule and sensitivity work differently: outside the schedule, or below the threshold, nothing is stored at all.

## Open it

1. Click **Cameras** in the top navigation — it appears on the Recording, Accounts and Network pages — or go to `/cameras-page`.
2. In the **AI settings** section, click a camera's own row — shown as its name (or its camera ID, if it has none), followed by "— AI settings" — to expand that camera's panel.

## Zones

3. The panel loads a recent still of the camera's picture (needs the `playback.view` permission, which an installer has). If no still has been captured yet, the panel says so; wait for one before drawing zones.
4. Choose **Watch** or **Ignore** from the **Draw a** dropdown, then click **Start zone**. Tap the still to add points — 3 to 32 of them — then click **Close zone** to save the shape, or **Cancel** to discard it. A camera can have at most 8 zones. Shapes can be concave.
5. Each zone has its own **Delete** button. The editor works with mouse and touch. Zones are drawn with a **Watch** / **Ignore (hatched)** legend, so colour is never the only clue.
6. How each detection is judged. Its position is the bottom-centre of its best box — where a person or vehicle meets the ground.
   - Inside an Ignore zone: hidden.
   - Otherwise, if Watch zones exist and it is inside none of them: hidden.
   - Otherwise it counts.
   - A point exactly on a zone edge counts as inside.
7. No zones set means the whole frame is watched.

## Schedule

8. Choose **Always** or **Per weekday**; for each day you switch on, set a from and to time.
9. Custom schedules carry a time zone. A brand-new schedule takes the site's own time zone, if the installer has set one in the Site section of the System page; otherwise it takes the recorder's own system zone. A schedule that was already saved keeps whichever zone it was saved under, even if the site zone changes later. The panel does not currently show which zone is in effect.
10. Outside the schedule the AI is **not watching**. Frames for that camera are ignored and not stored. The health information shows the camera as not watching, and the Activity page shows "not watching" — never "0 sightings".
11. CPU use does not change yet. Stopping the worker outside the schedule is coming later.
12. No schedule set means the AI watches always.

## Sensitivity

13. Choose **Site default (0.50)** or **Custom** and pick a value from 0.30 to 0.90, in steps of 0.05.
14. You cannot set it below the site's storing floor (`detect.json`'s `minConfidence`); the validator refuses that. Detections below the camera's own minimum are not stored as events at all — the same meaning the site storing floor already has.

## Kinds

15. Tick **Person** and/or **Vehicle**. A camera whose AI settings have never been saved detects both by default. But this panel always saves exactly what is ticked: if you save with both boxes off, every person and vehicle detection on this camera is hidden instead of shown (plate reading is a separate, NVR-wide setting and is not affected) — it does not fall back to "both on" the way an untouched camera does.

## Save

16. Press **Save**. Each section shows its own errors if something is wrong.
17. Settings apply to new detections from the moment they are saved. Earlier events are not re-judged. The form states this.
18. Every save is audited: which account, which camera, and which fields changed. Never a URL, never a credential.

## Hiding, not deleting

19. A detection outside your zones, or of a kind you switched off, is still stored as an event but hidden. It is marked `suppressed_by = "settings:zone"` or `"settings:kind"`.
20. Review's "Show hidden" button still finds these events, and the Activity page's table view counts them under "hidden".
21. Known-object hiding does not override these marks. Known-objects learning ignores settings-hidden events, and known objects can neither overwrite nor clear a `settings:` mark.

## Good to know

- A blank is not a zero, for a camera whose AI settings have never been saved: no zones means the whole frame is watched, no schedule means always, and no kinds chosen means both are on. Saving this panel always writes every field explicitly, though — including kinds — so a deliberate save can hide every detection of a kind in a way an untouched camera never would, without deleting anything.
- Settings are stored on the box in `camera-ai.json`.
- The box re-reads the settings every 30 seconds. A bad file is logged and the last good settings are kept; if there never was a good file, the defaults apply. Nothing crashes.
- If the site's storing floor cannot be read, Save is disabled and the panel explains why.
- Viewing and saving these settings need the `camera.manage` permission. Store, manager and display accounts are refused.

## Coming later (not in this round)

- Stopping workers outside the schedule (CPU saving).
- Motion-gate sensitivity per camera.
- Plate reading per camera.
- Line crossing and loitering.
